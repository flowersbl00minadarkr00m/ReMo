import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadReplayRuntimeAssets } from "./runtime-assets.js";
import { REPLAY_PARENT_ORIGIN, REPLAY_RUNTIME_ORIGIN, REPLAY_RUNTIME_PORT, replayRuntimeSecurityHeaders, startReplayRuntime, type ReplayRuntimeServer } from "./runtime-server.js";

const roots: string[] = [];
let runtime: ReplayRuntimeServer | undefined;
let blocker: Server | undefined;

async function builtWebRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "remo-replay-runtime-"));
  roots.push(root);
  await mkdir(join(root, ".vite"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "replayRuntime-abc.js"), "export const runtime=true;\n");
  await writeFile(join(root, "assets", "replayRuntime-abc.css"), "#replay-root{display:block}\n");
  await writeFile(join(root, "assets", "protocol-abc.js"), "export const protocol=true;\n");
  await writeFile(join(root, ".vite", "manifest.json"), JSON.stringify({
    "src/replay-runtime/main.ts": { file: "assets/replayRuntime-abc.js", name: "replayRuntime", src: "src/replay-runtime/main.ts", isEntry: true, imports: ["_protocol"], css: ["assets/replayRuntime-abc.css"] },
    _protocol: { file: "assets/protocol-abc.js" },
  }));
  return root;
}

afterEach(async () => {
  await runtime?.close(); runtime = undefined;
  if (blocker !== undefined) await new Promise<void>((resolve) => blocker!.close(() => resolve()));
  blocker = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("closed replay runtime listener", () => {
  it("loads only the runtime entry and its recursively allowlisted immutable assets", async () => {
    const root = await builtWebRoot();
    const assets = loadReplayRuntimeAssets(root);
    expect([...assets.assets.keys()].sort()).toEqual(["/assets/protocol-abc.js", "/assets/replayRuntime-abc.css", "/assets/replayRuntime-abc.js"]);
    expect(assets.document.toString()).toContain('<script type="module" src="/assets/replayRuntime-abc.js"></script>');
    await writeFile(join(root, ".vite", "manifest.json"), JSON.stringify({ "src/replay-runtime/main.ts": { file: "../secret.js", name: "replayRuntime", isEntry: true } }));
    expect(() => loadReplayRuntimeAssets(root)).toThrow(/unsafe|escapes/u);
  });

  it("serves only exact GET runtime/assets with independent replay-only headers", async () => {
    const root = await builtWebRoot();
    runtime = await startReplayRuntime({ webRoot: root });
    expect(runtime.availability).toEqual({ state: "available", origin: REPLAY_RUNTIME_ORIGIN });
    const document = await fetch(`${REPLAY_RUNTIME_ORIGIN}/runtime`);
    expect(document.status).toBe(200);
    expect(document.headers.get("access-control-allow-origin")).toBeNull();
    expect(document.headers.get("set-cookie")).toBeNull();
    expect(document.headers.get("cache-control")).toBe("no-store");
    expect(document.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = document.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain(`frame-ancestors ${REPLAY_PARENT_ORIGIN}`);
    expect(csp).not.toContain("unsafe-eval");
    expect(await document.text()).toContain("ReMo isolated replay runtime");
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/assets/replayRuntime-abc.js`)).status).toBe(200);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/unknown`)).status).toBe(404);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/api/save-points`)).status).toBe(404);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/%2e%2e/secret`)).status).toBe(404);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/runtime?query=1`)).status).toBe(404);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/runtime`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/runtime`, { method: "OPTIONS" })).status).toBe(405);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/runtime`, { headers: { cookie: "session=forbidden" } })).status).toBe(403);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/runtime`, { headers: { authorization: "Bearer forbidden" } })).status).toBe(403);
    expect((await fetch(`${REPLAY_RUNTIME_ORIGIN}/runtime`, { headers: { origin: REPLAY_PARENT_ORIGIN } })).status).toBe(403);
  });

  it("projects missing or invalid runtime assets without opening a listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-runtime-missing-assets-")); roots.push(root);
    runtime = await startReplayRuntime({ webRoot: root });
    expect(runtime.availability).toEqual({ state: "listener-unavailable", origin: REPLAY_RUNTIME_ORIGIN, reasonCode: "replay.runtime-assets-unavailable" });
    await expect(fetch(`${REPLAY_RUNTIME_ORIGIN}/runtime`)).rejects.toThrow();
  });

  it("keeps the parent capability available when exact 4176 is already bound", async () => {
    const root = await builtWebRoot();
    blocker = createServer((_request, response) => response.end("occupied"));
    await new Promise<void>((resolve, reject) => { blocker!.once("error", reject); blocker!.listen(REPLAY_RUNTIME_PORT, "127.0.0.1", () => resolve()); });
    runtime = await startReplayRuntime({ webRoot: root });
    expect(runtime.availability).toEqual({ state: "listener-unavailable", origin: REPLAY_RUNTIME_ORIGIN, reasonCode: "replay.listener-unavailable" });
  });

  it("keeps the runtime CSP independent from the parent policy", () => {
    const headers = replayRuntimeSecurityHeaders("text/html; charset=utf-8");
    expect(headers["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
    expect(headers["content-security-policy"]).not.toContain("frame-ancestors 'none'");
  });
});
