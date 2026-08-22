export interface LifecycleView {
  readonly subject: "candidate" | "durable";
  readonly id: string;
  readonly turnId: string;
  readonly savePointId: string;
  readonly revision: number;
  readonly state: "active" | "quarantined" | "expired" | "deleted";
  readonly createdAt: string;
  readonly promotedAt?: string;
  readonly originalExpiresAt: string;
  readonly expiresAt: string;
  readonly pinned: boolean;
  readonly pinnedAt?: string;
  readonly sourceSavePointId?: string;
}

export interface LifecycleMutation extends LifecycleView {
  readonly operationId: string;
  readonly changed: boolean;
}

export interface LifecycleExport {
  readonly operationId: string;
  readonly savePointId: string;
  readonly fileName: string;
  readonly digest: string;
  readonly byteSize: number;
  readonly bytesBase64: string;
  readonly inventory: readonly { readonly path: string; readonly byteSize: number; readonly digest: string }[];
  readonly excluded: readonly { readonly path: string; readonly reason: string; readonly authority?: string }[];
}

export interface LifecycleDeletion {
  readonly operationId: string;
  readonly subject: "durable";
  readonly targetId: string;
  readonly savePointId: string;
  readonly deletedAt: string;
  readonly states: readonly { readonly state: "removed" | "missing" | "shared" | "external"; readonly kind: string; readonly authority?: string }[];
  readonly complete: true;
}

export class LifecycleClientError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly confirmationRequired = false, readonly originalExpiresAt?: string) {
    super(code);
    this.name = "LifecycleClientError";
  }
}

export interface LifecycleClient {
  pin(savePointId: string, intentKey: string): Promise<LifecycleMutation>;
  unpin(savePointId: string, confirmImmediateExpiry: boolean, intentKey: string): Promise<LifecycleMutation>;
  quarantine(savePointId: string, intentKey: string): Promise<LifecycleMutation>;
  redact(savePointId: string, redactedRoles: readonly string[], intentKey: string): Promise<LifecycleMutation>;
  export(savePointId: string, intentKey: string): Promise<LifecycleExport>;
  delete(savePointId: string, intentKey: string): Promise<LifecycleDeletion>;
}

function exactLoopbackOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new Error("Lifecycle actions require the exact IPv4 loopback origin.");
  return origin;
}

export function createLoopbackLifecycleClient(options: { readonly origin: string; readonly sessionToken: string }): LifecycleClient {
  const origin = exactLoopbackOrigin(options.origin);
  if (options.sessionToken.length < 32) throw new Error("Lifecycle session token is missing.");
  const request = async <T>(savePointId: string, action: "pin" | "unpin" | "quarantine" | "redact" | "export" | "delete", body: unknown, intentKey: string): Promise<T> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(savePointId)) throw new Error("Save identity is invalid.");
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(intentKey)) throw new Error("Lifecycle intent key is invalid.");
    const response = await fetch(`${origin.origin}/api/save-points/${encodeURIComponent(savePointId)}${action === "delete" ? "" : `/${action}`}`, {
      method: action === "delete" ? "DELETE" : "POST",
      headers: {
        "content-type": "application/json",
        "x-remo-session-token": options.sessionToken,
        "idempotency-key": intentKey,
      },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const result = await response.json() as T & { readonly error?: string; readonly retryable?: boolean; readonly confirmationRequired?: boolean; readonly originalExpiresAt?: string };
    if (!response.ok) throw new LifecycleClientError(result.error ?? "lifecycle.action-failed", result.retryable === true, result.confirmationRequired === true, result.originalExpiresAt);
    return result;
  };
  return {
    pin: (savePointId, intentKey) => request(savePointId, "pin", {}, intentKey),
    unpin: (savePointId, confirmImmediateExpiry, intentKey) => request(savePointId, "unpin", { confirmImmediateExpiry }, intentKey),
    quarantine: (savePointId, intentKey) => request(savePointId, "quarantine", {}, intentKey),
    redact: (savePointId, redactedRoles, intentKey) => request(savePointId, "redact", { redactedRoles }, intentKey),
    export: (savePointId, intentKey) => request(savePointId, "export", {}, intentKey),
    delete: (savePointId, intentKey) => request(savePointId, "delete", {}, intentKey),
  };
}
