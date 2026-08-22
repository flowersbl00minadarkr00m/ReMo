import type { EvidenceDetailProjection } from "./save-point-fixtures.js";

export interface ReconcileClient {
  reconcile(savePointId: string): Promise<EvidenceDetailProjection>;
}

export function createLoopbackReconcileClient(options: { readonly origin: string; readonly sessionToken: string }): ReconcileClient {
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== options.origin) throw new Error("Evidence reconciliation requires the exact IPv4 loopback origin.");
  if (options.sessionToken.length < 32) throw new Error("Evidence reconciliation session token is missing.");
  return {
    async reconcile(savePointId) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(savePointId)) throw new Error("Save identity is invalid.");
      const response = await fetch(`${origin.origin}/api/save-points/${encodeURIComponent(savePointId)}/reconcile`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-remo-session-token": options.sessionToken,
          "idempotency-key": `reconcile-${savePointId}`,
        },
        body: "{}",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Trace correlation remains unavailable.");
      const projection = await response.json() as EvidenceDetailProjection;
      if (projection.savePointId !== savePointId || projection.stablePath !== `/save-points/${savePointId}`) throw new Error("Reconciliation response identity does not match the requested save point.");
      return projection;
    },
  };
}
