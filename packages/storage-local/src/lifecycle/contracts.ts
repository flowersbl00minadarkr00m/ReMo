export const CANDIDATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DURABLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

export type LifecycleSubject = "candidate" | "durable";
export type LifecycleState = "active" | "quarantined" | "expired" | "deleted";
export type LifecycleCrashPoint = "after-local-remove-before-catalog-commit";

export interface LifecycleBlob {
  readonly role: string;
  readonly bytes: Buffer;
  readonly expectedDigest: string;
}

export interface CandidateRegistration {
  readonly operationId: string;
  readonly turnId: string;
  readonly savePointId: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly createdAt: string;
  readonly policyRevision: string;
  readonly manifest: unknown;
  readonly blobs: readonly LifecycleBlob[];
  readonly sourceSavePointId?: string;
}

export interface LifecycleProjection {
  readonly subject: LifecycleSubject;
  readonly id: string;
  readonly turnId: string;
  readonly savePointId: string;
  readonly revision: number;
  readonly state: LifecycleState;
  readonly createdAt: string;
  readonly promotedAt?: string;
  readonly originalExpiresAt: string;
  readonly expiresAt: string;
  readonly pinned: boolean;
  readonly pinnedAt?: string;
  readonly sourceSavePointId?: string;
}

export interface LifecycleMutationResult extends LifecycleProjection {
  readonly operationId: string;
  readonly changed: boolean;
}

export interface ExportInventoryEntry {
  readonly path: string;
  readonly byteSize: number;
  readonly digest: string;
}

export interface ExportExclusion {
  readonly path: string;
  readonly reason: "external-authority" | "quarantined" | "policy-excluded";
  readonly authority?: "git" | "langfuse";
}

export interface ExportReceipt {
  readonly operationId: string;
  readonly savePointId: string;
  readonly revision: number;
  readonly exportedAt: string;
  readonly fileName: string;
  readonly path: string;
  readonly digest: string;
  readonly byteSize: number;
  readonly inventory: readonly ExportInventoryEntry[];
  readonly excluded: readonly ExportExclusion[];
}

export type DeletionReceiptState =
  | { readonly state: "removed" | "missing" | "shared"; readonly kind: "blob" | "manifest" | "render" | "export" | "catalog"; readonly digest?: string; readonly role?: string }
  | { readonly state: "external"; readonly kind: "authority"; readonly authority: "git" | "langfuse"; readonly identifier: string };

export interface DeletionReceipt {
  readonly operationId: string;
  readonly subject: LifecycleSubject;
  readonly targetId: string;
  readonly savePointId: string;
  readonly deletedAt: string;
  readonly states: readonly DeletionReceiptState[];
  readonly complete: true;
}

export interface SweepReceipt {
  readonly sweptAt: string;
  readonly candidates: readonly string[];
  readonly durableSavePoints: readonly string[];
}

export class LifecycleConfirmationRequiredError extends Error {
  readonly code = "lifecycle.immediate-expiry-confirmation-required";
  constructor(readonly originalExpiresAt: string) {
    super("Unpinning after the original deadline requires explicit confirmation because expiry is immediate.");
    this.name = "LifecycleConfirmationRequiredError";
  }
}

export class LifecycleUnavailableError extends Error {
  constructor(readonly code: "lifecycle.not-found" | "lifecycle.expired" | "lifecycle.quarantined", message: string) {
    super(message);
    this.name = "LifecycleUnavailableError";
  }
}

export class LifecycleIdempotencyConflictError extends Error {
  readonly code = "lifecycle.idempotency-conflict";
  constructor() {
    super("The idempotency key is already bound to a different lifecycle action or target.");
    this.name = "LifecycleIdempotencyConflictError";
  }
}

export class LifecycleCrashError extends Error {
  constructor(readonly crashPoint: LifecycleCrashPoint) {
    super(`Injected lifecycle crash at ${crashPoint}`);
    this.name = "LifecycleCrashError";
  }
}
