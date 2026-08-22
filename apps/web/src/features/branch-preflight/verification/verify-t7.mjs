/* global URL, document, getComputedStyle, HTMLElement, process, setTimeout */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { inspectBranchPreflightRepository } from "../../../../../../packages/evidence-git/src/index.ts";
import { runTenSaveSequence } from "../../../../../service/src/acceptance-sequence/ten-save-sequence.ts";
import { startLocalApplication } from "../../../../../service/src/promotion/local-application.ts";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../../../../..");
const WEB_ROOT = resolve(ROOT, "apps/web/dist");
const ORIGIN = "http://127.0.0.1:4175";
const REPLAY_ORIGIN = "http://127.0.0.1:4176";
const OUTPUT = resolve(process.env.REMO_T7_OUTPUT ?? join(ROOT, "output", "playwright", `t7-branch-preflight-${Date.now()}`));
const requireService = createRequire(resolve(ROOT, "apps/service/package.json"));
const { chromium } = requireService("playwright");
const playwrightVersion = requireService("playwright/package.json").version;
const VIEWPORTS = [
  { name: "320", width: 320, height: 720 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const git = async (cwd, args) => (await exec("git", ["--no-optional-locks", ...args], { cwd, windowsHide: true, timeout: 10_000, shell: false, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } })).stdout.trimEnd();

async function sourceInventory(root, directory = root) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) result[relative(root, path).replaceAll("\\", "/")] = "link";
    else if (entry.isDirectory()) Object.assign(result, await sourceInventory(root, path));
    else if (entry.isFile()) result[relative(root, path).replaceAll("\\", "/")] = sha256(await readFile(path));
  }
  return result;
}

async function immutableInventory(projectRoot, worktreeRoot) {
  const gitDirectory = resolve(projectRoot, await git(projectRoot, ["rev-parse", "--git-dir"]));
  const indexPath = join(gitDirectory, "index");
  const [indexBytes, indexMetadata] = await Promise.all([readFile(indexPath), stat(indexPath)]);
  return {
    branchRef: await git(projectRoot, ["symbolic-ref", "HEAD"]),
    head: await git(projectRoot, ["rev-parse", "HEAD"]),
    status: await git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
    refs: await git(projectRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)"]),
    worktrees: await git(projectRoot, ["worktree", "list", "--porcelain"]),
    index: { sha256: sha256(indexBytes), size: indexMetadata.size, mtimeMs: indexMetadata.mtimeMs, mode: indexMetadata.mode },
    source: await sourceInventory(join(projectRoot, "packages", "test-fixtures", "vs001-ui")),
    derivedRootEntries: await readdir(worktreeRoot).catch(() => []),
  };
}

function bindInventory(inventory) {
  return {
    branchRef: inventory.branchRef,
    head: inventory.head,
    statusDigest: sha256(inventory.status),
    refsDigest: sha256(inventory.refs),
    worktreesDigest: sha256(inventory.worktrees),
    index: inventory.index,
    approvedSourceTreeDigest: sha256(JSON.stringify(inventory.source)),
    approvedSourceFileCount: Object.keys(inventory.source).length,
    derivedRootEntriesDigest: sha256(JSON.stringify(inventory.derivedRootEntries)),
    derivedRootEntryCount: inventory.derivedRootEntries.length,
  };
}

function observeFailures(page, ledger, phase) {
  page.on("console", (message) => { if (message.type() === "error") ledger.console.push(`${message.text()} @ ${message.location().url || "unknown"}`); });
  page.on("pageerror", (error) => ledger.page.push(error.message));
  page.on("requestfailed", (request) => {
    const item = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`;
    if (phase.current === "cancel" && request.url().endsWith("/branch-preflight")) ledger.expectedCancellation.push(item);
    else ledger.request.push(item);
  });
  page.on("response", (response) => { if (response.status() >= 400) ledger.response.push(`${response.status()} ${response.request().method()} ${response.url()}`); });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" && url.origin !== ORIGIN && url.origin !== REPLAY_ORIGIN) ledger.crossOrigin.push(`${request.method()} ${request.url()}`);
  });
}

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(dimensions.scrollWidth <= dimensions.clientWidth, `${label} overflowed: ${JSON.stringify(dimensions)}`);
  return dimensions;
}

async function assertIntegrityLayout(page, label) {
  const layout = await page.locator(".branch-preflight-panel").evaluate((panel) => {
    const note = panel.querySelector(".branch-integrity-note");
    const confirmation = panel.querySelector(".branch-confirmation");
    if (!(note instanceof HTMLElement) || !(confirmation instanceof HTMLElement)) return undefined;
    const bounds = (element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }; };
    const style = getComputedStyle(note);
    return { panel: bounds(panel), note: bounds(note), confirmation: bounds(confirmation), gap: confirmation.getBoundingClientRect().top - note.getBoundingClientRect().bottom, noteClientWidth: note.clientWidth, noteScrollWidth: note.scrollWidth, borderLeftWidth: Number.parseFloat(style.borderLeftWidth), lineHeight: Number.parseFloat(style.lineHeight), fontSize: Number.parseFloat(style.fontSize), overflowWrap: style.overflowWrap };
  });
  assert(layout !== undefined, `${label} omitted the integrity note or confirmation boundary.`);
  assert(layout.note.left >= layout.panel.left && layout.note.right <= layout.panel.right, `${label} integrity note escaped its panel: ${JSON.stringify(layout)}`);
  assert(layout.confirmation.left >= layout.panel.left && layout.confirmation.right <= layout.panel.right, `${label} confirmation escaped its panel: ${JSON.stringify(layout)}`);
  assert(layout.gap >= 12, `${label} integrity note collided with confirmation: ${JSON.stringify(layout)}`);
  assert(layout.noteScrollWidth <= layout.noteClientWidth, `${label} integrity note overflowed: ${JSON.stringify(layout)}`);
  assert(layout.borderLeftWidth >= 4 && layout.lineHeight / layout.fontSize >= 1.4 && layout.overflowWrap === "anywhere", `${label} integrity note lost readable containment: ${JSON.stringify(layout)}`);
  return layout;
}

async function openSelected(page, savePointId) {
  await page.goto(`${ORIGIN}/replay/${savePointId}`, { waitUntil: "networkidle" });
  await page.locator(".selected-detail-state").waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "Branch from here" }).waitFor();
}

async function waitForPassingReceipt(page, label) {
  const heading = page.locator(".branch-preflight-panel h3");
  await heading.waitFor();
  await page.waitForFunction(() => document.querySelector(".branch-preflight-panel h3")?.textContent !== "Inspecting ten ordered checks");
  const text = await heading.textContent();
  if (text !== "Preflight passed") throw new Error(`${label} did not pass:\n${await page.locator(".branch-preflight-panel").innerText()}`);
  return heading;
}

const report = await runTenSaveSequence(ROOT);
const worktreeRoot = resolve(report.projectRoot, ".remo", "worktrees");
let application;
let browser;
try {
  await mkdir(OUTPUT, { recursive: true });
  let inspectionMode = "actual";
  let clockOffsetMs = 0;
  const inspect = async (options) => {
    await sleep(150);
    let observed;
    try { observed = await inspectBranchPreflightRepository(options); }
    catch (error) { process.stderr.write(`T7 inspector diagnostic: ${error instanceof Error ? error.stack : String(error)}\n`); throw error; }
    if (inspectionMode === "collision") return { ...observed, targetRefAbsent: false, reasonCodes: [...observed.reasonCodes, "preflight.target-ref-present-or-indeterminate"] };
    if (inspectionMode === "stale") return { ...observed, originalFuture: { ...observed.originalFuture, approvedSourceDigest: `sha256:${"c".repeat(64)}` } };
    return observed;
  };
  application = await startLocalApplication({ projectRoot: report.projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false, branchPreflightInspect: inspect, branchPreflightNow: () => new Date(Date.now() + clockOffsetMs) });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const failures = { console: [], page: [], request: [], response: [], crossOrigin: [], expectedCancellation: [] };
  const phase = { current: "pass" };
  observeFailures(page, failures, phase);
  const historyResponse = await page.request.get(`${ORIGIN}/api/history`);
  assert(historyResponse.ok(), `History API failed: ${historyResponse.status()}.`);
  const history = await historyResponse.json();
  const selected = history.anchors.find(({ sequenceNo, state }) => sequenceNo === 4 && state === "active") ?? history.anchors.find(({ state }) => state === "active");
  assert(selected !== undefined, "No active ten-save fixture exists for T7 verification.");

  const baseline = await immutableInventory(report.projectRoot, worktreeRoot);
  const captures = [];
  for (const viewport of VIEWPORTS) {
    phase.current = `pass-${viewport.name}`;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openSelected(page, selected.savePointId);
    await page.getByRole("button", { name: "Branch from here" }).click();
    const passed = await waitForPassingReceipt(page, `width ${viewport.name}`);
    assert(await page.locator(".branch-checks:not(.pending) > li").count() === 10, `${viewport.name} omitted a preflight check.`);
    assert(await page.locator(".branch-check-pass > span", { hasText: "Pass" }).count() === 10, `${viewport.name} lacks non-color pass labels.`);
    assert(await page.locator(".branch-identities code").count() >= 4, `${viewport.name} omitted safe identities.`);
    assert(await passed.evaluate((node) => document.activeElement === node), `${viewport.name} did not focus the result heading.`);
    const integrityLayout = await assertIntegrityLayout(page, viewport.name);
    const overflow = await assertNoOverflow(page, viewport.name);
    const file = resolve(OUTPUT, `t7-preflight-pass-${viewport.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    captures.push({ file, viewport, overflow, integrityLayout, sha256: sha256(await readFile(file)) });
    if (viewport.name === "1440") {
      await page.getByRole("button", { name: "Continue to confirmation boundary" }).click();
      await page.getByRole("status", { name: "Confirmation boundary ready" }).waitFor();
    }
  }
  const afterPass = await immutableInventory(report.projectRoot, worktreeRoot);
  assert(JSON.stringify(afterPass) === JSON.stringify(baseline), "Passing preflight changed Git, index metadata/bytes, worktrees, source, or derived-root inventory.");

  phase.current = "cancel";
  await openSelected(page, selected.savePointId);
  const beforeCancel = await immutableInventory(report.projectRoot, worktreeRoot);
  await page.getByRole("button", { name: "Branch from here" }).click();
  await page.getByRole("button", { name: "Cancel preflight" }).click();
  await page.getByRole("heading", { name: "Preflight cancelled" }).waitFor();
  await sleep(350);
  const afterCancel = await immutableInventory(report.projectRoot, worktreeRoot);
  assert(JSON.stringify(afterCancel) === JSON.stringify(beforeCancel), "Cancellation changed Git, index metadata/bytes, worktrees, source, or derived-root inventory.");

  phase.current = "expiry";
  clockOffsetMs = -31_000;
  await openSelected(page, selected.savePointId);
  const beforeExpiry = await immutableInventory(report.projectRoot, worktreeRoot);
  await page.getByRole("button", { name: "Branch from here" }).click();
  await page.getByRole("heading", { name: "Preflight expired" }).waitFor();
  assert(await page.locator(".branch-checks:not(.pending) > li").count() === 10, "Expiry discarded the check list.");
  assert(await page.getByRole("button", { name: "Run fresh preflight" }).count() === 1, "Expiry did not expose exactly one refresh action.");
  const afterExpiry = await immutableInventory(report.projectRoot, worktreeRoot);
  assert(JSON.stringify(afterExpiry) === JSON.stringify(beforeExpiry), "Expiry changed Git, index metadata/bytes, worktrees, source, or derived-root inventory.");
  clockOffsetMs = 0;

  phase.current = "stale";
  inspectionMode = "actual";
  await openSelected(page, selected.savePointId);
  const beforeStale = await immutableInventory(report.projectRoot, worktreeRoot);
  await page.getByRole("button", { name: "Branch from here" }).click();
  await waitForPassingReceipt(page, "stale setup");
  inspectionMode = "stale";
  await page.getByRole("button", { name: "Continue to confirmation boundary" }).click();
  await page.getByRole("heading", { name: "Preflight became stale" }).waitFor();
  assert(await page.locator(".branch-checks:not(.pending) > li").count() === 10, "Stale recovery discarded the check list.");
  const afterStale = await immutableInventory(report.projectRoot, worktreeRoot);
  assert(JSON.stringify(afterStale) === JSON.stringify(beforeStale), "Stale revalidation changed Git, index metadata/bytes, worktrees, source, or derived-root inventory.");

  phase.current = "collision";
  inspectionMode = "collision";
  await openSelected(page, selected.savePointId);
  const beforeCollision = await immutableInventory(report.projectRoot, worktreeRoot);
  await page.getByRole("button", { name: "Branch from here" }).click();
  await page.getByRole("heading", { name: "Preflight blocked" }).waitFor();
  const targetBlocker = page.locator(".branch-check-block", { hasText: "Derived target absence" });
  await targetBlocker.waitFor();
  assert(await targetBlocker.evaluate((node) => document.activeElement === node), "The first blocker did not receive focus.");
  const afterCollision = await immutableInventory(report.projectRoot, worktreeRoot);
  assert(JSON.stringify(afterCollision) === JSON.stringify(beforeCollision), "Collision handling changed Git, index metadata/bytes, worktrees, source, or derived-root inventory.");

  assert(failures.console.length === 0, `Unexpected console errors: ${JSON.stringify(failures.console)}`);
  assert(failures.page.length === 0, `Unexpected page errors: ${JSON.stringify(failures.page)}`);
  assert(failures.request.length === 0, `Unexpected request failures: ${JSON.stringify(failures.request)}`);
  assert(failures.response.length === 0, `Unexpected HTTP failures: ${JSON.stringify(failures.response)}`);
  assert(failures.crossOrigin.length === 0, `Unexpected cross-origin requests: ${JSON.stringify(failures.crossOrigin)}`);

  const ledger = {
    event: "t7.branch-preflight.actual-verification",
    occurredAt: new Date().toISOString(),
    truthLabel: "observed production build with simulated read-port drift/collision blockers",
    runtime: { node: process.version, playwright: playwrightVersion, origin: ORIGIN, output: OUTPUT.replaceAll("\\", "/") },
    selected: { savePointId: selected.savePointId, revision: selected.capturedThumbnail?.revision },
    checks: { canonicalCount: 10, expiryMs: 30_000, widths: VIEWPORTS.map(({ width }) => width), confirmationBoundary: "pass", integrityLayout: "pass", cancellation: "pass", expiryRecovery: "pass", staleRecovery: "pass", collisionBlocker: "pass" },
    immutability: { pass: true, cancel: true, expiry: true, stale: true, collision: true, includesRawIndexBytesAndMetadata: true },
    effectInventory: { before: bindInventory(baseline), after: bindInventory(afterCollision), equal: JSON.stringify(baseline) === JSON.stringify(afterCollision), protectedSurfaces: ["branch-ref", "HEAD", "status", "refs", "worktrees", "index-bytes-and-metadata", "approved-source-tree", "derived-worktree-root"] },
    failures,
    captures: captures.map((capture) => ({ ...capture, file: capture.file.replaceAll("\\", "/") })),
  };
  await writeFile(resolve(OUTPUT, "t7-acceptance-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ event: ledger.event, verdict: "PASS", output: ledger.runtime.output, captures: captures.length, immutability: ledger.immutability, failures })}\n`);
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (application !== undefined) await application.close().catch(() => undefined);
  await report.dispose().catch(() => undefined);
}
