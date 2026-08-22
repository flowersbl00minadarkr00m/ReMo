import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackSavedResultsClient } from "./saved-results-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("saved-results loopback client", () => {
  it("omits an undefined RequestInit signal without changing explicit abort forwarding", async () => {
    const result = { savePointId: "S1", displayId: "SP-001", turnId: "T1", turnNumber: 1, stablePath: "/save-points/S1", savedAt: "2026-08-16T08:00:00.000Z", integrity: "Complete", fidelity: "Editable eligible", pinned: false, expiresAt: "2026-09-15T08:00:00.000Z" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([result]) });
    vi.stubGlobal("fetch", fetchMock);
    const client = createLoopbackSavedResultsClient("http://127.0.0.1:4174");
    await client.list();
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ credentials: "same-origin" });
    const controller = new AbortController();
    await client.list(controller.signal);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({ credentials: "same-origin", signal: controller.signal });
  });

  it("rejects non-loopback origins and duplicate collection identities", async () => {
    expect(() => createLoopbackSavedResultsClient("https://remo.example.test")).toThrow(/loopback/iu);
    const duplicate = { savePointId: "S1", displayId: "SP-001", turnId: "T1", turnNumber: 1, stablePath: "/save-points/S1", savedAt: "2026-08-16T08:00:00.000Z", integrity: "Complete", fidelity: "Editable eligible", pinned: false, expiresAt: "2026-09-15T08:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([duplicate, duplicate]) }));
    await expect(createLoopbackSavedResultsClient("http://127.0.0.1:4174").list()).rejects.toThrow(/duplicate/iu);
  });
});
