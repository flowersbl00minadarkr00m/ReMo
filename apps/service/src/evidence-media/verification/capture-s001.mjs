/* global document, fetch, HTMLElement, process, setTimeout */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../../../../..");
const fixtureDirectory = join(repoRoot, "apps/service/src/evidence-media/fixtures/s-001");
const fixturePackage = join(repoRoot, "packages/test-fixtures/vs001-ui");
const viteCli = join(fixturePackage, "node_modules/vite/bin/vite.js");
const captureModule = await import(pathToFileURL(join(repoRoot, "packages/capture-playwright/src/privacy/privacy-capture.ts")).href);
const fixtureModule = await import(pathToFileURL(join(repoRoot, "packages/test-fixtures/vs001-ui/src/fixture-contract.ts")).href);
const { chromium } = await import("playwright");

function run(command, args, cwd = repoRoot) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${String(code)}`)));
  });
}

async function waitForFixture(origin) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/fixture/save-point`);
      if (response.ok) return;
    } catch { /* The bounded local fixture is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("The exact S-001 fixture did not become ready.");
}

await run(process.execPath, [viteCli, "build"], fixturePackage);
const fixture = spawn(process.execPath, [viteCli, "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], { cwd: fixturePackage, stdio: "inherit", windowsHide: true });
const browser = await chromium.launch({ headless: true });
try {
  const contract = fixtureModule.FIXTURE_CONTRACT;
  await waitForFixture(contract.origin);
  const policy = {
    allowedOrigin: contract.origin,
    allowedPath: contract.route,
    captureRoot: contract.captureRoot,
    maskSelectors: ["[data-remo-sensitive]", "input", "textarea"],
    blockSelectors: ["[data-remo-block]"],
    forbiddenFields: ["clipboardData", "dataTransfer", "files", "rawKey"],
    canary: contract.privacyCanary,
    maskColor: "#7138d8",
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await captureModule.preparePrivacyRecorder(context, policy);
  await context.addInitScript({ content: "globalThis.__name = (target) => target;" });
  const page = await context.newPage();
  await page.goto(`${contract.origin}${contract.route}`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    document.head.querySelectorAll("script, link").forEach((element) => element.remove());
    const root = document.querySelector("[data-remo-fixture-root]");
    const blocked = document.querySelector("[data-remo-block]");
    if (!(root instanceof HTMLElement) || !(blocked instanceof HTMLElement)) throw new Error("The S-001 capture boundary is absent.");
    document.body.replaceChildren(root, blocked);
  });
  await captureModule.startPrivacyRecording(page, policy);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(1_200);
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(80);
  const result = await captureModule.collectPrivacyClearedEvidence({ page, policy, checkedAt: "2026-08-18T11:30:00.000Z" });
  if (result.status !== "passed") throw new Error(`S-001 privacy capture quarantined: ${result.receipt.reasonCodes.join(",")}`);
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(join(fixtureDirectory, "privacy-cleared.png"), result.evidence.screenshotBytes);
  await writeFile(join(fixtureDirectory, "privacy-cleared.rrweb.json"), result.evidence.rrwebBytes);
  const events = JSON.parse(result.evidence.rrwebBytes.toString("utf8"));
  await writeFile(join(fixtureDirectory, "capture-metadata.json"), `${JSON.stringify({
    fixture: { version: contract.fixtureVersion, origin: contract.origin, path: contract.route, viewport: { width: 1440, height: 900 } },
    privacyReceipt: result.evidence.receipt,
    eventCount: events.length,
    captureRuntime: { browser: await browser.version(), engine: "chromium", headless: true, reducedMotion: "reduce" },
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ event: "s001.actual-media.captured", eventCount: events.length, receipt: result.evidence.receipt, fixtureDirectory })}\n`);
  await context.close();
} finally {
  await browser.close();
  fixture.kill("SIGTERM");
}
