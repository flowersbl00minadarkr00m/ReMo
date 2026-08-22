import { describe, expect, it, vi } from "vitest";
import { projectHistoryFilmstrip } from "@remo/domain/browser";
import { createLoopbackHistoryClient } from "./history-client.js";

describe("loopback history client", () => {
  it("loads and validates the bounded projection without credentials or mutation", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ anchors: [{ savePointId: "save-1", turnId: "turn-1", sequenceNo: 1, lineageId: "lineage:original", promotedAt: "2026-08-18T00:00:00.000Z", state: "active", provenance: "observed", integrity: "complete", fidelity: "editable-eligible" }], limit: 10, truncated: false }), { status: 200, headers: { "content-type": "application/json" } })));
    const client = createLoopbackHistoryClient("http://127.0.0.1:4175", fetcher);
    const items = projectHistoryFilmstrip(await client.list(new AbortController().signal));
    expect(items).toHaveLength(1);
    expect(items[0]?.selectionPath).toBe("/replay/save-1");
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:4175/api/history", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });

  it("fails closed on unsupported origin, malformed history, and HTTP failure", async () => {
    expect(() => createLoopbackHistoryClient("http://localhost:4175")).toThrow(/loopback/u);
    await expect(createLoopbackHistoryClient("http://127.0.0.1:4175", vi.fn(() => Promise.resolve(new Response("{}", { status: 503 })))).list()).rejects.toThrow(/unavailable/u);
    await expect(createLoopbackHistoryClient("http://127.0.0.1:4175", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ anchors: [{ savePointId: "save-6", turnId: "turn-6", sequenceNo: 6, lineageId: "lineage:original", state: "tombstone", provenance: "fixture-contract", integrity: "deleted", fidelity: "unavailable" }], limit: 10, truncated: false }), { status: 200 })))).list()).rejects.toThrow(/receipt/u);
  });
});
