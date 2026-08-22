import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { evaluateBundle, type BundleManifest, type EvaluatedBundle, type FinalizationInput } from "@remo/domain";
import { canonicalSerialize, type DurableManifestRevision, type SavePointRepository } from "@remo/storage-local";

export interface RetentionProjection {
  readonly createdAt?: string;
  readonly promotedAt: string;
  readonly expiresAt: string;
  readonly originalExpiresAt?: string;
  readonly pinned: boolean;
  readonly pinnedAt?: string;
  readonly state?: "active" | "quarantined";
}

export interface PolicyRevisions {
  readonly capture: string;
  readonly privacy: string;
  readonly integrity: string;
  readonly fidelity: string;
  readonly retention: string;
}

export interface SavePointSeed {
  readonly finalization: FinalizationInput;
  readonly nominationReason: string;
  readonly retention: RetentionProjection;
  readonly policyRevisions: PolicyRevisions;
}

export interface StoredSavePoint extends EvaluatedBundle, SavePointSeed {
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly stablePath: string;
  readonly traceValidatedAt?: string;
}

export interface SavePointStore {
  put(seed: SavePointSeed): StoredSavePoint;
  get(savePointId: string): StoredSavePoint | undefined;
  update(savePointId: string, next: FinalizationInput, options?: { readonly expectedRevision?: number; readonly traceValidatedAt?: string }): StoredSavePoint;
  count(): number;
}

function clone(record: StoredSavePoint): StoredSavePoint {
  return structuredClone(record);
}

function record(seed: SavePointSeed, revision: number, options: { readonly manifestDigest?: string; readonly traceValidatedAt?: string } = {}): StoredSavePoint {
  const evaluated = evaluateBundle(seed.finalization);
  return {
    ...seed,
    ...evaluated,
    ...(options.manifestDigest === undefined ? {} : { manifestDigest: options.manifestDigest }),
    savePointId: seed.finalization.savePointId,
    turnId: seed.finalization.correlation.turnId,
    revision,
    stablePath: `/save-points/${encodeURIComponent(seed.finalization.savePointId)}`,
    ...(options.traceValidatedAt === undefined ? {} : { traceValidatedAt: options.traceValidatedAt }),
  };
}

export function createInMemorySavePointStore(): SavePointStore {
  const bySavePoint = new Map<string, StoredSavePoint>();
  const byTurn = new Map<string, string>();
  return {
    put(seed) {
      const savePointId = seed.finalization.savePointId;
      const turnId = seed.finalization.correlation.turnId;
      const turnOwner = byTurn.get(turnId);
      if (turnOwner !== undefined && turnOwner !== savePointId) throw new Error("Turn already belongs to another save identity.");
      const existing = bySavePoint.get(savePointId);
      if (existing !== undefined && existing.turnId !== turnId) throw new Error("Save identity cannot move to another turn.");
      const next = record(seed, existing?.revision ?? 1);
      bySavePoint.set(savePointId, next);
      byTurn.set(turnId, savePointId);
      return clone(next);
    },
    get(savePointId) {
      const existing = bySavePoint.get(savePointId);
      return existing === undefined ? undefined : clone(existing);
    },
    update(savePointId, nextFinalization, options = {}) {
      const existing = bySavePoint.get(savePointId);
      if (existing === undefined) throw new Error("Save point was not found.");
      if (options.expectedRevision !== undefined && existing.revision !== options.expectedRevision) throw new Error("Save point revision changed during reconciliation.");
      if (nextFinalization.savePointId !== existing.savePointId || nextFinalization.correlation.turnId !== existing.turnId) {
        throw new Error("Reconciliation cannot replace the save or turn identity.");
      }
      const traceValidatedAt = options.traceValidatedAt ?? existing.traceValidatedAt;
      const next = record({ ...existing, finalization: nextFinalization }, existing.revision + 1, traceValidatedAt === undefined ? {} : { traceValidatedAt });
      if (next.canonicalManifest === existing.canonicalManifest && next.traceValidatedAt === existing.traceValidatedAt) return clone(existing);
      bySavePoint.set(savePointId, next);
      return clone(next);
    },
    count() {
      return bySavePoint.size;
    },
  };
}

function finalizationFromDurable(receipt: DurableManifestRevision): FinalizationInput {
  const envelope = JSON.parse(readFileSync(receipt.manifestPath, "utf8")) as { readonly manifest?: { readonly savePointId?: string; readonly turnId?: string; readonly bundle?: BundleManifest } };
  const durableManifest = envelope.manifest;
  const manifest = durableManifest?.bundle;
  if (durableManifest === undefined || manifest === undefined || durableManifest.savePointId !== receipt.savePointId || durableManifest.turnId !== receipt.turnId || manifest.savePointId !== receipt.savePointId || manifest.correlation.turnId !== receipt.turnId) {
    throw new Error("Durable manifest identity does not match its repository receipt.");
  }
  const durableDigest = `sha256:${createHash("sha256").update(canonicalSerialize(durableManifest)).digest("hex")}`;
  if (durableDigest !== receipt.manifestDigest) throw new Error("Durable manifest digest does not match its repository receipt.");
  const finalization: FinalizationInput = {
    schemaVersion: manifest.schemaVersion,
    identityVersion: manifest.identityVersion,
    policyRevision: manifest.policyRevision,
    savePointId: manifest.savePointId,
    correlation: manifest.correlation,
    privacy: manifest.privacy,
    evidence: manifest.evidence,
  };
  return finalization;
}

export function createDurableSavePointStore(repository: Pick<SavePointRepository, "getDurable" | "getCurrentRevision" | "appendReconciliation" | "countDurable" | "getLifecycle">, initialSeeds: readonly SavePointSeed[]): SavePointStore {
  const seeds = new Map(initialSeeds.map((seed) => [seed.finalization.savePointId, structuredClone(seed)]));
  const durableRecord = (savePointId: string): StoredSavePoint | undefined => {
    const seed = seeds.get(savePointId);
    if (seed === undefined) return undefined;
    const promotion = repository.getDurable(seed.finalization.correlation.turnId);
    const revision = repository.getCurrentRevision(savePointId);
    const lifecycle = repository.getLifecycle(savePointId);
    if (promotion === undefined || revision === undefined || lifecycle === undefined || lifecycle.state !== "active" || promotion.savePointId !== savePointId || revision.turnId !== promotion.turnId) return undefined;
    return record({ ...seed, finalization: finalizationFromDurable(revision), retention: { createdAt: lifecycle.createdAt, promotedAt: promotion.promotedAt, expiresAt: promotion.expiresAt, originalExpiresAt: lifecycle.originalExpiresAt, pinned: promotion.pinned, ...(lifecycle.pinnedAt === undefined ? {} : { pinnedAt: lifecycle.pinnedAt }), state: "active" } }, revision.revision, {
      manifestDigest: revision.manifestDigest,
      ...(revision.traceValidatedAt === undefined ? {} : { traceValidatedAt: revision.traceValidatedAt }),
    });
  };
  return {
    put(seed) {
      seeds.set(seed.finalization.savePointId, structuredClone(seed));
      const durable = durableRecord(seed.finalization.savePointId);
      if (durable === undefined) throw new Error("Save point is not durable in the local repository.");
      return clone(durable);
    },
    get(savePointId) {
      const durable = durableRecord(savePointId);
      return durable === undefined ? undefined : clone(durable);
    },
    update(savePointId, nextFinalization, options = {}) {
      const existing = durableRecord(savePointId);
      if (existing === undefined) throw new Error("Save point was not found.");
      if (options.expectedRevision !== undefined && existing.revision !== options.expectedRevision) throw new Error("Save point revision changed during reconciliation.");
      if (nextFinalization.savePointId !== existing.savePointId || nextFinalization.correlation.turnId !== existing.turnId) throw new Error("Reconciliation cannot replace the save or turn identity.");
      const traceValidatedAt = options.traceValidatedAt ?? existing.traceValidatedAt;
      const next = record({ ...existing, finalization: nextFinalization }, existing.revision + 1, traceValidatedAt === undefined ? {} : { traceValidatedAt });
      if (next.canonicalManifest === existing.canonicalManifest && next.traceValidatedAt === existing.traceValidatedAt) return clone(existing);
      const revision = repository.appendReconciliation({
        savePointId,
        turnId: existing.turnId,
        expectedRevision: existing.revision,
        expectedManifestDigest: existing.manifestDigest,
        bundle: nextFinalization,
        ...(traceValidatedAt === undefined ? {} : { traceValidatedAt }),
      });
      return record({ ...existing, finalization: finalizationFromDurable(revision) }, revision.revision, {
        manifestDigest: revision.manifestDigest,
        ...(revision.traceValidatedAt === undefined ? {} : { traceValidatedAt: revision.traceValidatedAt }),
      });
    },
    count() { return repository.countDurable(); },
  };
}
