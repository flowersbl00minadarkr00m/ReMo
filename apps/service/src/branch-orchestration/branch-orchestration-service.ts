import { validateBranchPreflightConfirmation, type BranchPreflightReceipt } from "@remo/domain";
import type { BranchGitAdapter, ExistingBranchTargetObservation, ObserveExistingBranchTargetRequest } from "@remo/branch-git";
import { FoundationConflictError, type BranchOperationIntent, type BranchOperationReceipt, type ReplayFoundationStore } from "@remo/storage-local";
import type { BranchPreflightMutationEvaluation } from "../branch-preflight/branch-preflight-service.js";
import type { OperationalDiagnosticsReporter } from "../support/operational-jsonl.js";

const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
});

export type BranchTerminalState = "succeeded" | "failed-no-effect" | "recovery-required" | "unavailable";
export type BranchCrashPoint = "before-journal-fsync" | "before-git" | "after-git" | "before-sqlite-success" | "after-receipt";

export interface BranchConfirmationRequest {
  readonly savePointId: string;
  readonly confirm: true;
  readonly preflightDigest: string;
  readonly expectedSavePointRevision: number;
  readonly displayLabel: string;
  readonly idempotencyKey: string;
}

export interface BranchOperationProjection {
  readonly schemaVersion: "remo.branch-result.v1";
  readonly operationId: string;
  readonly savePointId: string;
  readonly savePointRevision: number;
  readonly preflightDigest: string;
  readonly displayLabel: string;
  readonly state: BranchTerminalState;
  readonly reasonCodes: readonly string[];
  readonly branchRef: string;
  readonly worktreeRelativePath: string;
  readonly lineageId?: string;
  readonly updatedAt: string;
}

interface StoredBranchResult {
  readonly schemaVersion: "remo.branch-result-record.v1";
  readonly requestBinding: BranchConfirmationRequest;
  readonly observerRequest: ObserveExistingBranchTargetRequest;
  readonly projection: BranchOperationProjection;
  readonly gitEvidence?: unknown;
  readonly priorResult?: StoredBranchResult;
}

export class BranchCrashInjectionError extends Error {
  constructor(readonly point: BranchCrashPoint) { super(`Injected branch crash at ${point}.`); this.name = "BranchCrashInjectionError"; }
}

class AsyncMutationLock {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(action: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.#tail;
    this.#tail = previous.then(() => gate, () => gate);
    await previous;
    try { return await action(); } finally { release(); }
  }
}

function sameBinding(left: BranchConfirmationRequest, right: BranchConfirmationRequest): boolean {
  return left.savePointId === right.savePointId
    && left.confirm === right.confirm
    && left.preflightDigest === right.preflightDigest
    && left.expectedSavePointRevision === right.expectedSavePointRevision
    && left.displayLabel === right.displayLabel
    && left.idempotencyKey === right.idempotencyKey;
}

function parseStored(value: unknown): StoredBranchResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<StoredBranchResult>;
  return candidate.schemaVersion === "remo.branch-result-record.v1" && candidate.requestBinding !== undefined && candidate.observerRequest !== undefined && candidate.projection !== undefined ? candidate as StoredBranchResult : undefined;
}

function stateFromReceipt(receipt: BranchOperationReceipt): BranchTerminalState | "pending" {
  if (receipt.state === "pending") return "pending";
  const stored = parseStored(receipt.canonicalResult);
  if (stored !== undefined) return stored.projection.state;
  return receipt.state === "succeeded" ? "succeeded" : receipt.state === "failed" ? "failed-no-effect" : "recovery-required";
}

function reasonCodes(observation: ExistingBranchTargetObservation): readonly string[] {
  return observation.outcome === "exact-success" ? [] : observation.reasonCodes;
}

export interface BranchOrchestrationServiceOptions {
  readonly store: ReplayFoundationStore;
  readonly git: Pick<BranchGitAdapter, "createLockedWorktree" | "observeExistingTarget">;
  readonly preflightForMutation: (savePointId: string, revision: number) => Promise<BranchPreflightMutationEvaluation>;
  readonly readIssuedReceipt: (digest: string) => BranchPreflightReceipt | undefined;
  readonly now?: () => Date;
  readonly injectCrash?: (point: BranchCrashPoint) => void | Promise<void>;
  readonly diagnostics?: OperationalDiagnosticsReporter;
}

export function createBranchOrchestrationService(options: BranchOrchestrationServiceOptions) {
  const lock = new AsyncMutationLock();
  const now = () => options.now?.() ?? new Date();
  const crash = async (point: BranchCrashPoint) => { await options.injectCrash?.(point); };
  const report = (operationId: string, savePointId: string, state: string, reasons: readonly string[] = []): void => {
    options.diagnostics?.report({ operationId, turnIds: [], savePointIds: [savePointId], reasonCodes: reasons, durationMs: 0, retryCount: 0, sizes: {}, digests: {}, policyVersions: { branch: "remo.branch-result.v1" }, outcomes: { branch: state as "journaled" | "succeeded" | "failed-no-effect" | "recovery-required" | "unavailable" | "exact-success" | "absent" | "blocked" }, result: state === "succeeded" || state === "exact-success" ? "pass" : state === "failed-no-effect" || state === "absent" ? "degraded" : "unavailable" });
  };

  const projection = (request: BranchConfirmationRequest, intent: Pick<BranchOperationIntent, "operationId" | "branchRef" | "worktreeRelativePath">, state: BranchTerminalState, reasons: readonly string[], updatedAt: string): BranchOperationProjection => ({
    schemaVersion: "remo.branch-result.v1", operationId: intent.operationId, savePointId: request.savePointId, savePointRevision: request.expectedSavePointRevision, preflightDigest: request.preflightDigest, displayLabel: request.displayLabel,
    state, reasonCodes: reasons, branchRef: intent.branchRef, worktreeRelativePath: intent.worktreeRelativePath,
    ...(state === "succeeded" ? { lineageId: `lineage:alternate:${intent.operationId}` } : {}), updatedAt,
  });

  const finalize = (intent: BranchOperationReceipt, request: BranchConfirmationRequest, observerRequest: ObserveExistingBranchTargetRequest, state: Exclude<BranchTerminalState, "unavailable">, reasons: readonly string[], gitEvidence?: unknown): BranchOperationProjection => {
    const updatedAt = now().toISOString();
    const resultProjection = projection(request, intent, state, reasons, updatedAt);
    const record: StoredBranchResult = { schemaVersion: "remo.branch-result-record.v1", requestBinding: request, observerRequest, projection: resultProjection, ...(gitEvidence === undefined ? {} : { gitEvidence }) };
    options.store.appendBranchOperationReceipt({
      operationId: intent.operationId,
      state: state === "succeeded" ? "succeeded" : state === "failed-no-effect" ? "failed" : "recovery-required",
      canonicalResult: record,
      updatedAt,
      ...(state === "succeeded" ? { lineage: { lineageId: resultProjection.lineageId!, parentLineageId: intent.execution?.freshPreflightReceipt.originalLineageId ?? "lineage:original", rootSavePointId: intent.savePointId, branchOperationId: intent.operationId, gitRef: intent.branchRef, worktreeRelativePath: intent.worktreeRelativePath, state: "active-alternate" as const } } : {}),
    });
    report("branch.verify", intent.savePointId, state, reasons);
    return resultProjection;
  };

  const reconcilePending = async (intent: BranchOperationReceipt): Promise<BranchOperationProjection> => {
    const execution = intent.execution;
    if (execution === undefined) {
      const fallback: BranchConfirmationRequest = { savePointId: intent.savePointId, confirm: true, preflightDigest: intent.preflightDigest, expectedSavePointRevision: 1, displayLabel: "Unavailable branch intent", idempotencyKey: intent.intentKey };
      const observerRequest: ObserveExistingBranchTargetRequest = { savePointId: intent.savePointId, savePointRevision: 1, sourceCommit: "0".repeat(40), originalFuture: { branchRef: "", head: "", statusDigest: "", indexDigest: "", approvedSourceDigest: "", availability: { status: { state: "unavailable", reasonCode: "branch.intent-evidence-missing" }, index: { state: "unavailable", reasonCode: "branch.intent-evidence-missing" }, approvedSource: { state: "unavailable", reasonCode: "branch.intent-evidence-missing" }, capture: { state: "unavailable", reasonCode: "branch.intent-evidence-missing" } } } };
      return finalize(intent, fallback, observerRequest, "recovery-required", ["branch.intent-evidence-missing"]);
    }
    const request: BranchConfirmationRequest = { savePointId: intent.savePointId, confirm: true, preflightDigest: intent.preflightDigest, expectedSavePointRevision: execution.savePointRevision, displayLabel: execution.displayLabel, idempotencyKey: intent.intentKey };
    const observerRequest: ObserveExistingBranchTargetRequest = { savePointId: intent.savePointId, savePointRevision: execution.savePointRevision, sourceCommit: execution.sourceCommit, originalFuture: execution.originalFuture };
    const observed = await options.git.observeExistingTarget(observerRequest);
    return observed.outcome === "exact-success"
      ? finalize(intent, request, observerRequest, "succeeded", [], observed.evidence)
      : observed.outcome === "absent"
        ? finalize(intent, request, observerRequest, "failed-no-effect", observed.reasonCodes, observed.observed)
        : finalize(intent, request, observerRequest, "recovery-required", observed.reasonCodes, observed.observed);
  };

  return {
    async reconcileStartup(): Promise<readonly BranchOperationProjection[]> {
      return lock.run(async () => {
        for (const journal of options.store.listJournaledBranchIntents()) {
          if (!options.store.listBranchOperations().some(({ operationId }) => operationId === journal.operationId)) options.store.beginBranchOperation(journal);
        }
        const reconciled: BranchOperationProjection[] = [];
        for (const pending of options.store.listPendingBranchOperations()) reconciled.push(await reconcilePending(pending));
        for (const completed of options.store.listBranchOperations().filter(({ state }) => state === "succeeded")) {
          const stored = parseStored(completed.canonicalResult);
          if (stored === undefined) continue;
          const observed = await options.git.observeExistingTarget(stored.observerRequest);
          if (observed.outcome === "exact-success") continue;
          const updatedAt = now().toISOString();
          const unavailableProjection = { ...stored.projection, state: "unavailable" as const, reasonCodes: reasonCodes(observed), updatedAt };
          const unavailable: StoredBranchResult = { ...stored, projection: unavailableProjection, gitEvidence: observed.outcome === "recovery-required" ? observed.observed : observed.observed, priorResult: stored };
          options.store.markBranchOperationUnavailable({ operationId: completed.operationId, canonicalResult: unavailable, updatedAt });
          reconciled.push(unavailableProjection);
        }
        for (const result of reconciled) report("branch.reconcile", result.savePointId, result.state, result.reasonCodes);
        return reconciled;
      });
    },

    async confirm(request: BranchConfirmationRequest): Promise<BranchOperationProjection> {
      return lock.run(async () => {
        if (!SAFE_KEY.test(request.savePointId) || !SAFE_KEY.test(request.idempotencyKey) || request.confirm !== true || !DIGEST.test(request.preflightDigest) || !Number.isSafeInteger(request.expectedSavePointRevision) || request.expectedSavePointRevision < 1 || typeof request.displayLabel !== "string" || request.displayLabel.length < 1 || request.displayLabel.length > 80 || hasControlCharacter(request.displayLabel)) throw new FoundationConflictError("branch.intent-conflict", "Branch confirmation is malformed.");
        const existing = options.store.readBranchOperationByIntentKey(request.idempotencyKey);
        if (existing !== undefined) {
          const stored = parseStored(existing.canonicalResult);
          if (stored !== undefined) {
            if (!sameBinding(stored.requestBinding, request)) throw new FoundationConflictError("branch.intent-conflict", "Idempotency key is bound to a conflicting branch intent.");
            return stored.projection;
          }
          if (existing.state === "pending") {
            const execution = existing.execution;
            const binding: BranchConfirmationRequest | undefined = execution === undefined ? undefined : { savePointId: existing.savePointId, confirm: true, preflightDigest: existing.preflightDigest, expectedSavePointRevision: execution.savePointRevision, displayLabel: execution.displayLabel, idempotencyKey: existing.intentKey };
            if (binding === undefined || !sameBinding(binding, request)) throw new FoundationConflictError("branch.intent-conflict", "Idempotency key is bound to a conflicting pending branch intent.");
            return reconcilePending(existing);
          }
        }

        const blocking = options.store.listBranchOperations().find(({ state }) => state === "pending" || state === "succeeded" || state === "recovery-required");
        if (blocking !== undefined) throw new FoundationConflictError("branch.state-conflict", `Branch operation ${blocking.operationId} is ${blocking.state}; exactly one alternate lineage is permitted.`);

        const issued = options.readIssuedReceipt(request.preflightDigest);
        if (issued === undefined || issued.savePointId !== request.savePointId || issued.savePointRevision !== request.expectedSavePointRevision) throw new FoundationConflictError("branch.intent-conflict", "Branch preflight receipt is stale or was not issued by this process.");
        const fresh = await options.preflightForMutation(request.savePointId, request.expectedSavePointRevision);
        const validation = validateBranchPreflightConfirmation(issued, { now: now(), savePointRevision: fresh.receipt.savePointRevision, originalFutureDigest: fresh.receipt.originalFutureDigest, policyRevision: fresh.receipt.policyRevision, inputDigest: fresh.receipt.inputDigest });
        if (!fresh.receipt.ready || !validation.valid) throw new FoundationConflictError("branch.intent-conflict", `Fresh branch preflight rejected confirmation: ${validation.valid ? "preflight.blocked" : validation.reasonCode}.`);

        const intent: BranchOperationIntent = {
          operationId: fresh.receipt.target.operationId, intentKey: request.idempotencyKey, savePointId: request.savePointId, preflightDigest: request.preflightDigest, originalFutureDigest: fresh.receipt.originalFutureDigest,
          branchRef: fresh.receipt.target.branchRef, worktreeRelativePath: fresh.receipt.target.worktreeRelativePath, createdAt: now().toISOString(),
          execution: { savePointRevision: fresh.receipt.savePointRevision, sourceCommit: fresh.receipt.sourceCommit, originalFuture: fresh.originalFuture, freshPreflightReceipt: fresh.receipt, displayLabel: request.displayLabel },
        };
        await crash("before-journal-fsync");
        const journaled = options.store.beginBranchOperation(intent);
        report("branch.intent", journaled.savePointId, "journaled");
        await crash("before-git");
        const gitResult = await options.git.createLockedWorktree({ preflightReceipt: fresh.receipt, originalFuture: fresh.originalFuture });
        const gitReasonCodes: readonly string[] = gitResult.outcome === "succeeded" ? [] : gitResult.reasonCodes;
        report("branch.git-apply", journaled.savePointId, gitResult.outcome, gitReasonCodes);
        await crash("after-git");
        const observerRequest: ObserveExistingBranchTargetRequest = { savePointId: request.savePointId, savePointRevision: fresh.receipt.savePointRevision, sourceCommit: fresh.receipt.sourceCommit, originalFuture: fresh.originalFuture };
        if (gitResult.outcome !== "succeeded") {
          return gitResult.outcome === "recovery-required"
            ? finalize(journaled, request, observerRequest, "recovery-required", gitResult.reasonCodes, gitResult.observed)
            : finalize(journaled, request, observerRequest, "failed-no-effect", gitResult.reasonCodes, gitResult.outcome === "blocked" ? gitResult.observed : gitResult.observed);
        }
        await crash("before-sqlite-success");
        const result = finalize(journaled, request, observerRequest, "succeeded", [], gitResult.evidence);
        await crash("after-receipt");
        return result;
      });
    },

    readForSavePoint(savePointId: string): readonly BranchOperationProjection[] {
      if (!SAFE_KEY.test(savePointId)) return [];
      return options.store.listBranchOperations().filter((receipt) => receipt.savePointId === savePointId).map((receipt) => parseStored(receipt.canonicalResult)?.projection).filter((value): value is BranchOperationProjection => value !== undefined);
    },

    stateForReceipt(receipt: BranchOperationReceipt): BranchTerminalState | "pending" { return stateFromReceipt(receipt); },
  };
}

export type BranchOrchestrationService = ReturnType<typeof createBranchOrchestrationService>;
