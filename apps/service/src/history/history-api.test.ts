import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { HistoryReader } from "@remo/domain";
import { createHistoryApi } from "./history-api.js";

vi.mock("../evidence-media/handler.js", () => ({ safelyAvailableEvidenceMedia: vi.fn(() => new Set(["screenshot"])) }));

async function readHistory(reader: HistoryReader): Promise<{ readonly status: number; readonly text: string }> {
  const api = createHistoryApi(reader);
  const server = createServer((request, response) => { if (!api.handle(request, response)) response.writeHead(404).end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing port");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/history`);
    return { status: response.status, text: await response.text() };
  } finally { server.close(); await once(server, "close"); }
}

describe("bounded read-only history API", () => {
  it("serves only exact loopback GET history and exposes no storage paths", async () => {
    const reader: HistoryReader = { listHistory: () => ({ anchors: [{ savePointId: "save-1", turnId: "turn-1", sequenceNo: 1, lineageId: "lineage:original", promotedAt: "2026-08-16T00:00:00.000Z", majorTurnLabel: "Turn 1", nominationReason: "fixture", state: "active", provenance: "fixture-contract", integrity: "complete", fidelity: "editable-eligible" }], limit: 10, truncated: false }) };
    const api = createHistoryApi(reader);
    const server = createServer((request, response) => { if (!api.handle(request, response)) response.writeHead(404).end(); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing port");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/history`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ anchors: [{ savePointId: "save-1", sequenceNo: 1 }], limit: 10, truncated: false });
      expect(text).not.toMatch(/relative_path|manifestPath|C:\\|\.remo/iu);
      expect((await fetch(`http://127.0.0.1:${address.port}/api/history`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`http://127.0.0.1:${address.port}/api/history?limit=10`)).status).toBe(404);
    } finally { server.close(); await once(server, "close"); }
  });

  it("joins safe media availability to the same trust projection returned for detail", async () => {
    const manifestDigest = `sha256:${"a".repeat(64)}`;
    const anchor = { savePointId: "save-4", turnId: "turn-4", sequenceNo: 4, lineageId: "lineage:original", promotedAt: "2026-08-16T00:04:00.000Z", majorTurnLabel: "Turn 4", nominationReason: "fixture", state: "active", provenance: "fixture-contract", integrity: "complete", fidelity: "editable-eligible" } as const;
    const reader = {
      listHistory: () => ({ anchors: [anchor], limit: 10, truncated: false }),
      listCurrentDurable: () => [{ receipt: { savePointId: anchor.savePointId, turnId: anchor.turnId }, revision: { revision: 2, manifestDigest } }],
      readEvidenceMedia: vi.fn(),
    } as unknown as HistoryReader;
    const response = await readHistory(reader);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ anchors: [{
      savePointId: anchor.savePointId,
      turnId: anchor.turnId,
      integrity: "incomplete",
      fidelity: "degraded",
      capturedThumbnail: { availability: "available", revision: 2, manifestDigest },
      capturedReplay: { availability: "unavailable" },
    }] });
  });
});
