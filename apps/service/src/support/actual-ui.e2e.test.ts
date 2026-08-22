import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTenSaveApplication } from "../acceptance-sequence/ten-save-application.js";
import { startLocalApplication } from "../promotion/local-application.js";
import { serializeDiagnosticEvent } from "./diagnostic-event.js";
import { runSupportCommand } from "./support-command.js";

const projectRoot = resolve(import.meta.dirname, "../../../..");
const artifactsRoot = resolve(projectRoot, "tests/e2e/vs001/artifacts");
const webRoot = resolve(projectRoot, "apps/web/dist");
const CANARY = "REMO_SECRET_CANARY_V1";
const SAVE_POINT_ID = "01J000000000000000000000S5";

let browser: Browser;
let preview: { readonly origin: string; readonly close: () => Promise<void> };
let candidateApplication: Awaited<ReturnType<typeof startLocalApplication>>;
let tenSaveApplication: Awaited<ReturnType<typeof startTenSaveApplication>>;
let candidateRoot: string;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback port");
  server.close();
  await once(server, "close");
  return address.port;
}

async function startPreview(port: number): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const origin = `http://127.0.0.1:${port}`;
  const executable = process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "pnpm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`]
    : ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
  const child: ChildProcess = spawn(executable, args, { cwd: resolve(projectRoot, "apps/web"), env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Web preview exited ${child.exitCode}. ${output}`);
    try { if ((await fetch(`${origin}/boundary/setup`)).ok) break; } catch { /* bounded readiness retry */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (Date.now() >= deadline) throw new Error(`Web preview did not become ready. ${output}`);
  return {
    origin,
    async close() {
      if (child.exitCode === null && process.platform === "win32" && child.pid !== undefined) {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      } else if (child.exitCode === null) child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
    },
  };
}

async function assertResponsive(page: Page, width: 360 | 390, height = 844): Promise<void> {
  await page.setViewportSize({ width, height });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

function observeConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function canaryFiles(root: string): Promise<string[]> {
  const findings: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(child);
      else if ((await readFile(child)).includes(Buffer.from(CANARY))) findings.push(entry.name);
    }
  };
  await visit(root);
  return findings;
}

beforeAll(async () => {
  if (process.env.REMO_T9_ACTUAL_UI !== "1") return;
  execFileSync(process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "pnpm", process.platform === "win32" ? ["/d", "/s", "/c", "pnpm --dir apps/web build"] : ["--dir", "apps/web", "build"], { cwd: projectRoot, stdio: "pipe", windowsHide: true, timeout: 120_000 });
  await mkdir(artifactsRoot, { recursive: true });
  candidateRoot = await mkdtemp(join(tmpdir(), "remo-t9-candidate-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: candidateRoot, stdio: "pipe", windowsHide: true });
  preview = await startPreview(await freePort());
  candidateApplication = await startLocalApplication({ projectRoot: candidateRoot, webRoot, port: await freePort(), now: () => new Date("2026-08-16T12:00:00.000Z"), lifecycleSweepEveryMs: 60 * 60 * 1000 });
  tenSaveApplication = await startTenSaveApplication({ projectRoot, webRoot, port: await freePort() });
  browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await tenSaveApplication?.close().catch(() => undefined);
  await candidateApplication?.close().catch(() => undefined);
  await preview?.close().catch(() => undefined);
  if (candidateRoot !== undefined) await rm(candidateRoot, { recursive: true, force: true });
});

describe.skipIf(process.env.REMO_T9_ACTUAL_UI !== "1")("VS-001 T9 actual application acceptance", () => {
  it("captures boundary and candidate states with keyboard, focus, live-region, 360px, and 390px evidence", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = observeConsole(page);
    try {
      await page.goto(`${preview.origin}/boundary/setup`, { waitUntil: "domcontentloaded" });
      expect(await page.title()).toBe("ReMo boundary setup");
      await page.getByRole("heading", { name: "Configure capture boundary" }).waitFor();
      const preflight = page.getByRole("button", { name: "Run preflight" });
      await preflight.focus();
      await page.keyboard.press("Enter");
      await page.getByText("All mandatory checks pass. Recording is still off.").waitFor();
      expect(await page.getByRole("button", { name: "Start bounded turn" }).isDisabled()).toBe(true);
      await page.screenshot({ path: resolve(artifactsRoot, "t9-boundary-desktop.png"), fullPage: true });
      await assertResponsive(page, 390);
      await page.screenshot({ path: resolve(artifactsRoot, "t9-boundary-mobile-390.png"), fullPage: true });
      await assertResponsive(page, 360);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${candidateApplication.origin}/candidate/review`, { waitUntil: "domcontentloaded" });
      expect(await page.title()).toBe("ReMo candidate review");
      await page.getByRole("heading", { name: "Candidate — not yet saved" }).waitFor();
      for (const width of [1440, 390] as const) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        const discard = page.getByRole("button", { name: "Discard" });
        await discard.focus();
        await page.keyboard.press("Enter");
        const discardDialog = page.getByRole("alertdialog", { name: "Discard this candidate?" });
        await discardDialog.waitFor();
        expect(await discardDialog.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Keep candidate");
        await page.keyboard.press("Shift+Tab");
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Discard safely");
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Keep candidate");
        await page.keyboard.press("Escape");
        expect(await discardDialog.count()).toBe(0);
        expect(await discard.evaluate((element) => element === document.activeElement)).toBe(true);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const confirm = page.getByRole("button", { name: "Confirm durable save" });
      expect(await confirm.isEnabled()).toBe(true);
      await page.screenshot({ path: resolve(artifactsRoot, "t9-candidate-desktop.png"), fullPage: true });
      await assertResponsive(page, 390);
      await page.screenshot({ path: resolve(artifactsRoot, "t9-candidate-mobile-390.png"), fullPage: true });
      await assertResponsive(page, 360);
      await page.setViewportSize({ width: 1440, height: 900 });
      await confirm.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Durable save created" }).waitFor();
      expect(await page.getByRole("status").innerText()).toContain("Durable save created with identity");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Review candidate");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 120_000);

  it("captures durable detail, lifecycle, and saved results while proving scope and canary isolation", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = observeConsole(page);
    try {
      await page.goto(`${candidateApplication.origin}/save-points/${SAVE_POINT_ID}`, { waitUntil: "domcontentloaded" });
      expect(await page.title()).toBe("ReMo evidence detail");
      await page.getByRole("heading", { name: /Save point SP-005/u }).waitFor();
      await page.screenshot({ path: resolve(artifactsRoot, "t9-durable-detail-desktop.png"), fullPage: true });
      const deleteButton = page.getByRole("button", { name: "Delete local evidence", exact: true });
      await deleteButton.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("alertdialog", { name: "Delete controlled local evidence?" });
      await dialog.waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("alertdialog");
      await page.screenshot({ path: resolve(artifactsRoot, "t9-lifecycle-desktop.png"), fullPage: true });
      await page.getByRole("button", { name: "Cancel" }).click();
      expect(await deleteButton.evaluate((element) => element === document.activeElement)).toBe(true);
      await assertResponsive(page, 390);
      await page.screenshot({ path: resolve(artifactsRoot, "t9-durable-detail-mobile-390.png"), fullPage: true });
      await assertResponsive(page, 360);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${tenSaveApplication.origin}/save-points`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Saved results" }).waitFor();
      expect(await page.getByRole("row").count()).toBe(10);
      await page.getByLabel("Sort by").selectOption("turn");
      const descending = page.getByRole("button", { name: "Sort descending" });
      await descending.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("tbody tr")?.textContent?.includes("SP-010") === true);
      await page.screenshot({ path: resolve(artifactsRoot, "t9-saved-results-desktop.png"), fullPage: true });
      await assertResponsive(page, 390);
      await page.screenshot({ path: resolve(artifactsRoot, "t9-saved-results-mobile-390.png"), fullPage: true });
      await assertResponsive(page, 360);
      await page.screenshot({ path: resolve(artifactsRoot, "t9-saved-results-mobile-360.png"), fullPage: true });

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${tenSaveApplication.origin}${tenSaveApplication.report.summaries.at(-1)?.stablePath}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: /Save point SP-010/u }).waitFor();
      const interactiveNames = await page.getByRole("button").allTextContents();
      interactiveNames.push(...await page.getByRole("link").allTextContents());
      // VS-002 FR-022, design §4.11 / TD-010, and integrated T1 approve Replay and Compare; Later destinations remain guarded.
      expect(interactiveNames.join(" ")).not.toMatch(/rewind|timeline|branch|document|telemetry/iu);
      for (const path of ["/rewind", "/timeline", "/branches", "/documents", "/api/telemetry"]) {
        expect((await fetch(`${tenSaveApplication.origin}${path}`)).status).toBe(404);
      }

      const support = await runSupportCommand({ projectRoot: tenSaveApplication.report.projectRoot, probeLangfuse: () => Promise.resolve(true) });
      const supportOutput = support.map(serializeDiagnosticEvent).join("\n");
      expect(supportOutput).not.toContain(CANARY);
      expect(support.every(({ result }) => result === "pass")).toBe(true);
      expect(await canaryFiles(resolve(tenSaveApplication.report.projectRoot, ".remo"))).toEqual([]);
      expect(await canaryFiles(artifactsRoot)).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 180_000);
});
