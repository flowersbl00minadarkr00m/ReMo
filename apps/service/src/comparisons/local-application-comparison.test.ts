import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSavePointRepository } from "@remo/storage-local";
import type { BundleManifest } from "@remo/domain";
import { afterEach, describe, expect, it } from "vitest";
import { runTenSaveSequence } from "../acceptance-sequence/ten-save-sequence.js";
import { validateRrwebBytes } from "../evidence-media/handler.js";
import { startLocalApplication } from "../promotion/local-application.js";

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

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("comparison local-application mount", () => {
  it("validates persisted rrweb and PNG dimensions for default and alternate capture viewports", async () => {
    const report = await runTenSaveSequence(undefined, { captureViewportByTurn: { 3: { width: 1440, height: 1000 } } });
    const repository = new LocalSavePointRepository({ projectRoot: report.projectRoot });
    try {
      const observed: Record<number, { readonly rrweb: { readonly width: number; readonly height: number }; readonly png: { readonly width: number; readonly height: number } }> = {};
      for (const turnNumber of [1, 3]) {
        const summary = report.summaries.find((candidate) => candidate.turnNumber === turnNumber);
        const current = summary === undefined ? undefined : repository.listCurrentDurable().find(({ receipt }) => receipt.savePointId === summary.savePointId);
        const bundle = current?.bundle as Partial<BundleManifest> | undefined;
        const rrweb = bundle?.evidence?.find(({ componentType }) => componentType === "rrweb");
        const screenshot = bundle?.evidence?.find(({ componentType }) => componentType === "screenshot");
        if (rrweb?.digest === undefined || screenshot?.digest === undefined) throw new Error(`Turn ${turnNumber} persisted media is incomplete.`);
        const rrwebBytes = await readFile(repository.blobPath(rrweb.digest));
        const screenshotBytes = await readFile(repository.blobPath(screenshot.digest));
        const replay = validateRrwebBytes(rrwebBytes, "http://127.0.0.1:4173/fixture/save-point");
        const png = { width: screenshotBytes.readUInt32BE(16), height: screenshotBytes.readUInt32BE(20) };
        expect(replay.viewport).toEqual(png);
        observed[turnNumber] = { rrweb: replay.viewport, png };
      }
      expect(observed).toEqual({
        1: { rrweb: { width: 1440, height: 900 }, png: { width: 1440, height: 900 } },
        3: { rrweb: { width: 1440, height: 1000 }, png: { width: 1440, height: 1000 } },
      });
    } finally {
      repository.close();
      await report.dispose();
    }
  }, 120_000);

  it("mounts the read-only API and authenticated screenshot session without exposing it on degraded source routes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "remo-t6-comparison-project-"));
    const webRoot = await mkdtemp(join(tmpdir(), "remo-t6-comparison-web-"));
    roots.push(projectRoot, webRoot);
    await mkdir(join(projectRoot, ".git"));
    await writeFile(join(webRoot, "index.html"), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
    const application = await startLocalApplication({ projectRoot, webRoot, port: await freePort() });
    try {
      const candidateHtml = await (await fetch(`${application.origin}/candidate/review`)).text();
      const match = /window\.__REMO_CANDIDATE__=(.*?);window\.__REMO_PROMOTION_SESSION__=(.*?);/u.exec(candidateHtml);
      if (match === null) throw new Error("missing fixture candidate bootstrap");
      const candidate = JSON.parse(match[1]!) as { readonly turnId: string; readonly confirmationBinding: { readonly savePointId: string; readonly candidateRevision: number; readonly candidateManifestDigest: string } };
      const session = JSON.parse(match[2]!) as { readonly sessionToken: string };
      const promoted = await fetch(`${application.origin}/api/candidates/${candidate.turnId}/promote`, { method: "POST", headers: { origin: application.origin, "content-type": "application/json", "x-remo-session-token": session.sessionToken }, body: JSON.stringify({ confirm: true, ...candidate.confirmationBinding }) });
      expect(promoted.status).toBe(200);

      const compareHtml = await (await fetch(`${application.origin}/compare?left=${candidate.confirmationBinding.savePointId}&right=missing-side`)).text();
      expect(compareHtml).toContain("window.__REMO_SAVE_POINT_SESSION__=");
      const projectionResponse = await fetch(`${application.origin}/api/comparisons?left=${candidate.confirmationBinding.savePointId}&right=missing-side`);
      expect(projectionResponse.status, JSON.stringify(await projectionResponse.clone().json())).toBe(200);
      const projection = await projectionResponse.json() as { readonly left: { readonly screenshot: { readonly availability: string; readonly componentId: string; readonly digest: string; readonly width: number; readonly height: number }; readonly context: { readonly provenance: string; readonly viewport: { readonly width: number; readonly height: number } } }; readonly right: unknown; readonly parityClaimAllowed: boolean };
      expect(projection).toMatchObject({ left: { role: "before", state: "available", screenshot: { availability: "available", componentId: `${candidate.turnId}:screenshot` }, context: { provenance: "observed" } }, right: { role: "after", state: "missing", screenshot: { availability: "missing" } }, parityClaimAllowed: false });
      expect(projection.left.screenshot.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(projection.left.context.viewport).toEqual({ width: projection.left.screenshot.width, height: projection.left.screenshot.height });

      const missingHtml = await (await fetch(`${application.origin}/replay/missing-side`)).text();
      expect(missingHtml).not.toContain("window.__REMO_SAVE_POINT_SESSION__=");
      expect((await fetch(`${application.origin}/api/comparisons?left=${candidate.confirmationBinding.savePointId}&right=${candidate.confirmationBinding.savePointId}`)).status).toBe(400);
    } finally {
      await application.close();
    }
  });
});
