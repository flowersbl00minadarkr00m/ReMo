import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalApplication } from "./local-application.js";

const roots: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");
  server.close();
  await once(server, "close");
  return address.port;
}

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "remo-vs002-t1-project-"));
  const webRoot = await mkdtemp(join(tmpdir(), "remo-vs002-t1-web-"));
  roots.push(projectRoot, webRoot);
  await mkdir(join(projectRoot, ".git"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
  const application = await startLocalApplication({ projectRoot, webRoot, port: await freePort(), seedImplementationFixture: false });
  return application;
}

async function promoteSeededFixture(origin: string): Promise<string> {
  const html = await (await fetch(`${origin}/candidate/review`)).text();
  const candidateMatch = /window\.__REMO_CANDIDATE__=(.*?);window\.__REMO_PROMOTION_SESSION__=(.*?);/u.exec(html);
  if (candidateMatch === null) throw new Error("missing candidate bootstrap");
  const candidate = JSON.parse(candidateMatch[1]!) as { readonly turnId: string; readonly confirmationBinding: { readonly savePointId: string; readonly candidateRevision: number; readonly candidateManifestDigest: string } };
  const session = JSON.parse(candidateMatch[2]!) as { readonly sessionToken: string };
  const response = await fetch(`${origin}/api/candidates/${candidate.turnId}/promote`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-remo-session-token": session.sessionToken },
    body: JSON.stringify({ confirm: true, ...candidate.confirmationBinding }),
  });
  if (!response.ok) throw new Error(`fixture promotion failed: ${response.status}`);
  return candidate.confirmationBinding.savePointId;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("VS-002 registered product routes", () => {
  it("returns one app shell for every registered route and keeps assets/unregistered paths as 404", async () => {
    const application = await fixture();
    try {
      for (const path of ["/boundary/setup", "/capture/active", "/candidate/review", "/save-points", "/save-points/example", "/replay", "/replay/example", "/compare?left=a&right=b"]) {
        const response = await fetch(`${application.origin}${path}`);
        expect(response.status, path).toBe(200);
        expect(await response.text(), path).toContain('<div id="root"></div>');
      }
      expect((await fetch(`${application.origin}/assets/missing.js`)).status).toBe(404);
      expect((await fetch(`${application.origin}/not-a-product-route`)).status).toBe(404);
    } finally {
      await application.close();
    }
  });

  it("bootstraps a named missing identity state inside the shell", async () => {
    const application = await fixture();
    try {
      const response = await fetch(`${application.origin}/save-points/missing-save`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('"state":"missing"');
      expect(html).not.toContain("/api/save-points/missing-save");
    } finally {
      await application.close();
    }
  });

  it("bootstraps malformed save-point URLs as recovery without accepting them as API identities", async () => {
    const application = await fixture();
    try {
      const response = await fetch(`${application.origin}/save-points/not%20valid`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('"state":"malformed"');
      expect(html).not.toContain("__REMO_SAVE_POINT__");

      const apiResponse = await fetch(`${application.origin}/api/save-points/not%20valid`);
      expect(apiResponse.status).toBe(404);
      expect(await apiResponse.text()).toContain("save-point.unknown-route");
    } finally {
      await application.close();
    }
  });

  it("reuses the existing identity-bound safe bootstrap for a valid replay-detail route", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "remo-vs002-t4-route-project-"));
    const webRoot = await mkdtemp(join(tmpdir(), "remo-vs002-t4-route-web-"));
    roots.push(projectRoot, webRoot);
    await mkdir(join(projectRoot, ".git"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
    const application = await startLocalApplication({ projectRoot, webRoot, port: await freePort() });
    try {
      const fixtureSavePointId = await promoteSeededFixture(application.origin);
      const response = await fetch(`${application.origin}/replay/${fixtureSavePointId}`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`"savePointId":"${fixtureSavePointId}"`);
      expect(html).toContain("window.__REMO_SAVE_POINT__=");
      expect(html).toContain("window.__REMO_SAVE_POINT_SESSION__=");
      expect(html).toContain("window.__REMO_REPLAY_RUNTIME__=");
      const history = await (await fetch(`${application.origin}/api/history`)).json() as { readonly anchors: readonly { readonly savePointId: string; readonly capturedThumbnail?: unknown }[] };
      expect(history.anchors.find(({ savePointId }) => savePointId === fixtureSavePointId)?.capturedThumbnail).toMatchObject({ availability: "available", reference: `/api/save-points/${fixtureSavePointId}/media/screenshot`, revision: 1 });

      const sessionMatch = /window\.__REMO_SAVE_POINT_SESSION__=(.*?);<\/script>/u.exec(html);
      expect(sessionMatch).not.toBeNull();
      const session = JSON.parse(sessionMatch![1]!) as { readonly sessionToken: string };
      const preflight = await fetch(`${application.origin}/api/save-points/${fixtureSavePointId}/branch-preflight`, {
        method: "POST",
        headers: { origin: application.origin, "content-type": "application/json", "x-remo-session-token": session.sessionToken },
        body: JSON.stringify({ savePointRevision: 1 }),
      });
      expect(preflight.status).toBe(200);
      const receipt = await preflight.json() as { readonly ready: boolean; readonly checks: readonly { readonly id: string }[]; readonly expiresAt: string; readonly evaluatedAt: string };
      expect(receipt.ready).toBe(false);
      expect(receipt.checks).toHaveLength(10);
      expect(Date.parse(receipt.expiresAt) - Date.parse(receipt.evaluatedAt)).toBe(30_000);
    } finally {
      await application.close();
    }
  });

  it.each(["missing-save", "not%20valid"])("keeps replay identity %s fail-closed without protected bootstrap", async (identity) => {
    const application = await fixture();
    try {
      const response = await fetch(`${application.origin}/replay/${identity}`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(identity === "not%20valid" ? '"state":"malformed"' : '"state":"missing"');
      expect(html).not.toContain("window.__REMO_SAVE_POINT__=");
      expect(html).not.toContain("window.__REMO_SAVE_POINT_SESSION__=");
    } finally {
      await application.close();
    }
  });
});
