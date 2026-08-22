import { assertHistoryPage, type HistoryPage } from "@remo/domain/browser";

export interface HistoryClient {
  list(signal?: AbortSignal): Promise<HistoryPage>;
}

export function createLoopbackHistoryClient(originValue: string, fetcher: typeof fetch = fetch): HistoryClient {
  const origin = new URL(originValue);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== originValue) throw new Error("History requires the exact IPv4 loopback origin.");
  return {
    async list(signal) {
      const response = await fetcher(`${origin.origin}/api/history`, { method: "GET", credentials: "same-origin", ...(signal === undefined ? {} : { signal }) });
      if (!response.ok) throw new Error("History is unavailable.");
      return assertHistoryPage(await response.json() as HistoryPage);
    },
  };
}
