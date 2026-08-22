import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TraceLookupResult } from "@remo/evidence-langfuse";
import { LocalSavePointRepository } from "@remo/storage-local";
import { startLocalApplication } from "../promotion/local-application.js";

const TURN_ID = "01J000000000000000000000T5";
const SAVE_POINT_ID = "01J000000000000000000000S5";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SOURCE_COMMIT = "54474fd8d763cb9acaaa2e83b6df44df36fe7d92";
const roots: string[] = [];
let isolatedWebRoot: string;

beforeAll(async () => {
  isolatedWebRoot = await mkdtemp(join(tmpdir(), "remo-t6-current-web-"));
  const webPackage = resolve(fileURLToPath(new URL("../../../web", import.meta.url)));
  const vite = join(webPackage, "node_modules", "vite", "bin", "vite.js");
  const build = spawnSync(process.execPath, [vite, "build", "--outDir", isolatedWebRoot, "--emptyOutDir"], { cwd: webPackage, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

afterAll(async () => rm(isolatedWebRoot, { recursive: true, force: true }));

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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

async function reconcile(page: Page, key: string): Promise<Record<string, unknown>> {
  return page.evaluate(async ({ savePointId, idempotencyKey }) => {
    const token = (window as unknown as { __REMO_SAVE_POINT_SESSION__?: { readonly sessionToken: string } }).__REMO_SAVE_POINT_SESSION__?.sessionToken;
    if (token === undefined) throw new Error("missing save-point session token");
    const response = await fetch(`/api/save-points/${savePointId}/reconcile`, { method: "POST", headers: { "content-type": "application/json", "x-remo-session-token": token, "idempotency-key": idempotencyKey }, body: "{}" });
    if (!response.ok) throw new Error(`reconcile failed ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }, { savePointId: SAVE_POINT_ID, idempotencyKey: key });
}

async function blobFileCount(root: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) count += entry.isDirectory() ? await blobFileCount(join(root, entry.name)) : 1;
  return count;
}

describe("durable save-point detail in the supported local application", () => {
  it("serves the exact durable route and reconciles matching, missing, unreachable, and conflicting authority on one identity", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "remo-t6-durable-route-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".git"));
    let result: TraceLookupResult = { status: "missing", validatedAt: "2026-08-16T10:10:00.000Z" };
    let lookupFailure = false;
    const application = await startLocalApplication({ projectRoot, port: await freePort(), webRoot: isolatedWebRoot, traceLookup: { lookup: () => lookupFailure ? Promise.reject(new Error("authority unavailable")) : Promise.resolve(result) } });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${application.origin}/candidate/review`);
      await page.getByRole("button", { name: "Confirm durable save" }).click();
      await page.getByRole("heading", { name: "Durable save created" }).waitFor();

      expect(existsSync(join(projectRoot, ".remo", "catalog.sqlite"))).toBe(true);
      expect(await blobFileCount(join(projectRoot, ".remo", "blobs", "sha256"))).toBe(2);
      const missingResponse = await fetch(`${application.origin}/save-points/not-the-durable-save`);
      const missingHtml = await missingResponse.text();
      expect(missingResponse.status).toBe(200);
      expect(missingHtml).toContain('<div id="root"></div>');
      expect(missingHtml).toContain('"state":"missing"');
      expect(missingHtml).not.toContain("__REMO_SAVE_POINT__");
      expect(missingHtml).not.toContain("__REMO_SAVE_POINT_SESSION__");
      expect(missingHtml).not.toContain("javascript:raw-descriptor");

      const stablePath = `/save-points/${SAVE_POINT_ID}`;
      const stableResponse = await fetch(`${application.origin}${stablePath}`);
      const stableHtml = await stableResponse.text();
      expect(stableResponse.status).toBe(200);
      expect(stableHtml).toContain("__REMO_SAVE_POINT__");
      expect(stableHtml).not.toContain("javascript:raw-descriptor");

      await page.goto(`${application.origin}${stablePath}`);
      await page.getByRole("heading", { name: /Save point/u }).waitFor();
      await page.getByText("Complete", { exact: true }).waitFor();
      const apiGet = await page.evaluate(async (savePointId) => {
        const token = (window as unknown as { __REMO_SAVE_POINT_SESSION__?: { readonly sessionToken: string } }).__REMO_SAVE_POINT_SESSION__?.sessionToken;
        if (token === undefined) throw new Error("missing save-point session token");
        const response = await fetch(`/api/save-points/${savePointId}`, { headers: { "x-remo-session-token": token } });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      }, SAVE_POINT_ID);
      expect(apiGet).toMatchObject({ status: 200, body: { savePointId: SAVE_POINT_ID, turnId: TURN_ID, integrity: { state: "Complete" } } });
      expect(await page.getByRole("link", { name: /Open exact source change/u }).getAttribute("href")).toBe(`https://github.com/example/remo/commit/${SOURCE_COMMIT}`);
      expect(await page.getByRole("link", { name: /Open authoritative trace/u }).getAttribute("href")).toBe(`https://traces.example.test/project/remo/traces/${TRACE_ID}`);

      const missing = await reconcile(page, "real-missing");
      expect(missing).toMatchObject({ savePointId: SAVE_POINT_ID, turnId: TURN_ID, integrity: { state: "Incomplete" } });
      await page.reload();
      await page.getByText("Missing", { exact: true }).waitFor();

      result = { status: "unreachable", reasonCode: "trace.authority-unreachable", validatedAt: "2026-08-16T10:11:00.000Z" };
      const unreachable = await reconcile(page, "real-unreachable");
      expect(unreachable).toMatchObject({ savePointId: SAVE_POINT_ID, integrity: { state: "Incomplete" }, traceValidatedAt: "2026-08-16T10:11:00.000Z" });

      result = { status: "conflicting", metadataTurnId: "01J000000000000000000000XX", validatedAt: "2026-08-16T10:12:00.000Z" };
      const conflicting = await reconcile(page, "real-conflicting");
      expect(conflicting).toMatchObject({ savePointId: SAVE_POINT_ID, integrity: { state: "Inconsistent" }, fidelity: { state: "Historical only" } });

      result = { status: "missing", validatedAt: "2026-08-16T10:13:00.000Z" };
      await reconcile(page, "real-degraded-before-recovery");
      await page.reload();
      const retry = page.getByRole("button", { name: "Retry trace correlation" });
      await retry.waitFor();
      lookupFailure = true;
      await retry.click();
      await page.locator(".detail-live").filter({ hasText: "Correlation remains unavailable" }).waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === "BUTTON" && document.activeElement.textContent?.includes("Retry trace correlation") === true);
      expect(await retry.evaluate((element) => element === document.activeElement)).toBe(true);
      lookupFailure = false;
      result = { status: "matching", metadataTurnId: TURN_ID, validatedAt: "2026-08-16T10:14:00.000Z" };
      await retry.click();
      await page.getByText("Complete", { exact: true }).waitFor();
      await page.locator(".detail-live").filter({ hasText: "Correlation updated" }).waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Trust summary");
      expect(await page.getByLabel("Trust summary").evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await page.getByText(SAVE_POINT_ID, { exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: /Retry trace correlation/u }).count()).toBe(0);

      await page.getByRole("button", { name: "Delete local evidence", exact: true }).click();
      const deleteDialog = page.getByRole("alertdialog", { name: "Delete controlled local evidence?" });
      await deleteDialog.getByRole("button", { name: "Delete local evidence", exact: true }).click();
      await page.locator(".detail-live").filter({ hasText: "Controlled local evidence deleted" }).waitFor();
      const operationalBytes = await readFile(join(projectRoot, ".remo", "operations", "vs001-operational.jsonl"), "utf8");
      const operationalEvents = operationalBytes.trim().split("\n").map((line) => {
        const parsed: unknown = JSON.parse(line);
        return parsed as { readonly operationId: string; readonly eventId: string; readonly sizes: Record<string, number>; readonly outcomes?: Record<string, string> };
      });
      const operations = operationalEvents.map(({ operationId }) => operationId);
      for (const operation of ["capture.register-candidate", "promotion.commit", "reconciliation.trace", "lifecycle.sweep", "lifecycle.delete"]) expect(operations).toContain(operation);
      expect(operationalEvents.every(({ eventId }) => /^vs001\./u.test(eventId))).toBe(true);
      expect(operationalEvents).toContainEqual(expect.objectContaining({ operationId: "reconciliation.trace", outcomes: { integrity: "incomplete" } }));
      const deleteEvent = operationalEvents.find(({ operationId }) => operationId === "lifecycle.delete");
      expect(deleteEvent?.outcomes?.deletion).toBe("deleted");
      expect(typeof deleteEvent?.sizes.deletionObservations).toBe("number");
      expect(operationalBytes).not.toMatch(/REMO_SECRET_CANARY_V1|payload|sourcePatch|domText|screenshotBytes|tracePayload|credential|secret/iu);
    } finally {
      await browser.close();
      await application.close();
    }
  }, 60_000);

  it.each([
    ["matching", { status: "matching", metadataTurnId: TURN_ID, validatedAt: "2026-08-16T10:20:00.000Z" }, "Complete", "Editable eligible"],
    ["missing", { status: "missing", validatedAt: "2026-08-16T10:20:00.000Z" }, "Incomplete", "Degraded"],
    ["unreachable", { status: "unreachable", reasonCode: "trace.authority-unreachable", validatedAt: "2026-08-16T10:20:00.000Z" }, "Incomplete", "Degraded"],
    ["conflicting", { status: "conflicting", metadataTurnId: "01J000000000000000000000XX", validatedAt: "2026-08-16T10:20:00.000Z" }, "Inconsistent", "Historical only"],
  ] as const)("reconstructs the authoritative %s revision after a real application restart", async (_label, lookupResult, integrity, fidelity) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "remo-t6-restart-matrix-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".git"));
    const traceLookup = { lookup: () => Promise.resolve(lookupResult) };
    const firstApplication = await startLocalApplication({ projectRoot, port: await freePort(), webRoot: isolatedWebRoot, traceLookup });
    const browser = await chromium.launch({ headless: true });
    let beforeRestart!: Record<string, unknown>;
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${firstApplication.origin}/candidate/review`);
      await page.getByRole("button", { name: "Confirm durable save" }).click();
      await page.getByRole("heading", { name: "Durable save created" }).waitFor();
      await page.goto(`${firstApplication.origin}/save-points/${SAVE_POINT_ID}`);
      await page.getByRole("heading", { name: /Save point/u }).waitFor();
      beforeRestart = await reconcile(page, `restart-${_label}`);
      expect(beforeRestart).toMatchObject({ savePointId: SAVE_POINT_ID, revision: 2, integrity: { state: integrity }, fidelity: { state: fidelity }, traceValidatedAt: "2026-08-16T10:20:00.000Z" });
    } finally {
      await browser.close();
      await firstApplication.close();
    }

    const restarted = await startLocalApplication({ projectRoot, port: await freePort(), webRoot: isolatedWebRoot, traceLookup });
    try {
      const response = await fetch(`${restarted.origin}/api/save-points/${SAVE_POINT_ID}`);
      const afterRestart = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(afterRestart).toMatchObject({ savePointId: SAVE_POINT_ID, turnId: TURN_ID, revision: 2, integrity: { state: integrity }, fidelity: { state: fidelity }, traceValidatedAt: "2026-08-16T10:20:00.000Z" });
      expect(afterRestart.manifestDigest).toBe(beforeRestart.manifestDigest);
      expect(await readdir(join(projectRoot, ".remo", "manifests", SAVE_POINT_ID))).toHaveLength(2);
      expect(await blobFileCount(join(projectRoot, ".remo", "blobs", "sha256"))).toBe(2);
    } finally {
      await restarted.close();
    }
    const repository = new LocalSavePointRepository({ projectRoot });
    expect(repository.countDurable()).toBe(1);
    expect(repository.getCurrentRevision(SAVE_POINT_ID)).toMatchObject({ revision: 2, manifestDigest: beforeRestart.manifestDigest, predecessorRevision: 1 });
    repository.close();
  }, 60_000);
});
