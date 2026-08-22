export type IntegritySummary = "Complete" | "Incomplete" | "Inconsistent" | "Quarantined";
export type FidelitySummary = "Editable eligible" | "Degraded" | "Historical only";

export interface SavedResultSummary {
  readonly savePointId: string;
  readonly displayId: string;
  readonly turnId: string;
  readonly turnNumber: number;
  readonly stablePath: string;
  readonly savedAt: string;
  readonly integrity: IntegritySummary;
  readonly fidelity: FidelitySummary;
  readonly pinned: boolean;
  readonly expiresAt: string;
}

export interface SavedResultsClient {
  list(signal?: AbortSignal): Promise<readonly SavedResultSummary[]>;
}

function isSummary(value: unknown): value is SavedResultSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.savePointId === "string"
    && typeof summary.displayId === "string"
    && typeof summary.turnId === "string"
    && Number.isSafeInteger(summary.turnNumber)
    && typeof summary.stablePath === "string"
    && summary.stablePath === `/save-points/${encodeURIComponent(summary.savePointId)}`
    && typeof summary.savedAt === "string"
    && Number.isFinite(Date.parse(summary.savedAt))
    && ["Complete", "Incomplete", "Inconsistent", "Quarantined"].includes(String(summary.integrity))
    && ["Editable eligible", "Degraded", "Historical only"].includes(String(summary.fidelity))
    && typeof summary.pinned === "boolean"
    && typeof summary.expiresAt === "string"
    && Number.isFinite(Date.parse(summary.expiresAt));
}

export function createLoopbackSavedResultsClient(originValue: string): SavedResultsClient {
  const origin = new URL(originValue);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== originValue) throw new Error("Saved results require the exact IPv4 loopback origin.");
  return {
    async list(signal) {
      const response = await fetch(`${origin.origin}/api/save-points`, { credentials: "same-origin", ...(signal === undefined ? {} : { signal }) });
      if (!response.ok) throw new Error("Saved results are unavailable.");
      const value = await response.json() as unknown;
      if (!Array.isArray(value) || value.length > 10 || !value.every(isSummary)) throw new Error("Saved results response is invalid.");
      const identities = new Set(value.flatMap((item) => [item.savePointId, item.turnId, item.stablePath]));
      if (identities.size !== value.length * 3) throw new Error("Saved results contain duplicate identities.");
      return value;
    },
  };
}
