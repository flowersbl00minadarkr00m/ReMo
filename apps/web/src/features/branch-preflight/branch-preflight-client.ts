import { assertBranchPreflightReceipt, type BranchPreflightReceipt } from "@remo/domain/browser";

export interface BranchPreflightClient { preflight(savePointId: string, revision: number, signal: AbortSignal): Promise<BranchPreflightReceipt> }

function exactLoopback(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new TypeError("Branch preflight requires the exact IPv4 loopback origin.");
  return origin.origin;
}

export function createLoopbackBranchPreflightClient(options: { readonly origin: string; readonly sessionToken: string; readonly fetcher?: typeof fetch }): BranchPreflightClient {
  const origin = exactLoopback(options.origin); const fetcher = options.fetcher ?? fetch;
  return {
    async preflight(savePointId, revision, signal) {
      const response = await fetcher(`${origin}/api/save-points/${encodeURIComponent(savePointId)}/branch-preflight`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-remo-session-token": options.sessionToken }, body: JSON.stringify({ savePointRevision: revision }), signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { readonly message?: unknown };
        throw new Error(typeof body.message === "string" ? body.message : "Branch preflight failed closed. No mutation was attempted.");
      }
      return assertBranchPreflightReceipt(await response.json());
    },
  };
}
