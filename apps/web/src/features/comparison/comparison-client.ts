import { assertComparisonProjection, assertHistoryPage, type ComparisonProjection, type HistoryPage } from "@remo/domain/browser";

export interface ComparisonClient {
  history(signal: AbortSignal): Promise<HistoryPage>;
  compare(left: string, right: string, signal: AbortSignal): Promise<ComparisonProjection>;
}

export class ComparisonClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ComparisonClientError"; }
}

function exactLoopback(value: string): string {
  const origin = new URL(value); if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new TypeError("Comparison requires the exact IPv4 loopback origin."); return origin.origin;
}

async function failure(response: Response): Promise<ComparisonClientError> {
  const body = await response.json().catch(() => ({})) as { readonly error?: unknown; readonly message?: unknown };
  return new ComparisonClientError(typeof body.error === "string" ? body.error : "comparison.request-failed", typeof body.message === "string" ? body.message : "Comparison evidence request failed.");
}

export function createLoopbackComparisonClient(options: { readonly origin: string; readonly fetcher?: typeof fetch }): ComparisonClient {
  const origin = exactLoopback(options.origin); const fetcher = options.fetcher ?? fetch;
  return {
    async history(signal) { const response = await fetcher(`${origin}/api/history`, { method: "GET", credentials: "same-origin", signal }); if (!response.ok) throw await failure(response); return assertHistoryPage(await response.json() as HistoryPage); },
    async compare(left, right, signal) { const query = new URLSearchParams({ left, right }); const response = await fetcher(`${origin}/api/comparisons?${query}`, { method: "GET", credentials: "same-origin", signal }); if (!response.ok) throw await failure(response); return assertComparisonProjection(await response.json()); },
  };
}
