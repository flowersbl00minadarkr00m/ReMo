import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BundleManifest, EvidenceMediaReadRequest, EvidenceMediaReadResult, HistoryPage } from "@remo/domain";
import type { CurrentDurableSavePoint } from "@remo/storage-local";
import { createEvidenceMediaHandler, validateRrwebBytes, type EvidenceMediaAuthorityReader } from "./handler.js";
import { createEvidenceMediaMount } from "./mount.js";

const TOKEN = "t3-ephemeral-session-token-00000000000000000000";
const SAVE_ID = "01J000000000000000000000S5";
const TURN_ID = "01J000000000000000000000T5";
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const CAPTURE_URL = "http://127.0.0.1:4173/fixture/save-point";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function rrweb(overrides: { readonly unsafeData?: unknown; readonly href?: string; readonly type?: number } = {}): Buffer {
  return Buffer.from(JSON.stringify([
    { type: 4, timestamp: 1_000, data: { href: overrides.href ?? CAPTURE_URL, width: 640, height: 360 } },
    { type: overrides.type ?? 2, timestamp: 1_020, data: overrides.unsafeData ?? { node: { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: "html", attributes: {}, childNodes: [] }] } } },
  ]));
}

function reader(bytesByRole: { readonly screenshot?: Buffer; readonly rrweb?: Buffer } = { screenshot: PNG, rrweb: rrweb() }): EvidenceMediaAuthorityReader & { readonly reads: EvidenceMediaReadRequest[] } {
  const reads: EvidenceMediaReadRequest[] = [];
  const screenshot = bytesByRole.screenshot;
  const recording = bytesByRole.rrweb;
  const evidence = [
    ...(recording === undefined ? [] : [{ componentId: `${TURN_ID}:rrweb`, componentType: "rrweb" as const, authority: "rrweb" as const, correlation: { projectId: "remo", turnId: TURN_ID, captureWindowId: "window-t5", boundaryRevision: "boundary-v1" }, capturedAt: "2026-08-18T00:00:00.000Z", digest: digest(recording), availability: "available" as const, provenance: "observed" as const, policyRevision: "remo.privacy.v1", claims: {} }]),
    ...(screenshot === undefined ? [] : [{ componentId: `${TURN_ID}:screenshot`, componentType: "screenshot" as const, authority: "remo" as const, correlation: { projectId: "remo", turnId: TURN_ID, captureWindowId: "window-t5", boundaryRevision: "boundary-v1" }, capturedAt: "2026-08-18T00:00:00.000Z", digest: digest(screenshot), availability: "available" as const, provenance: "observed" as const, policyRevision: "remo.privacy.v1", claims: {} }]),
  ];
  const bundle = { savePointId: SAVE_ID, correlation: { projectId: "remo", turnId: TURN_ID, captureWindowId: "window-t5", boundaryRevision: "boundary-v1" }, evidence } as unknown as BundleManifest;
  const current = { receipt: { savePointId: SAVE_ID, turnId: TURN_ID }, revision: { savePointId: SAVE_ID, turnId: TURN_ID, revision: 3, manifestDigest: MANIFEST_DIGEST }, lifecycle: { state: "active" }, bundle } as CurrentDurableSavePoint;
  return {
    reads,
    listCurrentDurable: () => [current],
    listHistory: () => ({ anchors: [], limit: 10, truncated: false }) as HistoryPage,
    readEvidenceMedia(request): EvidenceMediaReadResult {
      reads.push(request);
      const bytes = request.role === "screenshot" ? screenshot : recording;
      if (bytes === undefined) return { status: "unavailable", reasonCode: "media.component-missing" };
      return { status: "available", savePointId: SAVE_ID, componentId: `${TURN_ID}:${request.role}`, role: request.role, digest: digest(bytes), byteSize: bytes.byteLength, contentType: request.role === "screenshot" ? "image/png" : "application/json", bytes };
    },
  };
}

async function serve(authority = reader()): Promise<{ readonly origin: string; readonly close: () => Promise<void>; readonly authority: ReturnType<typeof reader> }> {
  const server: Server = createServer();
  server.on("request", (request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const mount = createEvidenceMediaMount(createEvidenceMediaHandler({ allowedOrigin: origin, allowedCaptureUrl: CAPTURE_URL, sessionToken: TOKEN, reader: authority }));
    if (!mount(request, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, authority, close: async () => { server.close(); await once(server, "close"); } };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => { while (open.length > 0) await open.pop()!(); vi.restoreAllMocks(); });

describe("authenticated evidence media handler", () => {
  it("accepts the real privacy-cleared S-001 rrweb fixture as bounded replay evidence", () => {
    const bytes = readFileSync(join(import.meta.dirname, "fixtures/s-001/privacy-cleared.rrweb.json"));
    expect(validateRrwebBytes(bytes, CAPTURE_URL)).toMatchObject({ origin: "http://127.0.0.1:4173", path: "/fixture/save-point", viewport: { width: 1440, height: 900 } });
  });

  it("serves a digest-bound real PNG using only server-derived durable authority", async () => {
    const fixture = await serve(); open.push(fixture.close);
    const response = await fetch(`${fixture.origin}/api/save-points/${SAVE_ID}/media/screenshot`, { headers: { origin: fixture.origin, "x-remo-session-token": TOKEN } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-remo-evidence-digest")).toBe(digest(PNG));
    expect(response.headers.get("x-remo-save-point-id")).toBe(SAVE_ID);
    expect(response.headers.get("x-remo-component-id")).toBe(`${TURN_ID}:screenshot`);
    expect(response.headers.get("x-remo-manifest-revision")).toBe("3");
    expect(response.headers.get("x-remo-manifest-digest")).toBe(MANIFEST_DIGEST);
    expect(response.headers.get("x-remo-viewport-width")).toBe("1");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(fixture.authority.reads).toEqual([{ savePointId: SAVE_ID, componentId: `${TURN_ID}:screenshot`, role: "screenshot", expectedRevision: 3, expectedManifestDigest: MANIFEST_DIGEST, expectedDigest: digest(PNG) }]);
  });

  it("returns a bounded identity envelope after revalidating real rrweb JSON", async () => {
    const fixture = await serve(); open.push(fixture.close);
    const response = await fetch(`${fixture.origin}/api/save-points/${SAVE_ID}/media/rrweb`, { headers: { origin: fixture.origin, "x-remo-session-token": TOKEN } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toMatchObject({ schemaVersion: "remo.rrweb-replay.v1", savePointId: SAVE_ID, componentId: `${TURN_ID}:rrweb`, revision: 3, manifestDigest: MANIFEST_DIGEST, capture: { origin: "http://127.0.0.1:4173", path: "/fixture/save-point", viewport: { width: 640, height: 360 }, startTime: 1_000, endTime: 1_020, durationMs: 20 }, events: [{ type: 4 }, { type: 2 }] });
  });

  it("fails closed for missing token, wrong origin, wrong method, query/path injection, and missing identity", async () => {
    const fixture = await serve(); open.push(fixture.close);
    const path = `${fixture.origin}/api/save-points/${SAVE_ID}/media/screenshot`;
    expect((await fetch(path, { headers: { origin: fixture.origin } })).status).toBe(401);
    expect((await fetch(path, { headers: { origin: "http://127.0.0.1:9", "x-remo-session-token": TOKEN } })).status).toBe(403);
    expect((await fetch(path, { method: "POST", headers: { origin: fixture.origin, "x-remo-session-token": TOKEN } })).status).toBe(405);
    expect((await fetch(`${path}?path=C:/private`, { headers: { origin: fixture.origin, "x-remo-session-token": TOKEN } })).status).toBe(404);
    const missing = await fetch(`${fixture.origin}/api/save-points/missing/media/screenshot`, { headers: { origin: fixture.origin, "x-remo-session-token": TOKEN } });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ state: "unavailable", reasonCode: "media.save-not-found" });
  });

  it.each([
    ["script node", { node: { tagName: "script", attributes: {}, childNodes: [] } }, 2],
    ["javascript URL", { node: { tagName: "a", attributes: { href: "javascript:alert(1)" }, childNodes: [] } }, 2],
    ["external resource", { node: { tagName: "img", attributes: { src: "https://outside.invalid/a.png" }, childNodes: [] } }, 2],
    ["cross-origin iframe", { node: { tagName: "iframe", attributes: { src: "https://outside.invalid" }, childNodes: [] } }, 2],
    ["form", { node: { tagName: "form", attributes: { action: "/submit" }, childNodes: [] } }, 2],
    ["canvas", { source: 9, id: 1, commands: [] }, 3],
    ["event addition/custom event", { tag: "inject", payload: {} }, 5],
    ["inline pointer handler", { node: { tagName: "button", attributes: { onclick: "alert(1)" }, childNodes: [] } }, 2],
    ["meta refresh", { node: { tagName: "meta", attributes: { "http-equiv": "refresh", content: "0;url=https://outside.invalid" }, childNodes: [] } }, 2],
    ["inline CSS import", { node: { tagName: "style", attributes: {}, childNodes: [{ type: 3, textContent: "@import 'https://outside.invalid/a.css'" }] } }, 2],
    ["inline CSS URL", { node: { tagName: "style", attributes: {}, childNodes: [{ type: 3, textContent: "body{background:url(/probe.png)}" }] } }, 2],
    ["media element", { node: { tagName: "video", attributes: { src: "/probe.mp4" }, childNodes: [] } }, 2],
    ["image element", { node: { tagName: "img", attributes: { src: "/probe.png" }, childNodes: [] } }, 2],
  ])("rejects %s before bytes can cross the replay boundary", (_label, unsafeData, type) => {
    expect(() => validateRrwebBytes(rrweb({ unsafeData, type }), CAPTURE_URL)).toThrow(/media\.rrweb-(?:invalid|security-rejected)/u);
  });

  it("rejects captured navigation and does not log media payloads or tokens", async () => {
    expect(() => validateRrwebBytes(rrweb({ href: "http://127.0.0.1:4173/other" }), CAPTURE_URL)).toThrow(/media\.rrweb-(?:invalid|security-rejected)/u);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = await serve(reader({ screenshot: PNG, rrweb: rrweb({ unsafeData: { node: { tagName: "script" } } }) })); open.push(fixture.close);
    const response = await fetch(`${fixture.origin}/api/save-points/${SAVE_ID}/media/rrweb`, { headers: { origin: fixture.origin, "x-remo-session-token": TOKEN } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ state: "unavailable", reasonCode: "media.rrweb-security-rejected" });
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
});
