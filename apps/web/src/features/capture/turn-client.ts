import type { StopSettlement } from "./ActiveTurn.js";

export interface TypedBoundaryRequest { readonly kind: "decision" | "human-intervention" | "verification"; readonly boundaryId: string; readonly occurredAt: string }
export interface TurnClientConfig { readonly origin: string; readonly turnId: string; readonly sessionToken: string; readonly fetcher?: typeof fetch }
export interface LoopbackTurnClient { stop(boundaries: readonly TypedBoundaryRequest[]): Promise<StopSettlement> }

export function createLoopbackTurnClient(config: TurnClientConfig): LoopbackTurnClient {
  const origin = new URL(config.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== config.origin) throw new Error("Turn control requires one exact loopback origin.");
  if (config.sessionToken.length < 8 || config.turnId.length === 0) throw new Error("Turn control requires an active turn and ephemeral session token.");
  const fetcher = config.fetcher ?? fetch;
  return {
    async stop(boundaries) {
      const response = await fetcher(`${origin.origin}/api/turns/${encodeURIComponent(config.turnId)}/stop`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json", "x-remo-session-token": config.sessionToken },
        body: JSON.stringify({ boundaries }),
      });
      if (!response.ok) throw new Error("Stop could not be confirmed by the local control service.");
      const result = await response.json() as Partial<StopSettlement>;
      if (result.status !== "candidate" && result.status !== "no-candidate") throw new Error("Stop returned an invalid settlement state.");
      return result as StopSettlement;
    },
  };
}
