/* global URL, document, matchMedia, process */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { inspectBranchPreflightRepository } from "../../../../../../packages/evidence-git/src/index.ts";
import { runTenSaveSequence } from "../../../../../service/src/acceptance-sequence/ten-save-sequence.ts";
import { startLocalApplication } from "../../../../../service/src/promotion/local-application.ts";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const WEB_ROOT = resolve(ROOT, "apps/web/dist");
const ORIGIN = "http://127.0.0.1:4175";
const OUTPUT = resolve(process.env.REMO_T9_OUTPUT ?? resolve(ROOT, "output", "playwright", `t9-branch-orchestration-r2-${Date.now()}`));
const requireService = createRequire(resolve(ROOT, "apps/service/package.json"));
const { chromium } = requireService("playwright");
const run = promisify(execFile);
const VIEWPORTS = [
  { name: "320", width: 320, height: 720 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function cloneFixture(source, parent, name) {
  const target = join(parent, name);
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  return target;
}

async function inventory(root) {
  const refs = (await run("git", ["-C", root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/remo"], { windowsHide: true })).stdout.trim().split(/\r?\n/u).filter(Boolean);
  const worktrees = (await run("git", ["-C", root, "worktree", "list", "--porcelain"], { windowsHide: true })).stdout.match(/^worktree /gmu)?.length ?? 0;
  const database = new DatabaseSync(join(root, ".remo", "catalog.sqlite"), { readOnly: true });
  try {
    const branchOperations = database.prepare("SELECT operation_id, state FROM branch_operations ORDER BY operation_id").all();
    const lineages = database.prepare("SELECT lineage_id, state FROM lineages ORDER BY lineage_id").all();
    return { refs, worktrees, branchOperations, lineages };
  } finally { database.close(); }
}

const report = await runTenSaveSequence(ROOT);
const fixtureParent = await mkdtemp(join(tmpdir(), "remo-t9-browser-r2-"));
const failingRoot = await cloneFixture(report.projectRoot, fixtureParent, "failing-preflight");
const recoveryRoot = await cloneFixture(report.projectRoot, fixtureParent, "recovery");
let createCalls = 0;
let observeMode = "exact";
const successAdapter = {
  async createLockedWorktree() { createCalls += 1; return { outcome: "succeeded", evidence: { fixture: "contract-fake-browser-success", realGitProof: false } }; },
  async observeExistingTarget() {
    return observeMode === "exact"
      ? { outcome: "exact-success", evidence: { fixture: "contract-fake-browser-existing-target", realGitProof: false } }
      : { outcome: "recovery-required", reasonCodes: ["git.existing-target-ref-head-mismatch"], observed: { fixture: "contract-fake-browser-drift", realGitProof: false } };
  },
};

let application;
let browser;
try {
  await mkdir(OUTPUT, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const failures = { console: [], page: [], requestfailed: [], response: [], crossOrigin: [] };
  page.on("console", (message) => { if (message.type() === "error") failures.console.push(message.text()); });
  page.on("pageerror", (error) => failures.page.push(error.message));
  page.on("requestfailed", (request) => failures.requestfailed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`));
  page.on("response", (response) => { if (response.status() >= 400) failures.response.push(`${response.status()} ${response.request().method()} ${response.url()}`); });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" && url.origin !== ORIGIN && url.origin !== "http://127.0.0.1:4176") failures.crossOrigin.push(`${request.method()} ${request.url()}`);
  });

  application = await startLocalApplication({ projectRoot: report.projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false, branchGitAdapter: successAdapter });
  const history = await (await page.request.get(`${ORIGIN}/api/history`)).json();
  const active = history.anchors.filter(({ state }) => state === "active");
  assert(active.length >= 3, "S-005 requires three active save points for joined states.");
  const successId = active[0].savePointId;
  await page.goto(`${ORIGIN}/replay/${successId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Branch from here" }).click();
  await page.getByRole("heading", { name: "Preflight passed" }).waitFor();
  await page.getByRole("button", { name: "Confirm and create alternate lineage" }).click();
  await page.getByText("Alternate lineage verified").waitFor();
  await page.getByRole("button", { name: "Original future" }).click();
  await page.getByText("Viewing the preserved original lineage.").waitFor();
  await page.getByRole("button", { name: "Alternate future" }).click();
  await page.getByText(/Alternate lineage root context/u).waitFor();
  assert(new URL(page.url()).searchParams.get("lineage")?.startsWith("lineage:alternate:"), "Alternate selection URL omitted its lineage identity.");
  const selectedText = await page.locator(".selected-turn").innerText();
  assert(selectedText.includes("no alternate evidence was invented"), "Alternate root provenance was not explicit.");
  assert(!selectedText.includes("Original lineage ·"), "Alternate context contradicted itself with an original-lineage label.");
  assert(await page.getByRole("button", { name: "Previous turn" }).isDisabled(), "Alternate root exposed invalid previous transport.");
  assert(await page.getByRole("button", { name: "Next turn" }).isDisabled(), "Alternate root exposed invalid next transport.");
  assert(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), "Reduced-motion browser contract was not active.");

  const captures = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(dimensions.scrollWidth <= dimensions.clientWidth, `${viewport.name} has document overflow: ${JSON.stringify(dimensions)}`);
    const path = resolve(OUTPUT, `t9-r2-alternate-${viewport.name}.png`);
    await page.screenshot({ path, fullPage: true });
    captures.push({ state: "succeeded-alternate-selected", viewport, path, sha256: sha256(await readFile(path)), dimensions });
  }

  await application.close(); application = undefined;
  application = await startLocalApplication({ projectRoot: report.projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false, branchGitAdapter: successAdapter });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${ORIGIN}/replay/${successId}`, { waitUntil: "networkidle" });
  await page.getByText("Alternate lineage verified").waitFor();
  assert(createCalls === 1, `Durable hydration retried creation; observed ${createCalls} calls.`);
  const hydrationPath = resolve(OUTPUT, "t9-r2-durable-hydration-1024.png");
  await page.screenshot({ path: hydrationPath, fullPage: true });
  captures.push({ state: "durable-startup-hydration", viewport: { name: "1024", width: 1024, height: 768 }, path: hydrationPath, sha256: sha256(await readFile(hydrationPath)) });

  await application.close(); application = undefined; observeMode = "drift";
  application = await startLocalApplication({ projectRoot: report.projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false, branchGitAdapter: successAdapter });
  await page.goto(`${ORIGIN}/replay/${successId}`, { waitUntil: "networkidle" });
  await page.getByText("Alternate lineage unavailable").waitFor();
  await page.getByText(/git\.existing-target-ref-head-mismatch/u).waitFor();
  assert(await page.getByRole("button", { name: "Alternate future" }).isDisabled(), "Drifted alternate remained navigable.");
  const unavailablePath = resolve(OUTPUT, "t9-r2-drifted-unavailable-390.png");
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: unavailablePath, fullPage: true });
  captures.push({ state: "drifted-unavailable", viewport: { name: "390", width: 390, height: 844 }, path: unavailablePath, sha256: sha256(await readFile(unavailablePath)) });
  await application.close(); application = undefined;

  let failingCreateCalls = 0;
  const failingAdapter = { async createLockedWorktree() { failingCreateCalls += 1; return { outcome: "succeeded", evidence: {} }; }, async observeExistingTarget() { return { outcome: "absent", reasonCodes: ["git.existing-target-absent"], observed: {} }; } };
  const failingInspect = async (options) => { const observed = await inspectBranchPreflightRepository(options); return { ...observed, targetRefAbsent: false }; };
  application = await startLocalApplication({ projectRoot: failingRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false, branchGitAdapter: failingAdapter, branchPreflightInspect: failingInspect });
  const beforeFailure = await inventory(failingRoot);
  await page.goto(`${ORIGIN}/replay/${active[1].savePointId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Branch from here" }).click();
  await page.getByRole("heading", { name: "Preflight blocked" }).waitFor();
  const afterFailure = await inventory(failingRoot);
  assert(JSON.stringify(afterFailure) === JSON.stringify(beforeFailure), `Failing preflight changed ref/worktree/lineage inventory: ${JSON.stringify({ beforeFailure, afterFailure })}`);
  assert(failingCreateCalls === 0, "Failing preflight invoked Git mutation.");
  const blockedPath = resolve(OUTPUT, "t9-r2-failing-preflight-390.png");
  await page.screenshot({ path: blockedPath, fullPage: true });
  captures.push({ state: "failing-preflight-zero-effect", viewport: { name: "390", width: 390, height: 844 }, path: blockedPath, sha256: sha256(await readFile(blockedPath)), before: beforeFailure, after: afterFailure });
  await application.close(); application = undefined;

  let recoveryCreateCalls = 0;
  const recoveryAdapter = { async createLockedWorktree() { recoveryCreateCalls += 1; return { outcome: "recovery-required", reasonCodes: ["branch.fixture-partial-effect"], observed: { fixture: "contract-fake-browser-recovery", realGitProof: false } }; }, async observeExistingTarget() { return { outcome: "recovery-required", reasonCodes: ["branch.fixture-partial-effect"], observed: {} }; } };
  application = await startLocalApplication({ projectRoot: recoveryRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false, branchGitAdapter: recoveryAdapter });
  await page.goto(`${ORIGIN}/replay/${active[2].savePointId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Branch from here" }).click();
  await page.getByRole("heading", { name: "Preflight passed" }).waitFor();
  await page.getByRole("button", { name: "Confirm and create alternate lineage" }).click();
  await page.getByText("Recovery required").waitFor();
  await page.getByText(/branch\.fixture-partial-effect/u).waitFor();
  assert(recoveryCreateCalls === 1, `Recovery scenario observed ${recoveryCreateCalls} mutation calls.`);
  const recoveryPath = resolve(OUTPUT, "t9-r2-recovery-required-390.png");
  await page.screenshot({ path: recoveryPath, fullPage: true });
  captures.push({ state: "recovery-required", viewport: { name: "390", width: 390, height: 844 }, path: recoveryPath, sha256: sha256(await readFile(recoveryPath)) });

  assert(failures.console.length === 0 && failures.page.length === 0 && failures.requestfailed.length === 0 && failures.response.length === 0 && failures.crossOrigin.length === 0, `Unexpected browser evidence: ${JSON.stringify(failures)}`);
  const ledger = {
    event: "s005.branch-orchestration.r2-browser-verification", verdict: "PASS", acceptanceClaim: "joined-browser-seam",
    realGitCrashProof: { source: "serial Windows child-process integration suite", browserFixtureDoesNotClaimRealGit: true },
    browserAdapterProvenance: "explicit contract fake for joined UI/service/storage behavior",
    scenarios: ["confirmed-success", "original-alternate-original-navigation", "durable-startup-hydration", "failing-preflight-zero-effect", "recovery-required", "succeeded-target-drift-unavailable"],
    output: OUTPUT, createCalls, failingCreateCalls, recoveryCreateCalls, failures, captures,
  };
  await writeFile(resolve(OUTPUT, "s005-r2-acceptance-ledger.json"), JSON.stringify(ledger, null, 2));
  process.stdout.write(`${JSON.stringify(ledger)}\n`);
} finally {
  await browser?.close();
  await application?.close();
  await rm(fixtureParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(report.projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
