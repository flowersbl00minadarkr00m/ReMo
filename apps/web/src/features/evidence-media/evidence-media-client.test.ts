import { describe, expect, it, vi } from "vitest";
import { createEvidenceMediaClient, EvidenceMediaClientError, validateReplayEnvelope, type EvidenceMediaIdentity, type ReplayEvidence } from "./evidence-media-client.js";

const identity: EvidenceMediaIdentity = { savePointId: "01J000000000000000000000S5", turnId: "01J000000000000000000000T5", revision: 3, manifestDigest: `sha256:${"a".repeat(64)}` };
const token = "t3-ephemeral-session-token-00000000000000000000";
const digest = `sha256:${"b".repeat(64)}`;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...Array.from<number>({ length: 16 }).fill(0)]);

function headers(role: "screenshot" | "rrweb", overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": role === "screenshot" ? "image/png" : "application/json; charset=utf-8",
    "x-remo-evidence-digest": digest,
    "x-remo-save-point-id": identity.savePointId,
    "x-remo-component-id": `${identity.turnId}:${role}`,
    "x-remo-manifest-revision": String(identity.revision),
    "x-remo-manifest-digest": identity.manifestDigest,
    "x-remo-viewport-width": "640",
    "x-remo-viewport-height": "360",
    ...overrides,
  });
}

function replay(): ReplayEvidence {
  return {
    schemaVersion: "remo.rrweb-replay.v1",
    savePointId: identity.savePointId,
    componentId: `${identity.turnId}:rrweb`,
    revision: identity.revision,
    manifestDigest: identity.manifestDigest,
    digest,
    capture: { origin: "http://127.0.0.1:4173", path: "/fixture/save-point", viewport: { width: 640, height: 360 }, startTime: 1_000, endTime: 1_020, durationMs: 20 },
    events: [{ type: 4, timestamp: 1_000, data: { href: "http://127.0.0.1:4173/fixture/save-point", width: 640, height: 360 } }, { type: 2, timestamp: 1_020, data: { node: { type: 0, childNodes: [] } } }],
  };
}

describe("evidence media browser client", () => {
  it("fetches exact authenticated routes and validates screenshot bindings before returning a Blob", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(png, { status: 200, headers: headers("screenshot") })));
    const client = createEvidenceMediaClient({ origin: "http://127.0.0.1:4175", sessionToken: token, fetcher });
    const controller = new AbortController();
    await expect(client.screenshot(identity, controller.signal)).resolves.toMatchObject({ digest, componentId: `${identity.turnId}:screenshot`, width: 640, height: 360 });
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:4175/api/save-points/${identity.savePointId}/media/screenshot`, { method: "GET", credentials: "same-origin", headers: { "x-remo-session-token": token }, signal: controller.signal });
  });

  it("accepts only the selected replay identity and authoritative capture window", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(replay()), { status: 200, headers: headers("rrweb") })));
    const client = createEvidenceMediaClient({ origin: "http://127.0.0.1:4175", sessionToken: token, fetcher });
    await expect(client.replay(identity, new AbortController().signal)).resolves.toEqual(replay());
  });

  it("maps stable server failures without upgrading them to available evidence", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ state: "unavailable", reasonCode: "media.digest-mismatch" }), { status: 409, headers: { "content-type": "application/json" } })));
    const client = createEvidenceMediaClient({ origin: "http://127.0.0.1:4175", sessionToken: token, fetcher });
    await expect(client.replay(identity, new AbortController().signal)).rejects.toMatchObject({ state: "digest-mismatch", reasonCode: "media.digest-mismatch" });
  });

  it("rejects mismatched headers and malicious replay data before player construction", async () => {
    const mismatch = vi.fn<typeof fetch>(() => Promise.resolve(new Response(png, { status: 200, headers: headers("screenshot", { "x-remo-save-point-id": "other-save" }) })));
    await expect(createEvidenceMediaClient({ origin: "http://127.0.0.1:4175", sessionToken: token, fetcher: mismatch }).screenshot(identity, new AbortController().signal)).rejects.toMatchObject({ state: "digest-mismatch" });
    for (const data of [
      { node: { tagName: "script" } },
      { node: { tagName: "a", attributes: { href: "javascript:alert(1)" } } },
      { node: { tagName: "img", attributes: { src: "https://outside.invalid/a.png" } } },
      { node: { tagName: "iframe", attributes: { src: "http://127.0.0.1:4173/fixture/save-point" } } },
      { node: { tagName: "form", attributes: { action: "/submit" } } },
      { source: 9, commands: [] },
    ]) {
      const candidate = { ...replay(), events: [replay().events[0]!, { type: 3, timestamp: 1_020, data }] };
      expect(() => validateReplayEnvelope(candidate, identity, digest, `${identity.turnId}:rrweb`)).toThrow(EvidenceMediaClientError);
    }
  });

  it("refuses non-loopback origins and weak session bootstraps before fetch", () => {
    expect(() => createEvidenceMediaClient({ origin: "https://example.com", sessionToken: token })).toThrow(/loopback/u);
    expect(() => createEvidenceMediaClient({ origin: "http://127.0.0.1:4175", sessionToken: "short" })).toThrow(/token/u);
  });
});
