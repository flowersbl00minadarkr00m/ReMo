import { resolve } from "node:path";
import { deriveBranchPreflightIdentity, evaluateBranchPreflight, type BranchPreflightEvidenceInput, type BranchPreflightLifecycleState, type BranchPreflightOriginalFuture, type BranchPreflightReceipt } from "@remo/domain";
import { inspectBranchPreflightRepository, type BranchPreflightRepositoryInspection, type BranchPreflightRepositoryOptions } from "@remo/evidence-git";

export interface BranchPreflightSavePoint {
  readonly savePointId: string;
  readonly revision: number;
  readonly lifecycleState: BranchPreflightLifecycleState;
  readonly integrityState: "complete" | "incomplete" | "inconsistent" | "quarantined";
  readonly fidelityState: "editable-eligible" | "historical-only" | "degraded" | "unavailable";
  readonly privacyPassed: boolean;
  readonly evidence: readonly BranchPreflightEvidenceInput[];
  readonly sourceCommit: string;
  readonly originalLineageId: string;
  readonly route: string;
  readonly fixture: string;
  readonly viewport: string;
  readonly dependencyDigest: string;
  readonly policyDigest: string;
}

export interface BranchPreflightServiceOptions {
  readonly findSavePoint: (savePointId: string) => BranchPreflightSavePoint | undefined;
  readonly pendingBranchOperation: () => boolean;
  readonly inspect?: (options: BranchPreflightRepositoryOptions) => Promise<BranchPreflightRepositoryInspection>;
  readonly repositoryRoot: string;
  readonly approvedSourceRoot: string;
  readonly expected: { readonly route: string; readonly fixture: string; readonly viewport: string; readonly dependencyDigest: string; readonly policyDigest: string };
  readonly now?: () => Date;
}

const EMPTY_DIGEST = `sha256:${"0".repeat(64)}`;
const EMPTY_COMMIT = "0".repeat(40);

function unavailableInspection(): BranchPreflightRepositoryInspection {
  const unavailable = { state: "unavailable" as const, reasonCode: "preflight.save-point-unavailable" };
  return {
    gitAvailable: false, sourceCommitExists: false, canonicalRootSafe: false, approvedSourceRootSafe: false, commonDirectorySafe: false, derivedWorktreeRootSafe: false, ownershipSafe: false, linksAbsent: false,
    targetRefAbsent: false, targetPathAbsent: false, activeGitOperation: false,
    checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: true, fsmonitorConfigured: false, fsmonitorNeutralized: true, unsafeConfigOrigin: false },
    reasonCodes: ["preflight.save-point-unavailable"],
    originalFuture: { branchRef: "", head: "", statusDigest: "", indexDigest: "", approvedSourceDigest: "", availability: { status: unavailable, index: unavailable, approvedSource: unavailable, capture: unavailable } },
  };
}

function notEvaluatedEvidence(): readonly BranchPreflightEvidenceInput[] {
  return ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "not-evaluated", correlationDigest: EMPTY_DIGEST, evidenceDigest: EMPTY_DIGEST }));
}

export interface BranchPreflightMutationEvaluation {
  readonly receipt: BranchPreflightReceipt;
  readonly originalFuture: BranchPreflightOriginalFuture;
}

export function createBranchPreflightService(options: BranchPreflightServiceOptions): {
  readonly preflight: (savePointId: string, requestedRevision: number) => Promise<BranchPreflightReceipt>;
  readonly preflightForMutation: (savePointId: string, requestedRevision: number) => Promise<BranchPreflightMutationEvaluation>;
  readonly readIssuedReceipt: (digest: string) => BranchPreflightReceipt | undefined;
} {
  const inspect = options.inspect ?? inspectBranchPreflightRepository;
  const issued = new Map<string, BranchPreflightReceipt>();
  const pruneIssued = (at: Date): void => {
    for (const [digest, receipt] of issued) {
      if (Date.parse(receipt.expiresAt) <= at.getTime()) issued.delete(digest);
    }
  };
  const evaluate = async (savePointId: string, requestedRevision: number): Promise<BranchPreflightMutationEvaluation> => {
    const point = options.findSavePoint(savePointId);
    const revision = point?.revision ?? Math.max(1, requestedRevision);
    const target = deriveBranchPreflightIdentity(savePointId, revision);
    const inspection = point === undefined ? unavailableInspection() : await inspect({ repositoryRoot: options.repositoryRoot, approvedSourceRoot: options.approvedSourceRoot, sourceCommit: point.sourceCommit, branchRef: target.branchRef, operationWorktreePath: resolve(options.repositoryRoot, target.worktreeRelativePath) });
    const evaluatedAt = options.now?.() ?? new Date();
    const receipt = evaluateBranchPreflight({
      savePointId: point?.savePointId ?? savePointId,
      requestedSavePointId: savePointId,
      savePointRevision: revision,
      requestedSavePointRevision: requestedRevision,
      lifecycleState: point?.lifecycleState ?? "missing",
      integrityState: point?.integrityState ?? "incomplete",
      fidelityState: point?.fidelityState ?? "unavailable",
      privacyPassed: point?.privacyPassed ?? false,
      evidence: point?.evidence ?? notEvaluatedEvidence(),
      sourceCommit: point?.sourceCommit ?? EMPTY_COMMIT,
      sourceCommitExists: inspection.sourceCommitExists,
      repository: { gitAvailable: inspection.gitAvailable, canonicalRootSafe: inspection.canonicalRootSafe, approvedSourceRootSafe: inspection.approvedSourceRootSafe, commonDirectorySafe: inspection.commonDirectorySafe, derivedWorktreeRootSafe: inspection.derivedWorktreeRootSafe, ownershipSafe: inspection.ownershipSafe, linksAbsent: inspection.linksAbsent },
      reproducibility: { route: point?.route ?? "not-evaluated", expectedRoute: options.expected.route, fixture: point?.fixture ?? "not-evaluated", expectedFixture: options.expected.fixture, viewport: point?.viewport ?? "not-evaluated", expectedViewport: options.expected.viewport, dependencyDigest: point?.dependencyDigest ?? "not-evaluated", expectedDependencyDigest: options.expected.dependencyDigest, policyDigest: point?.policyDigest ?? "not-evaluated", expectedPolicyDigest: options.expected.policyDigest },
      target: { ...target, refAbsent: inspection.targetRefAbsent, pathAbsent: inspection.targetPathAbsent },
      operationActive: options.pendingBranchOperation() || inspection.activeGitOperation,
      checkoutSafety: inspection.checkoutSafety,
      originalLineageId: point?.originalLineageId ?? "lineage:unavailable",
      originalFuture: inspection.originalFuture,
      inspectorReasonCodes: inspection.reasonCodes,
    }, evaluatedAt);
    pruneIssued(evaluatedAt);
    issued.set(receipt.digest, receipt);
    while (issued.size > 16) issued.delete(issued.keys().next().value as string);
    return { receipt, originalFuture: inspection.originalFuture };
  };
  return {
    async preflight(savePointId, requestedRevision) { return (await evaluate(savePointId, requestedRevision)).receipt; },
    preflightForMutation: evaluate,
    readIssuedReceipt(digest) {
      pruneIssued(options.now?.() ?? new Date());
      return issued.get(digest);
    },
  };
}
