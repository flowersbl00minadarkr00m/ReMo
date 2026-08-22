import {
  evaluateBundle,
  type EvaluatedBundle,
  type FinalizationInput,
} from "@remo/domain";
import type { OperationalDiagnosticsReporter } from "../support/operational-jsonl.js";

export interface CaptureRecord extends EvaluatedBundle {
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly durableManifestDigest?: string;
}

export type PromotionResult =
  | { readonly status: "blocked"; readonly integrityState: string }
  | {
      readonly status: "promoted" | "already-promoted";
      readonly savePointId: string;
      readonly manifestDigest: string;
    };

export interface CaptureRepository {
  getByTurn(turnId: string): CaptureRecord | undefined;
  saveCandidate(record: CaptureRecord): CaptureRecord;
  promote(turnId: string): PromotionResult;
}

function cloneRecord(record: CaptureRecord): CaptureRecord {
  return structuredClone(record);
}

export function createInMemoryCaptureRepository(): CaptureRepository {
  const records = new Map<string, CaptureRecord>();

  return {
    getByTurn(turnId) {
      const record = records.get(turnId);
      return record === undefined ? undefined : cloneRecord(record);
    },
    saveCandidate(record) {
      const existing = records.get(record.turnId);
      if (existing?.durableManifestDigest !== undefined) {
        return cloneRecord(existing);
      }
      const stored = cloneRecord(record);
      records.set(record.turnId, stored);
      return cloneRecord(stored);
    },
    promote(turnId) {
      const existing = records.get(turnId);
      if (existing === undefined || !existing.promotionAllowed) {
        return {
          status: "blocked",
          integrityState: existing?.integrity.state ?? "missing",
        };
      }
      if (existing.durableManifestDigest !== undefined) {
        return {
          status: "already-promoted",
          savePointId: existing.savePointId,
          manifestDigest: existing.durableManifestDigest,
        };
      }
      const promoted: CaptureRecord = {
        ...existing,
        durableManifestDigest: existing.manifestDigest,
      };
      records.set(turnId, promoted);
      return {
        status: "promoted",
        savePointId: promoted.savePointId,
        manifestDigest: promoted.manifestDigest,
      };
    },
  };
}

export interface CaptureFinalizationService {
  finalize(input: FinalizationInput): CaptureRecord;
  promote(turnId: string): PromotionResult;
}

export function createCaptureFinalizationService(
  repository: CaptureRepository,
  diagnostics?: OperationalDiagnosticsReporter,
): CaptureFinalizationService {
  return {
    finalize(input) {
      const startedAt = Date.now();
      const existing = repository.getByTurn(input.correlation.turnId);
      const retryCount = existing?.revision ?? 0;
      try {
      if (existing?.durableManifestDigest !== undefined) {
        diagnostics?.report({ operationId: "capture.finalize", turnIds: [input.correlation.turnId], savePointIds: [existing.savePointId], reasonCodes: ["capture.already-durable"], durationMs: Date.now() - startedAt, perTurnLatencyMs: Date.now() - startedAt, retryCount, sizes: { captureBytes: Buffer.byteLength(JSON.stringify(input)) }, digests: { manifest: [existing.manifestDigest] }, policyVersions: { integrity: input.policyRevision }, outcomes: { privacy: input.privacy.status === "passed" ? "passed" : "quarantined", integrity: existing.integrity.state }, result: "pass" });
        return existing;
      }
      const savePointId = existing?.savePointId ?? input.savePointId;
      const evaluated = evaluateBundle({ ...input, savePointId });
      const stored = repository.saveCandidate({
        ...evaluated,
        savePointId,
        turnId: input.correlation.turnId,
        revision: (existing?.revision ?? 0) + 1,
      });
      diagnostics?.report({ operationId: "capture.finalize", turnIds: [input.correlation.turnId], savePointIds: [stored.savePointId], reasonCodes: [...stored.integrity.reasonCodes], durationMs: Date.now() - startedAt, perTurnLatencyMs: Date.now() - startedAt, retryCount, sizes: { captureBytes: Buffer.byteLength(JSON.stringify(input)) }, digests: { manifest: [stored.manifestDigest] }, policyVersions: { integrity: input.policyRevision }, outcomes: { privacy: input.privacy.status === "passed" ? "passed" : "quarantined", integrity: stored.integrity.state }, result: stored.promotionAllowed ? "pass" : "degraded" });
      return stored;
      } catch (error) {
        diagnostics?.report({ operationId: "capture.finalize", turnIds: [input.correlation.turnId], savePointIds: [input.savePointId], reasonCodes: ["capture.finalization-failed"], durationMs: Date.now() - startedAt, perTurnLatencyMs: Date.now() - startedAt, retryCount, sizes: {}, digests: {}, policyVersions: { integrity: input.policyRevision }, outcomes: { privacy: input.privacy.status === "passed" ? "passed" : "quarantined", integrity: "unavailable" }, result: "fail" });
        throw error;
      }
    },
    promote(turnId) {
      return repository.promote(turnId);
    },
  };
}
