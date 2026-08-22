import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalApplication } from "../promotion/local-application.js";

const roots: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing port");
  server.close(); await once(server, "close"); return address.port;
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("history composition-root mount", () => {
  it("mounts only bounded read-only history while preserving existing API routing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "remo-history-mount-")); roots.push(projectRoot);
    await mkdir(join(projectRoot, ".git"));
    const webRoot = join(projectRoot, "web"); await mkdir(webRoot); await writeFile(join(webRoot, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    const application = await startLocalApplication({ projectRoot, webRoot, port: await freePort(), seedImplementationFixture: false, lifecycleSweepEveryMs: 60 * 60 * 1000 });
    try {
      const history = await fetch(`${application.origin}/api/history`);
      expect(history.status).toBe(200);
      expect(await history.json()).toEqual({ anchors: [], lineages: [{ lineageId: "lineage:original", state: "original" }], limit: 10, truncated: false });
      expect((await fetch(`${application.origin}/api/save-points`)).status).toBe(200);
      expect((await fetch(`${application.origin}/api/history`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${application.origin}/api/save-points/save-1/media/screenshot`)).status).not.toBe(200);
    } finally { await application.close(); }
  });
});
