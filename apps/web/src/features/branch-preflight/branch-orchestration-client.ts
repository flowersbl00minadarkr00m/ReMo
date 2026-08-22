import type { BranchPreflightReceipt } from "@remo/domain/browser";

export type BranchResultState = "succeeded" | "failed-no-effect" | "recovery-required" | "unavailable";
export interface BranchResult {
  readonly schemaVersion: "remo.branch-result.v1";
  readonly operationId: string;
  readonly savePointId: string;
  readonly savePointRevision: number;
  readonly preflightDigest: string;
  readonly displayLabel: string;
  readonly state: BranchResultState;
  readonly reasonCodes: readonly string[];
  readonly branchRef: string;
  readonly worktreeRelativePath: string;
  readonly lineageId?: string;
  readonly updatedAt: string;
}

export interface BranchOrchestrationClient {
  confirm(receipt: BranchPreflightReceipt, displayLabel: string, idempotencyKey: string, signal: AbortSignal): Promise<BranchResult>;
  list(savePointId: string, signal: AbortSignal): Promise<readonly BranchResult[]>;
}

function exactLoopback(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new TypeError("Branch confirmation requires the exact IPv4 loopback origin.");
  return origin.origin;
}

function assertResult(value: unknown): BranchResult {
  if (typeof value !== "object" || value === null) throw new TypeError("Branch result is malformed.");
  const result = value as Partial<BranchResult>;
  if (result.schemaVersion !== "remo.branch-result.v1" || typeof result.operationId !== "string" || typeof result.savePointId !== "string" || !Number.isSafeInteger(result.savePointRevision) || typeof result.preflightDigest !== "string" || typeof result.displayLabel !== "string" || !["succeeded", "failed-no-effect", "recovery-required", "unavailable"].includes(String(result.state)) || !Array.isArray(result.reasonCodes) || result.reasonCodes.some((reason) => typeof reason !== "string") || typeof result.branchRef !== "string" || typeof result.worktreeRelativePath !== "string" || typeof result.updatedAt !== "string") throw new TypeError("Branch result is malformed.");
  return result as BranchResult;
}

export function createLoopbackBranchOrchestrationClient(options: { readonly origin: string; readonly sessionToken: string; readonly fetcher?: typeof fetch }): BranchOrchestrationClient {
  const origin = exactLoopback(options.origin); const fetcher = options.fetcher ?? fetch;
  const url = (savePointId: string) => `${origin}/api/save-points/${encodeURIComponent(savePointId)}/branches`;
  const headers = { "x-remo-session-token": options.sessionToken };
  return {
    async confirm(receipt, displayLabel, idempotencyKey, signal) {
      const response = await fetcher(url(receipt.savePointId), { method: "POST", credentials: "same-origin", headers: { ...headers, "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ confirm: true, preflightDigest: receipt.digest, expectedSavePointRevision: receipt.savePointRevision, displayLabel }), signal });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { readonly message?: unknown }; throw new Error(typeof body.message === "string" ? body.message : "Branch confirmation failed closed."); }
      return assertResult(await response.json());
    },
    async list(savePointId, signal) {
      const response = await fetcher(url(savePointId), { method: "GET", credentials: "same-origin", headers, signal });
      if (!response.ok) throw new Error("Branch state is unavailable.");
      const body = await response.json() as { readonly schemaVersion?: unknown; readonly operations?: unknown };
      if (body.schemaVersion !== "remo.branch-results.v1" || !Array.isArray(body.operations)) throw new TypeError("Branch result list is malformed.");
      return body.operations.map(assertResult);
    },
  };
}
