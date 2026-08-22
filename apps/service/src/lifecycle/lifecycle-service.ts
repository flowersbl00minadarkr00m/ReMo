import { readFileSync } from "node:fs";
import type {
  DeletionReceipt,
  ExportReceipt,
  LifecycleMutationResult,
  LifecycleProjection,
  LocalSavePointRepository,
  SweepReceipt,
} from "@remo/storage-local";
import type { DiagnosticOutcome } from "../support/diagnostic-event.js";
import type { OperationalDiagnosticsReporter } from "../support/operational-jsonl.js";

export interface LifecycleService {
  get(savePointId: string): LifecycleProjection | undefined;
  pin(savePointId: string, operationId: string): LifecycleMutationResult;
  unpin(savePointId: string, operationId: string, confirmImmediateExpiry: boolean): LifecycleMutationResult;
  quarantine(savePointId: string, operationId: string): LifecycleMutationResult;
  redact(savePointId: string, operationId: string, redactedRoles: readonly string[]): LifecycleMutationResult;
  export(savePointId: string, operationId: string): ExportReceipt & { readonly bytesBase64: string };
  delete(savePointId: string, operationId: string): DeletionReceipt;
  sweep(): SweepReceipt;
}

export function createLifecycleService(repository: LocalSavePointRepository, diagnostics?: OperationalDiagnosticsReporter): LifecycleService {
  const observe = <T>(operation: string, savePointId: string | undefined, operationId: string | undefined, action: () => T, describe: (value: T) => { readonly sizes?: Readonly<Record<string, number>>; readonly outcome?: DiagnosticOutcome; readonly reasonCodes?: readonly string[] } = () => ({})): T => {
    const startedAt = Date.now();
    const turnId = savePointId === undefined ? undefined : repository.getLifecycle(savePointId)?.turnId;
    try {
      const value = action();
      const observed = describe(value);
      diagnostics?.report({ operationId: operation, ...(operationId === undefined ? {} : { operationInstanceId: operationId }), turnIds: turnId === undefined ? [] : [turnId], savePointIds: savePointId === undefined ? [] : [savePointId], reasonCodes: observed.reasonCodes ?? [], durationMs: Date.now() - startedAt, retryCount: 0, sizes: observed.sizes ?? {}, digests: {}, policyVersions: { retention: "retention-v1" }, ...(operation === "lifecycle.sweep" ? { outcomes: { sweep: observed.outcome ?? "complete" } } : operation === "lifecycle.delete" ? { outcomes: { deletion: observed.outcome ?? "deleted" } } : {}), result: "pass" });
      return value;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : `${operation}.failed`;
      diagnostics?.report({ operationId: operation, ...(operationId === undefined ? {} : { operationInstanceId: operationId }), turnIds: turnId === undefined ? [] : [turnId], savePointIds: savePointId === undefined ? [] : [savePointId], reasonCodes: [code], durationMs: Date.now() - startedAt, retryCount: 0, sizes: {}, digests: {}, policyVersions: { retention: "retention-v1" }, ...(operation === "lifecycle.sweep" ? { outcomes: { sweep: "unavailable" } } : operation === "lifecycle.delete" ? { outcomes: { deletion: "unavailable" } } : {}), result: "fail" });
      throw error;
    }
  };
  return {
    get: (savePointId) => repository.getLifecycle(savePointId),
    pin: (savePointId, operationId) => observe("lifecycle.pin", savePointId, operationId, () => repository.pinDurable(savePointId, operationId)),
    unpin: (savePointId, operationId, confirmImmediateExpiry) => observe("lifecycle.unpin", savePointId, operationId, () => repository.unpinDurable(savePointId, operationId, confirmImmediateExpiry)),
    quarantine: (savePointId, operationId) => observe("lifecycle.quarantine", savePointId, operationId, () => repository.quarantineDurable(savePointId, operationId)),
    redact: (savePointId, operationId, redactedRoles) => observe("lifecycle.redact", savePointId, operationId, () => repository.redactDurable(savePointId, operationId, { redactedRoles })),
    export(savePointId, operationId) {
      const receipt = observe("lifecycle.export", savePointId, operationId, () => repository.exportDurable(savePointId, operationId), (value) => ({ sizes: { exportBytes: value.byteSize } }));
      return { ...receipt, bytesBase64: readFileSync(receipt.path).toString("base64") };
    },
    delete: (savePointId, operationId) => observe("lifecycle.delete", savePointId, operationId, () => repository.deleteDurable(savePointId, operationId), (value) => ({ sizes: { deletionObservations: value.states.length }, outcome: "deleted" })),
    sweep: () => observe("lifecycle.sweep", undefined, undefined, () => repository.sweepExpired(), (value) => ({ sizes: { candidatesSwept: value.candidates.length, durableSavePointsSwept: value.durableSavePoints.length }, outcome: "complete" })),
  };
}

export interface LifecycleSweepScheduler {
  readonly startup: SweepReceipt;
  close(): void;
}

export function startLifecycleSweep(options: {
  readonly sweep: () => SweepReceipt;
  readonly everyMs?: number;
  readonly setInterval?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}): LifecycleSweepScheduler {
  const everyMs = options.everyMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(everyMs) || everyMs < 1) throw new TypeError("Lifecycle sweep interval must be a positive integer.");
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const startup = options.sweep();
  const handle = schedule(() => { options.sweep(); }, everyMs);
  let closed = false;
  return {
    startup,
    close() {
      if (closed) return;
      closed = true;
      cancel(handle);
    },
  };
}
