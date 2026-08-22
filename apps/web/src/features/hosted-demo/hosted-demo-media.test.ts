import { describe, expect, it, vi } from "vitest";
import { EvidenceMediaClientError } from "../evidence-media/evidence-media-client.js";
import { readFileSync } from "node:fs";
import { HOSTED_DEMO_MEDIA_MANIFEST, HOSTED_DEMO_TURN_5_SCREENSHOT_MANIFEST, createHostedDemoEvidenceMediaClient, sha256HostedDemoBytes, validateHostedDemoPng, validateHostedReplayEvents } from "./hosted-demo-media.js";
import { validateHostedDemoFixture } from "./hosted-demo-fixture.js";
import fixtureManifest from "../../../public/hosted-demo/fixture-manifest.json";
import fixtureSource from "../../../public/hosted-demo/fixture.json?raw";

const fixture = validateHostedDemoFixture(fixtureManifest, fixtureSource as string);
const identity = HOSTED_DEMO_MEDIA_MANIFEST.identity;

function pngIhdr(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

describe("hosted demo media boundary", () => {
  it("hashes raw bytes without requiring a secure-context WebCrypto API", () => {
    const bytes = new TextEncoder().encode("abc");
    expect(sha256HostedDemoBytes(bytes.buffer)).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it.each([
    [55, "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"],
    [56, "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"],
    [64, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"],
    [65, "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"],
    [129, "c12cb024a2e5551cca0e08fce8f1c5e314555cc3fef6329ee994a3db752166ae"],
  ])("hashes the %i-byte padding and multi-block boundary", (length, digest) => {
    const bytes = new TextEncoder().encode("a".repeat(length));
    expect(sha256HostedDemoBytes(bytes.buffer)).toBe(`sha256:${digest}`);
  });

  it("hashes the committed screenshot bytes to the manifest digest", () => {
    const source = readFileSync(new URL("../../../public/hosted-demo/turn-4-screenshot.png", import.meta.url));
    const bytes = Uint8Array.from(source).buffer;
    expect(sha256HostedDemoBytes(bytes)).toBe(HOSTED_DEMO_MEDIA_MANIFEST.screenshot.digest);
  });

  it("binds the committed Turn 5 screenshot bytes and identity without substitution", async () => {
    const manifest = HOSTED_DEMO_TURN_5_SCREENSHOT_MANIFEST;
    const source = readFileSync(new URL("../../../public/hosted-demo/turn-5-screenshot.png", import.meta.url));
    const bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    expect(source.byteLength).toBe(manifest.byteLength);
    expect(sha256HostedDemoBytes(bytes)).toBe(manifest.digest);
    expect(() => validateHostedDemoPng(bytes, manifest.width, manifest.height)).not.toThrow();

    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(source, { status: 200, headers: { "content-type": "image/png" } })));
    const client = createHostedDemoEvidenceMediaClient(fixture, { fetcher });
    const result = await client.screenshot({ savePointId: manifest.savePointId, turnId: manifest.turnId, revision: manifest.revision, manifestDigest: manifest.manifestDigest }, new AbortController().signal);
    expect(result).toMatchObject({ componentId: manifest.componentId, digest: manifest.digest, width: manifest.width, height: manifest.height });
    expect(fetcher).toHaveBeenCalledWith(manifest.path, expect.objectContaining({ credentials: "omit", mode: "same-origin" }));
  });

  it("accepts only a structurally valid 1440x900 PNG IHDR", () => {
    expect(() => validateHostedDemoPng(pngIhdr(1_440, 900).buffer, 1_440, 900)).not.toThrow();
    expect(() => validateHostedDemoPng(new Uint8Array(33).buffer, 1_440, 900)).toThrow(/png-invalid/u);
    expect(() => validateHostedDemoPng(pngIhdr(1_440, 900).slice(0, 23).buffer, 1_440, 900)).toThrow(/png-invalid/u);
    expect(() => validateHostedDemoPng(pngIhdr(1_439, 900).buffer, 1_440, 900)).toThrow(/png-dimensions/u);
    expect(() => validateHostedDemoPng(pngIhdr(1_440, 899).buffer, 1_440, 900)).toThrow(/png-dimensions/u);
  });

  it("refuses every non-Turn-4 identity before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createHostedDemoEvidenceMediaClient(fixture, { fetcher });
    await expect(client.screenshot({ ...identity, savePointId: "demo-save-05" }, new AbortController().signal)).rejects.toMatchObject({ state: "digest-mismatch", reasonCode: "media.identity-mismatch" });
    await expect(client.replay({ ...identity, manifestDigest: `sha256:${"b".repeat(64)}` }, new AbortController().signal)).rejects.toBeInstanceOf(EvidenceMediaClientError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requests only the two fixed same-origin committed asset paths without credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new Uint8Array(), { status: 200, headers: { "content-type": "image/png" } })));
    const client = createHostedDemoEvidenceMediaClient(fixture, { fetcher });
    await expect(client.screenshot(identity, new AbortController().signal)).rejects.toMatchObject({ reasonCode: "media.byte-length-mismatch" });
    expect(fetcher).toHaveBeenCalledWith(HOSTED_DEMO_MEDIA_MANIFEST.screenshot.path, expect.objectContaining({ method: "GET", credentials: "omit", mode: "same-origin", redirect: "error", referrerPolicy: "no-referrer" }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/token|authorization|cookie/iu);
  });

  it("fails closed on missing, wrong-length, and wrong-media responses", async () => {
    const cases = [
      new Response(null, { status: 404 }),
      new Response(new Uint8Array(), { status: 200, headers: { "content-type": "image/png" } }),
      new Response(new Uint8Array(HOSTED_DEMO_MEDIA_MANIFEST.screenshot.byteLength), { status: 200, headers: { "content-type": "text/html" } }),
    ];
    for (const response of cases) {
      const client = createHostedDemoEvidenceMediaClient(fixture, { fetcher: vi.fn(() => Promise.resolve(response)) });
      await expect(client.screenshot(identity, new AbortController().signal)).rejects.toBeInstanceOf(EvidenceMediaClientError);
    }
  });

  it("rejects external resources, executable nodes, clipboard payloads, and unbounded event sets", () => {
    const meta = { type: 4, timestamp: HOSTED_DEMO_MEDIA_MANIFEST.replay.startTime, data: { href: "about:blank", width: 1_440, height: 900 } };
    const snapshot = { type: 2, timestamp: HOSTED_DEMO_MEDIA_MANIFEST.replay.startTime + 1, data: { node: { type: 0, childNodes: [] } } };
    for (const malicious of [
      { node: { tagName: "script" } },
      { node: { tagName: "img", attributes: { src: "https://outside.invalid/a.png" } } },
      { clipboardData: "copied" },
      { node: { attributes: { onclick: "alert(1)" } } },
    ]) {
      const events = [meta, snapshot, { type: 3, timestamp: HOSTED_DEMO_MEDIA_MANIFEST.replay.startTime + 2, data: malicious }, { type: 3, timestamp: HOSTED_DEMO_MEDIA_MANIFEST.replay.endTime, data: { source: 2 } }];
      expect(() => validateHostedReplayEvents(events)).toThrow(EvidenceMediaClientError);
    }
    expect(() => validateHostedReplayEvents([meta, snapshot])).toThrow(/event-count/u);
  });
});
