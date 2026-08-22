export type ReconciliationCrashPoint =
  | "before-revision-transaction-commit"
  | "after-revision-transaction-commit"
  | "before-revision-materialization"
  | "before-revision-manifest-write"
  | "before-revision-manifest-rename"
  | "after-revision-materialization";

export interface DurableManifestRevision {
  readonly turnId: string;
  readonly savePointId: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly manifestPath: string;
  readonly predecessorRevision?: number;
  readonly predecessorManifestDigest?: string;
  readonly traceValidatedAt?: string;
}

export interface AppendReconciliationRequest {
  readonly savePointId: string;
  readonly turnId: string;
  readonly expectedRevision: number;
  readonly expectedManifestDigest: string;
  readonly traceValidatedAt?: string;
  readonly bundle: unknown;
}
