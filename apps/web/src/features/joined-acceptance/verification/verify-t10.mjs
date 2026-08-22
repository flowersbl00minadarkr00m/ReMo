/* global document, fetch, process, URL */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { buildDecisionRecord } from "../../../../../../packages/domain/src/index.ts";
import { LocalSavePointRepository } from "../../../../../../packages/storage-local/src/index.ts";
import { runTenSaveSequence } from "../../../../../service/src/acceptance-sequence/ten-save-sequence.ts";
import { createDecisionService } from "../../../../../service/src/decisions/decision-service.ts";
import { startLocalApplication } from "../../../../../service/src/promotion/local-application.ts";
import { createJoinedRequestLifecycle } from "./joined-request-lifecycle.mjs";
import { prepareJoinedVerification } from "./production-build-preflight.mjs";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const WEB_ROOT = resolve(ROOT, "apps/web/dist");
const OUTPUT = resolve(process.env.REMO_T10_OUTPUT ?? resolve(ROOT, "artifacts/verification/vs002/T10/joined"));
const ORIGIN = "http://127.0.0.1:4175";
const RUNTIME_ORIGIN = "http://127.0.0.1:4176";
const run = promisify(execFile);
const requireService = createRequire(resolve(ROOT, "apps/service/package.json"));
const { chromium } = requireService("playwright");
const playwrightVersion = requireService("playwright/package.json").version;
const viewports = [
  { name: "320", width: 320, height: 720 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
];
const ids = (turn) => ({ turnId: `01J00000000000000000000T${String(turn).padStart(2, "0")}`, savePointId: `01J00000000000000000000S${String(turn).padStart(2, "0")}` });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const field = (value, provenance, sourceComponentIds, recordedAt) => ({ value, provenance, sourceComponentIds, recordedAt });
const unknown = (recordedAt) => ({ provenance: "unknown", sourceComponentIds: [], recordedAt });
const git = async (cwd, args) => (await run("git", ["-C", cwd, ...args], { windowsHide: true })).stdout.trimEnd();
const portable = (path) => {
  const pointer = relative(ROOT, path).replaceAll("\\", "/");
  return pointer === "" || pointer === ".." || pointer.startsWith("../") ? `volatile-output:${basename(path)}` : pointer;
};
const repositoryPointer = (root, path) => {
  const pointer = relative(root, path).replaceAll("\\", "/");
  assert(pointer !== "" && pointer !== ".." && !pointer.startsWith("../"), `Git evidence escaped the disposable repository: ${pointer}`);
  return pointer;
};

async function originalFuture(root) {
  const ref = await git(root, ["symbolic-ref", "HEAD"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const indexPath = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const index = await readFile(indexPath);
  const sourceStatus = await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", "packages/test-fixtures/vs001-ui"]);
  const approved = await git(root, ["ls-files", "-z", "packages/test-fixtures/vs001-ui"]);
  const source = await git(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "packages/test-fixtures/vs001-ui"]);
  return { ref, head, indexDigest: sha256(index), sourceStatus, approvedSourceDigest: sha256(`${approved}\0${source}`) };
}

function seedTurn4Decision(report) {
  const stamp = "2026-08-16T08:04:00.000Z";
  const turn4 = ids(4);
  const evidence = report.promotionEvidence.find(({ turnId }) => turnId === turn4.turnId)?.evidence.map(({ componentId }) => componentId);
  assert(evidence !== undefined, "Turn 4 evidence authority is missing.");
  const repository = new LocalSavePointRepository({ projectRoot: report.projectRoot, now: () => new Date(stamp) });
  try {
    const record = buildDecisionRecord({
      decisionId: "decision-turn-4", ...turn4, revision: 1,
      question: field("Should the navigation hierarchy change at this boundary?", "user-supplied", [], stamp),
      options: field([{ id: "adopt", label: "Adopt the revised hierarchy" }, { id: "retain", label: "Keep the prior hierarchy" }], "user-supplied", [], stamp),
      selectedOptionId: field("adopt", "user-supplied", [], stamp),
      owner: field("UI supervisor", "user-supplied", [], stamp),
      uncertainty: field({ level: "low", source: "human" }, "user-supplied", [], stamp),
      evidenceComponentIds: [evidence[1], evidence[5]],
      expectedEffect: field("The revised hierarchy should make the primary destination easier to find.", "inferred", [evidence[1]], stamp),
      verification: field("Verify keyboard order, responsive layout, and the selected destination.", "user-supplied", [evidence[5]], stamp),
      outcome: unknown(stamp),
    });
    repository.appendDecisionRevision({ savePointId: turn4.savePointId, turnId: turn4.turnId, revision: 1, canonicalRecord: record, expectedDigest: record.digest, recordedAt: stamp });
    const identity = (savePointId) => {
      const anchor = repository.listHistory().anchors.find((candidate) => candidate.savePointId === savePointId && candidate.state === "active");
      return anchor === undefined ? undefined : { savePointId, turnId: anchor.turnId, evidenceComponentIds: evidence };
    };
    createDecisionService({ repository, findCandidate: () => undefined, findDurable: identity, now: () => new Date("2026-08-16T08:31:00.000Z") })
      .revise(turn4.savePointId, { expectedRevision: 1, mutation: "confirm-inferred", fields: ["expectedEffect"] });
  } finally {
    repository.close();
  }
}

function telemetry(page, requestLifecycle) {
  const value = { consoleErrors: [], pageErrors: [], requestFailures: [], unexpectedNetwork: [] };
  page.on("console", (message) => { if (message.type() === "error") value.consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => value.pageErrors.push(error.message));
  page.on("requestfinished", (request) => requestLifecycle.requestFinished(request));
  page.on("requestfailed", (request) => {
    requestLifecycle.requestFailed(request);
    value.requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
  });
  page.on("request", (request) => {
    requestLifecycle.requestStarted(request);
    const url = new URL(request.url());
    if (url.protocol === "http:" && url.origin !== ORIGIN && url.origin !== RUNTIME_ORIGIN) value.unexpectedNetwork.push(request.url());
  });
  return value;
}

async function removeDisposableFixture(root) {
  const resolvedRoot = resolve(root);
  assert(resolve(resolvedRoot, "..") === resolve(tmpdir()) && basename(resolvedRoot).startsWith("remo-t8-ten-save-"), `Refusing joined cleanup outside the exact disposable fixture root: ${resolvedRoot}`);
  await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function waitForVisibleReplay(page) {
  const runtimeFrame = page.frames().find((frame) => frame.url() === `${RUNTIME_ORIGIN}/runtime`);
  assert(runtimeFrame !== undefined, "The isolated replay runtime frame is missing.");
  await runtimeFrame.waitForFunction(() => {
    const root = document.querySelector("#replay-root");
    const nested = document.querySelector("iframe.remo-reconstruction-frame");
    const nestedText = nested?.tagName === "IFRAME" ? nested.contentDocument?.body?.innerText ?? "" : "";
    return root?.getAttribute("data-runtime-state") === "ready"
      && root.getAttribute("data-full-snapshot-rebuilt") === "true"
      && root.getAttribute("data-paint-boundary-confirmed") === "true"
      && root.getAttribute("data-visible-content-confirmed") === "true"
      && nestedText.includes("Save point evidence");
  }, undefined, { timeout: 10_000 });
}

async function sampleCount(page) {
  return Number(await page.getByLabel("Replay performance samples").getAttribute("data-sample-count"));
}

async function waitForExactSampleAfter(page, expectedCommand, before) {
  await page.waitForFunction(({ count, commandName }) => {
    const output = document.querySelector('[aria-label="Replay performance samples"]');
    return Number(output?.getAttribute("data-sample-count")) > count
      && output?.getAttribute("data-latest-command") === commandName;
  }, { count: before, commandName: expectedCommand });
}

async function performAndAwaitSample(page, expectedCommand, command) {
  const before = await sampleCount(page);
  await command();
  await waitForExactSampleAfter(page, expectedCommand, before);
}

async function performPlayAndCausalPause(page) {
  const before = await sampleCount(page);
  const pauseAtPlaySample = page.waitForFunction(({ count }) => {
    const output = document.querySelector('[aria-label="Replay performance samples"]');
    const currentCount = Number(output?.getAttribute("data-sample-count"));
    if (currentCount <= count || output?.getAttribute("data-latest-command") !== "play") return false;
    const pauseButtons = [...document.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === "Pause");
    if (pauseButtons.length !== 1 || pauseButtons[0].disabled) return false;
    pauseButtons[0].click();
    return currentCount;
  }, { count: before }, { polling: "raf" });
  await page.getByRole("button", { name: /Start replay|Resume replay/u }).click();
  const playSampleHandle = await pauseAtPlaySample;
  const playSampleCount = await playSampleHandle.jsonValue();
  await playSampleHandle.dispose();
  assert(typeof playSampleCount === "number", "Joined play sample count was not numeric.");
  await waitForExactSampleAfter(page, "pause", playSampleCount);
  await waitForVisibleReplay(page);
}

async function readyTurn4(page, turnEvidence) {
  await page.getByRole("img", { name: /Privacy-checked captured UI for save point/u }).waitFor();
  await page.getByRole("heading", { name: "Should the navigation hierarchy change at this boundary?" }).waitFor();
  const replayControl = page.getByRole("button", { name: /Start replay|Resume replay/u });
  await replayControl.waitFor({ timeout: 10_000 }).catch(() => undefined);
  assert(await replayControl.count() === 1, `Turn 4 bounded replay controls unavailable: ${await page.locator(".evidence-media").innerText()} evidence=${JSON.stringify(turnEvidence)}`);
}

async function capture(page, state, viewport, captures) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  if (state !== "joined-comparison") {
    const replayFrame = page.getByTitle("Isolated non-interactive historical replay");
    await replayFrame.scrollIntoViewIfNeeded();
    await waitForVisibleReplay(page);
    await page.evaluate(() => new Promise((resolvePaint) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolvePaint))));
  }
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(dimensions.scrollWidth <= dimensions.clientWidth, `${state}-${viewport.name} overflowed: ${JSON.stringify(dimensions)}`);
  const path = resolve(OUTPUT, `${state}-${viewport.name}.png`);
  await page.screenshot({ path, fullPage: true });
  captures.push({ state, viewport, dimensions, file: portable(path), sha256: sha256(await readFile(path)) });
}

const { report } = await prepareJoinedVerification({
  webRoot: WEB_ROOT,
  output: OUTPUT,
  runSequence: () => runTenSaveSequence(ROOT),
});
seedTurn4Decision(report);
const before = await originalFuture(report.projectRoot);
let application;
let browser;
let executionError;
const cleanupErrors = [];
const captures = [];
try {
  application = await startLocalApplication({ projectRoot: report.projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false });
  assert(application.origin === ORIGIN && application.replayRuntime.state === "available", `Exact production composition unavailable: ${JSON.stringify(application)}`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const requestLifecycle = createJoinedRequestLifecycle({ firstPartyOrigins: [ORIGIN, RUNTIME_ORIGIN] });
  const failures = telemetry(page, requestLifecycle);
  const turn4 = ids(4);
  const turn5 = ids(5);

  requestLifecycle.begin({ lifecycleId: "joined-primary-turn4", lifecycleUrl: `${ORIGIN}/replay/${turn4.savePointId}` });
  await page.goto(`${ORIGIN}/replay/${turn4.savePointId}`, { waitUntil: "networkidle" });
  await readyTurn4(page, report.promotionEvidence.find(({ turnId }) => turnId === turn4.turnId)?.evidence);
  assert(await page.getByText("low · source human", { exact: true }).count() === 1, "Turn 4 low uncertainty provenance is missing.");
  assert(await page.getByText(/provenance unchanged/u).count() > 0, "Confirmed inference lost its provenance label.");
  const replaySampleBaseline = await sampleCount(page);
  await performPlayAndCausalPause(page);
  await performAndAwaitSample(page, "seek", () => page.getByRole("slider", { name: "Seek within replay" }).fill("0"));
  await performAndAwaitSample(page, "restart", () => page.getByRole("button", { name: "Restart" }).click());
  await performPlayAndCausalPause(page);
  const replaySampleCount = await sampleCount(page);
  assert(replaySampleCount >= replaySampleBaseline + 6, `Expected at least six acknowledged replay commands after baseline ${replaySampleBaseline}, received ${replaySampleCount - replaySampleBaseline}.`);
  for (const viewport of viewports) await capture(page, "primary-turn4", viewport, captures);
  await requestLifecycle.settle("Primary turn-4 before comparison navigation");

  requestLifecycle.begin({ lifecycleId: "joined-turn4-turn5-comparison", lifecycleUrl: `${ORIGIN}/compare?left=${turn4.savePointId}&right=${turn5.savePointId}` });
  await page.goto(`${ORIGIN}/compare?left=${turn4.savePointId}&right=${turn5.savePointId}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Comparison qualification" }).waitFor();
  assert(await page.locator(".comparison-screenshot img").count() === 2, "Turn 4/5 comparison did not render both actual screenshots.");
  const comparisonQualification = await page.locator(".comparison-qualification").innerText();
  assert(/Mismatch blocks equivalence/iu.test(comparisonQualification) && /Mismatch · evidence/iu.test(comparisonQualification), `Turn 4/5 comparison qualification was unexpected: ${comparisonQualification}`);
  for (const viewport of viewports) await capture(page, "joined-comparison", viewport, captures);
  await requestLifecycle.settle("Turn-4/turn-5 comparison before branch navigation");

  requestLifecycle.begin({ lifecycleId: "joined-branch-creation", lifecycleUrl: `${ORIGIN}/replay/${turn4.savePointId}` });
  await page.goto(`${ORIGIN}/replay/${turn4.savePointId}`, { waitUntil: "networkidle" });
  await readyTurn4(page, report.promotionEvidence.find(({ turnId }) => turnId === turn4.turnId)?.evidence);
  await page.getByRole("button", { name: "Branch from here" }).click();
  await page.getByRole("heading", { name: "Preflight passed" }).waitFor();
  await page.getByRole("button", { name: "Confirm and create alternate lineage" }).click();
  await page.getByText("Alternate lineage verified").waitFor();
  await requestLifecycle.settle("Branch creation before durable receipt read");
  const sessionToken = await page.evaluate(() => globalThis.__REMO_SAVE_POINT_SESSION__?.sessionToken);
  assert(typeof sessionToken === "string" && sessionToken.length > 0, "Joined flow session token is unavailable for the authenticated durable receipt read.");
  requestLifecycle.begin({ lifecycleId: "joined-durable-branch-result-read", lifecycleUrl: page.url() });
  const branchResults = await page.evaluate(async ({ savePointId, token }) => {
    const response = await fetch(`/api/save-points/${encodeURIComponent(savePointId)}/branches`, { headers: { "x-remo-session-token": token } });
    return { status: response.status, body: await response.json() };
  }, { savePointId: turn4.savePointId, token: sessionToken });
  assert(branchResults.status === 200 && Array.isArray(branchResults.body.operations) && branchResults.body.operations.length === 1, `Joined flow did not expose exactly one durable branch result: ${JSON.stringify(branchResults)}`);
  const browserReceipt = branchResults.body.operations[0];
  assert(browserReceipt.state === "succeeded", `Joined real-Git branch was not successful: ${JSON.stringify(browserReceipt)}`);
  await requestLifecycle.settle("Durable branch result before original-lineage navigation");
  requestLifecycle.begin({ lifecycleId: "joined-original-lineage", lifecycleUrl: page.url() });
  await page.getByRole("button", { name: "Original future" }).click();
  await page.getByText("Viewing the preserved original lineage.").waitFor();
  await requestLifecycle.settle("Original lineage before alternate-lineage navigation");
  requestLifecycle.begin({ lifecycleId: "joined-alternate-lineage", lifecycleUrl: page.url() });
  await page.getByRole("button", { name: "Alternate future" }).click();
  await page.getByText(/Alternate lineage root context/u).waitFor();
  await performPlayAndCausalPause(page);
  for (const viewport of viewports) await capture(page, "alternate-lineage", viewport, captures);
  await requestLifecycle.settle("Alternate lineage before blank-page teardown");

  requestLifecycle.begin({ lifecycleId: "joined-blank-page-teardown", lifecycleUrl: "about:blank" });
  await page.goto("about:blank", { waitUntil: "load" });
  await requestLifecycle.settle("Blank-page teardown before context close");
  await context.close();
  await requestLifecycle.waitForSettled("Post-context-close teardown");
  const requestLifecycleEvidence = requestLifecycle.snapshot();
  assert(Object.values(failures).every((items) => items.length === 0), `Unexpected browser channels: ${JSON.stringify(failures)}`);
  assert(requestLifecycleEvidence.pending.length === 0 && requestLifecycleEvidence.failures.length === 0 && requestLifecycleEvidence.classifiedFailures.length === 0 && requestLifecycleEvidence.unexpectedNetwork.length === 0 && requestLifecycleEvidence.unboundRequests.length === 0, `Unexpected lifecycle-bound browser channels after context close: ${JSON.stringify(requestLifecycleEvidence)}`);
  const after = await originalFuture(report.projectRoot);
  const changedOriginalFutureFields = Object.keys(before).filter((key) => before[key] !== after[key]);
  assert(changedOriginalFutureFields.length === 0, `Original future changed fields: ${JSON.stringify(changedOriginalFutureFields.map((key) => ({ key, before: key === "sourceStatus" ? sha256(before[key]) : before[key], after: key === "sourceStatus" ? sha256(after[key]) : after[key] })))}`);
  await browser.close(); browser = undefined;
  await application.close(); application = undefined;

  const durableRepository = new LocalSavePointRepository({ projectRoot: report.projectRoot });
  let durableReceipts;
  let durableJournals;
  try {
    durableReceipts = durableRepository.listBranchOperations();
    durableJournals = durableRepository.listJournaledBranchIntents();
  } finally {
    durableRepository.close();
  }
  assert(durableReceipts.length === 1 && durableJournals.length === 0, `Joined flow retained ${durableJournals.length} pending intents and ${durableReceipts.length} terminal receipts instead of one completed mutation.`);
  const durableReceipt = durableReceipts[0];
  assert(durableReceipt.state === "succeeded" && durableReceipt.operationId === browserReceipt.operationId, "Browser result is not bound to the sole durable succeeded receipt.");
  const stored = durableReceipt.canonicalResult;
  assert(stored?.schemaVersion === "remo.branch-result-record.v1" && stored.projection?.state === "succeeded" && stored.gitEvidence !== undefined, "The durable receipt does not contain the real finite-adapter Git evidence.");
  const evidence = stored.gitEvidence;
  const expectedSourceCommit = report.promotionEvidence.find(({ turnId }) => turnId === turn4.turnId)?.sourceCommit;
  assert(typeof expectedSourceCommit === "string" && expectedSourceCommit.length === 40, "Turn 4 source commit is unavailable.");
  assert(evidence.sourceCommit === expectedSourceCommit && evidence.refCommit === expectedSourceCommit && evidence.worktreeCommit === expectedSourceCommit, "Derived ref/worktree do not point to the turn 4 source commit.");
  assert(evidence.branchRef === browserReceipt.branchRef && evidence.worktreeBranchRef === browserReceipt.branchRef, "Durable receipt, derived ref, and worktree branch are not causally identical.");
  assert(evidence.locked === true && evidence.observedLockReason === "ReMo isolated alternate lineage", "The derived worktree is not locked with the fixed reason.");
  assert(evidence.canonicalCommonDirectory === evidence.worktreeCommonDirectory, "The derived worktree does not share the canonical Git common directory.");
  assert(evidence.exactRefDelta === true && evidence.exactWorktreeDelta === true, "The real adapter did not observe exactly one ref and worktree mutation.");
  assert(evidence.originalFutureEqual === true, "The finite adapter did not prove original-future equality.");
  const realGit = {
    truthLabel: "verified",
    sourcePointer: "sole durable remo.branch-result-record.v1 receipt from the joined browser confirmation",
    adapter: "@remo/branch-git real finite adapter",
    operationId: durableReceipt.operationId,
    branchRef: evidence.branchRef,
    worktreeRelativePath: repositoryPointer(report.projectRoot, evidence.worktreePath),
    sourceCommit: evidence.sourceCommit,
    refCommit: evidence.refCommit,
    worktreeCommit: evidence.worktreeCommit,
    worktreeBranchRef: evidence.worktreeBranchRef,
    commonDirectory: repositoryPointer(report.projectRoot, evidence.canonicalCommonDirectory),
    locked: evidence.locked,
    lockReason: evidence.observedLockReason,
    exactRefDelta: evidence.exactRefDelta,
    exactWorktreeDelta: evidence.exactWorktreeDelta,
    durableReceipt: { state: durableReceipt.state, browserProjectionState: browserReceipt.state, pendingIntentCount: durableJournals.length, canonicalResultDigest: sha256(JSON.stringify(stored)) },
    mutationCount: durableReceipts.length,
  };
  const ledger = {
    event: "vs002.t10.joined-operating-loop", verdict: "PASS",
    truth: { joinedBrowserBranchAdapter: "real-finite-t8-t9-path", joinedCompletionUsesSupplementaryFake: false, actualMediaAndRuntime: true },
    runtime: { node: process.version, playwright: playwrightVersion, parentOrigin: ORIGIN, runtimeOrigin: RUNTIME_ORIGIN, reducedMotion: true, webRoot: "apps/web/dist", outputMode: OUTPUT.startsWith(ROOT) ? "repository-artifact" : "volatile-external" },
    path: ["turn-4-actual-media", "turn-4-low-uncertainty-decision", "turn-5-comparison", "passing-preflight", "exactly-one-branch", "original-lineage", "alternate-lineage"],
    mutationCount: durableReceipts.length, failures, requestLifecycle: requestLifecycleEvidence, before, after, realGit, captures,
  };
  await writeFile(resolve(OUTPUT, "joined-acceptance-ledger.json"), JSON.stringify(ledger, null, 2));
  process.stdout.write(`${JSON.stringify({ verdict: ledger.verdict, path: ledger.path, mutationCount: durableReceipts.length, captures: captures.length, output: portable(OUTPUT) })}\n`);
} catch (error) {
  executionError = error;
  process.stderr.write(`Joined acceptance primary failure before cleanup: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
} finally {
  await browser?.close().catch((error) => cleanupErrors.push(error));
  await application?.close().catch((error) => cleanupErrors.push(error));
  await removeDisposableFixture(report.projectRoot).catch((error) => cleanupErrors.push(error));
  if (cleanupErrors.length > 0 && executionError !== undefined) process.stderr.write(`Joined acceptance cleanup also failed without replacing the primary error: ${JSON.stringify(cleanupErrors.map((error) => error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }))}\n`);
}
if (executionError !== undefined) throw executionError;
if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Joined acceptance cleanup failed.");
