import type { EvidenceDescriptor, FinalizationInput } from "@remo/domain";
import { validateTraceId, type LangfuseLookup, type TraceLookupResult } from "@remo/evidence-langfuse";
import type { SavePointStore, StoredSavePoint } from "../save-points/save-point-service.js";
import type { OperationalDiagnosticsReporter } from "../support/operational-jsonl.js";

export type { TraceLookupResult };

function replaceTrace(finalization: FinalizationInput, result: TraceLookupResult): FinalizationInput {
  const trace = finalization.evidence.find(({ componentType }) => componentType === "trace");
  if (trace?.externalId === undefined) throw new Error("A supplied W3C trace ID is required before reconciliation.");
  validateTraceId(trace.externalId);
  let replacement: EvidenceDescriptor;
  switch (result.status) {
    case "matching":
      replacement = { ...trace, availability: "available", correlation: finalization.correlation };
      break;
    case "missing":
      replacement = { ...trace, availability: "missing", correlation: finalization.correlation };
      break;
    case "unreachable":
      replacement = { ...trace, availability: "unreachable", correlation: finalization.correlation };
      break;
    case "conflicting":
      replacement = { ...trace, availability: "available", correlation: { ...finalization.correlation, turnId: result.metadataTurnId } };
      break;
  }
  return {
    ...finalization,
    evidence: finalization.evidence.map((descriptor) => descriptor.componentType === "trace" ? replacement : descriptor),
  };
}

export function createReconciliationService(store: SavePointStore, lookup: LangfuseLookup, diagnostics?: OperationalDiagnosticsReporter): {
  reconcile(savePointId: string, idempotencyKey?: string): Promise<StoredSavePoint>;
} {
  const inFlight = new Map<string, Promise<StoredSavePoint>>();
  const perSaveTail = new Map<string, Promise<void>>();
  const perSaveOwner = new Map<string, symbol>();
  let sequence = 0;
  return {
    reconcile(savePointId, idempotencyKey = `direct-${++sequence}`) {
      const operation = `${savePointId}:${idempotencyKey}`;
      const existingOperation = inFlight.get(operation);
      if (existingOperation !== undefined) return existingOperation;
      const previous = perSaveTail.get(savePointId) ?? Promise.resolve();
      const owner = Symbol(operation);
      const promise = previous.catch(() => undefined).then(async () => {
        const startedAt = Date.now();
        const current = store.get(savePointId);
        if (current === undefined) {
          diagnostics?.report({ operationId: "reconciliation.trace", turnIds: [], savePointIds: [savePointId], reasonCodes: ["reconciliation.save-point-not-found"], durationMs: Date.now() - startedAt, retryCount: 0, sizes: {}, digests: {}, policyVersions: {}, outcomes: { integrity: "unavailable" }, result: "fail" });
          throw new Error("Save point was not found.");
        }
        const trace = current.finalization.evidence.find(({ componentType }) => componentType === "trace");
        if (trace?.externalId === undefined) throw new Error("A supplied W3C trace ID is required before reconciliation.");
        let result: TraceLookupResult;
        try {
          result = await lookup.lookup({ traceId: trace.externalId, expectedTurnId: current.turnId });
        } catch (error) {
          diagnostics?.report({ operationId: "reconciliation.trace", operationInstanceId: idempotencyKey, turnIds: [current.turnId], savePointIds: [savePointId], reasonCodes: ["trace.authority-unreachable"], durationMs: Date.now() - startedAt, perTurnLatencyMs: Date.now() - startedAt, retryCount: 0, sizes: {}, digests: { manifest: [current.manifestDigest] }, policyVersions: { ...current.policyRevisions }, outcomes: { integrity: current.integrity.state }, result: "unavailable" });
          throw error;
        }
        const latest = store.get(savePointId);
        if (latest === undefined) throw new Error("Save point was not found.");
        const incomingTime = result.validatedAt === undefined ? undefined : Date.parse(result.validatedAt);
        const currentTime = latest.traceValidatedAt === undefined ? undefined : Date.parse(latest.traceValidatedAt);
        if (incomingTime !== undefined && Number.isFinite(incomingTime) && currentTime !== undefined && Number.isFinite(currentTime) && incomingTime < currentTime) return latest;
        const updated = store.update(savePointId, replaceTrace(latest.finalization, result), {
          expectedRevision: latest.revision,
          ...(result.validatedAt === undefined ? {} : { traceValidatedAt: result.validatedAt }),
        });
        diagnostics?.report({ operationId: "reconciliation.trace", operationInstanceId: idempotencyKey, turnIds: [updated.turnId], savePointIds: [updated.savePointId], reasonCodes: [...updated.integrity.reasonCodes], durationMs: Date.now() - startedAt, perTurnLatencyMs: Date.now() - startedAt, retryCount: 0, sizes: {}, digests: { manifest: [updated.manifestDigest] }, policyVersions: { ...updated.policyRevisions }, outcomes: { integrity: updated.integrity.state }, result: result.status === "matching" ? "pass" : result.status === "unreachable" ? "unavailable" : "degraded" });
        return updated;
      }).finally(() => {
        inFlight.delete(operation);
        if (perSaveOwner.get(savePointId) === owner) {
          perSaveOwner.delete(savePointId);
          perSaveTail.delete(savePointId);
        }
      });
      const tail = promise.then(() => undefined, () => undefined);
      inFlight.set(operation, promise);
      perSaveTail.set(savePointId, tail);
      perSaveOwner.set(savePointId, owner);
      return promise;
    },
  };
}
