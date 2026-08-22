import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTenSaveApplication } from "./ten-save-application.js";

const projectRoot = resolve(import.meta.dirname, "../../../..");
const trackedVerificationRoot = resolve(projectRoot, "apps/web/src/features/saved-results/verification");
const refreshTrackedEvidence = process.env.REMO_REFRESH_TRACKED_EVIDENCE === "1";
let verificationRoot = trackedVerificationRoot;
let trackedEvidenceBefore: readonly Buffer[] = [];
let application: Awaited<ReturnType<typeof startTenSaveApplication>>;

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

beforeAll(async () => {
  execFileSync(process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "pnpm", process.platform === "win32" ? ["/d", "/s", "/c", "pnpm --dir apps/web build"] : ["--dir", "apps/web", "build"], { cwd: projectRoot, env: { ...process.env, NODE_ENV: "production" }, stdio: "pipe", windowsHide: true, timeout: 120_000 });
  trackedEvidenceBefore = await Promise.all(["t8-saved-results-desktop.png", "t8-saved-results-mobile.png"].map((name) => readFile(resolve(trackedVerificationRoot, name))));
  verificationRoot = refreshTrackedEvidence ? trackedVerificationRoot : await mkdtemp(join(tmpdir(), "remo-ten-save-evidence-"));
  await mkdir(verificationRoot, { recursive: true });
  application = await startTenSaveApplication({ projectRoot, webRoot: resolve(projectRoot, "apps/web/dist"), port: await freePort() });
}, 240_000);

afterAll(async () => {
  await application?.close();
  if (!refreshTrackedEvidence && verificationRoot !== trackedVerificationRoot) await rm(verificationRoot, { recursive: true, force: true });
});

describe("ten-save saved-results browser acceptance", () => {
  it("renders live repository state, sorts, opens, and remains responsive", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const consoleErrors: string[] = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      await page.goto(`${application.origin}/save-points`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      const firstText = await page.locator("body").innerText();
      expect(firstText, `body=${firstText}\nconsole=${consoleErrors.join("\n")}`).toContain("Saved results");
      await page.getByRole("heading", { name: "Saved results" }).waitFor({ state: "visible" });
      expect(await page.getByRole("row").count()).toBe(10);
      expect(await page.locator("body").innerText()).not.toContain("SP-006");
      expect((await fetch(`${application.origin}/api/save-points`)).status).toBe(200);
      const deletedResponse = await fetch(`${application.origin}/save-points/01J00000000000000000000S06`);
      const deletedHtml = await deletedResponse.text();
      expect(deletedResponse.status).toBe(200);
      expect(deletedHtml).toContain('<div id="root"></div>');
      expect(deletedHtml).toContain('"state":"missing"');
      expect(deletedHtml).not.toContain("__REMO_SAVE_POINT__");
      expect(deletedHtml).not.toContain("__REMO_SAVE_POINT_SESSION__");
      expect(deletedHtml).not.toContain("javascript:raw-descriptor");
      expect(await page.locator(".app-main").innerText()).not.toMatch(/timeline|transport|rewind|replay|branch|comparison|production[- ]scale|sustainability/iu);
      await page.getByLabel("Sort by").selectOption("turn");
      await page.getByRole("button", { name: "Sort descending" }).focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("tbody tr")?.textContent?.includes("SP-010") === true);
      await page.screenshot({ path: resolve(verificationRoot, "t8-saved-results-desktop.png"), fullPage: false });
      await page.getByRole("link", { name: "Open SP-010" }).click();
      await page.waitForURL(/\/save-points\/01J00000000000000000000S10$/u);
      await page.getByRole("heading", { name: "Save point SP-010" }).waitFor({ state: "visible" });
      await page.goto(`${application.origin}/save-points`, { waitUntil: "domcontentloaded" });
      await page.setViewportSize({ width: 360, height: 844 });
      expect(await page.getByRole("row").count()).toBe(10);
      await page.getByRole("link", { name: "Open SP-001" }).waitFor({ state: "visible" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: resolve(verificationRoot, "t8-saved-results-mobile.png"), fullPage: false });
      expect(consoleErrors).toEqual([]);
      if (!refreshTrackedEvidence) {
        expect(verificationRoot).not.toBe(trackedVerificationRoot);
        const trackedEvidenceAfter = await Promise.all(["t8-saved-results-desktop.png", "t8-saved-results-mobile.png"].map((name) => readFile(resolve(trackedVerificationRoot, name))));
        expect(trackedEvidenceAfter).toEqual(trackedEvidenceBefore);
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});
