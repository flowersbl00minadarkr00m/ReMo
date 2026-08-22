import type { BranchPreflightOriginalFuture, BranchPreflightReceipt, HistoryReader, EvidenceMediaReader, LineageRecord } from "@remo/domain";

export interface DecisionRevisionAppend {
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly predecessorDigest?: string;
  readonly canonicalRecord: unknown;
  readonly expectedDigest: string;
  readonly recordedAt: string;
}

export interface DecisionRevisionReceipt {
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly predecessorDigest?: string;
  readonly digest: string;
  readonly recordedAt: string;
}

export interface DecisionRevisionRead extends DecisionRevisionReceipt {
  readonly canonicalRecord: unknown;
}

export interface BranchOperationIntent {
  readonly operationId: string;
  readonly intentKey: string;
  readonly savePointId: string;
  readonly preflightDigest: string;
  readonly originalFutureDigest: string;
  readonly branchRef: string;
  readonly worktreeRelativePath: string;
  readonly createdAt: string;
  readonly execution?: {
    readonly savePointRevision: number;
    readonly sourceCommit: string;
    readonly originalFuture: BranchPreflightOriginalFuture;
    readonly freshPreflightReceipt: BranchPreflightReceipt;
    readonly displayLabel: string;
  };
}

export type BranchOperationState = "pending" | "succeeded" | "failed" | "recovery-required";

export interface BranchOperationReceipt extends BranchOperationIntent {
  readonly state: BranchOperationState;
  readonly canonicalResult?: unknown;
  readonly updatedAt: string;
}

export interface BranchOperationCompletion {
  readonly operationId: string;
  readonly state: Exclude<BranchOperationState, "pending">;
  readonly canonicalResult: unknown;
  readonly updatedAt: string;
  readonly lineage?: LineageRecord;
}

export interface ReplayFoundationStore extends HistoryReader, EvidenceMediaReader {
  appendDecisionRevision(request: DecisionRevisionAppend): DecisionRevisionReceipt;
  readDecisionRevisions(savePointId: string): readonly DecisionRevisionRead[];
  readLatestDecisionRevision(savePointId: string): DecisionRevisionRead | undefined;
  beginBranchOperation(request: BranchOperationIntent): BranchOperationReceipt;
  appendBranchOperationReceipt(request: BranchOperationCompletion): BranchOperationReceipt;
  listPendingBranchOperations(): readonly BranchOperationReceipt[];
  listJournaledBranchIntents(): readonly BranchOperationIntent[];
  listBranchOperations(): readonly BranchOperationReceipt[];
  readBranchOperationByIntentKey(intentKey: string): BranchOperationReceipt | undefined;
  markBranchOperationUnavailable(request: { readonly operationId: string; readonly canonicalResult: unknown; readonly updatedAt: string }): BranchOperationReceipt;
}

export class FoundationConflictError extends Error {
  constructor(readonly code: "decision.revision-conflict" | "branch.intent-conflict" | "branch.state-conflict", message: string) {
    super(message);
    this.name = "FoundationConflictError";
  }
}
