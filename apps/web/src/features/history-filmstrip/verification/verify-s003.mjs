/* global URL, document, fetch, performance, process */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { runTenSaveSequence } from "../../../../../service/src/acceptance-sequence/ten-save-sequence.ts";
import { startLocalApplication } from "../../../../../service/src/promotion/local-application.ts";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../../../../..");
const WEB_ROOT = resolve(ROOT, "apps/web/dist");
const OUTPUT = resolve(import.meta.dirname);
const ORIGIN = "http://127.0.0.1:4175";
const REPLAY_ORIGIN = "http://127.0.0.1:4176";
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
const git = async (cwd, args) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trimEnd();
const detailIntegrity = (value) => value === "Complete" ? "complete" : value === "Incomplete" ? "incomplete" : value === "Inconsistent" ? "quarantined" : undefined;
const detailFidelity = (value) => value === "Editable eligible" ? "editable-eligible" : value === "Degraded" ? "degraded" : value === "Historical only" ? "unavailable" : undefined;

async function sourceDigest(cwd) {
  const index = await git(cwd, ["ls-files", "-s"]);
  const worktreeDiff = await git(cwd, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  return sha256(`${index}\0${worktreeDiff}`);
}

async function immutableSnapshot(projectRoot, historyText) {
  const gitState = {
    branch: await git(projectRoot, ["symbolic-ref", "--short", "HEAD"]),
    head: await git(projectRoot, ["rev-parse", "HEAD"]),
    tree: await git(projectRoot, ["write-tree"]),
    status: await git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
  return {
    git: gitState,
    gitDigest: sha256(JSON.stringify(gitState)),
    sourceDigest: await sourceDigest(projectRoot),
    lineageDigest: sha256(historyText),
  };
}

function nearestRankP95(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function attachFailureLedger(page, ledger) {
  page.on("console", (message) => { if (message.type() === "error") ledger.consoleErrors.push(`${message.text()} @ ${message.location().url || "unknown"}`); });
  page.on("pageerror", (error) => ledger.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`;
    ledger.requestErrors.push(failure);
  });
  page.on("response", (response) => { if (response.status() >= 400) ledger.requestErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`); });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" && url.origin !== ORIGIN && url.origin !== REPLAY_ORIGIN) ledger.unexpectedRequests.push(`${request.method()} ${request.url()}`);
  });
}

async function waitForWorkspace(page, selectedId, expectedCount = 10) {
  await page.locator('[role="listbox"][aria-label="Major-turn history"]').waitFor();
  await page.locator('[role="option"]').first().waitFor();
  assert(await page.locator('[role="option"]').count() === expectedCount, `Production history rendered an unexpected slot count; expected ${expectedCount}.`);
  if (selectedId !== undefined) await page.locator(`.selected-turn code:text-is("${selectedId}")`).waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(dimensions.scrollWidth <= dimensions.clientWidth, `${label} has document overflow: ${JSON.stringify(dimensions)}`);
  return dimensions;
}

async function waitForReplaySettlement(page) {
  await page.getByText("Replay paused", { exact: true }).waitFor();
}

async function captureState(page, path, selectedId, fileName, state) {
  await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle" });
  if (state !== "degraded") await waitForWorkspace(page, selectedId);
  if (state === "active") {
    await page.locator(".selected-detail-state").waitFor({ state: "detached" });
    await page.locator(`.evidence-media[data-save-point-id="${selectedId}"] img[alt*="${selectedId}"]`).waitFor();
    await page.locator(".evidence-media").waitFor();
    await waitForReplaySettlement(page);
  }
  if (state === "tombstone") await page.getByRole("heading", { name: /was deleted$/u }).waitFor();
  if (state === "degraded") await page.getByRole("heading", { name: "Save point not found" }).waitFor();
  if (state === "active" || state === "tombstone") {
    const visibleSelection = await page.locator('[role="option"][aria-selected="true"]').evaluate((option) => {
      const optionRect = option.getBoundingClientRect();
      const stripRect = option.parentElement.getBoundingClientRect();
      return optionRect.left >= stripRect.left - 1 && optionRect.right <= stripRect.right + 1;
    });
    assert(visibleSelection, `${fileName} does not keep its selected filmstrip item visible.`);
  }
  const overflow = await assertNoOverflow(page, fileName);
  const file = resolve(OUTPUT, fileName);
  await page.screenshot({ path: file, fullPage: true });
  return { file, overflow };
}

async function openApplication(projectRoot, seedImplementationFixture = false) {
  const application = await startLocalApplication({ projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture });
  assert(application.origin === ORIGIN, `Application origin mismatch: ${application.origin}`);
  return application;
}

const report = await runTenSaveSequence(ROOT);
let application;
let browser;
let replayFixtureRoot;
try {
  await mkdir(OUTPUT, { recursive: true });
  application = await openApplication(report.projectRoot);
  browser = await chromium.launch({ headless: true });
  const failures = { consoleErrors: [], pageErrors: [], requestErrors: [], requestCancellations: [], unexpectedRequests: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  attachFailureLedger(page, failures);

  const historyResponse = await page.request.get(`${ORIGIN}/api/history`);
  assert(historyResponse.ok(), `History API failed: ${historyResponse.status()}`);
  const historyText = await historyResponse.text();
  const history = JSON.parse(historyText);
  assert(history.anchors.length === 10, `Expected ten history anchors, received ${history.anchors.length}.`);
  const ordered = [...history.anchors].sort((left, right) => left.sequenceNo - right.sequenceNo);
  assert(ordered.map(({ sequenceNo }) => sequenceNo).join(",") === "1,2,3,4,5,6,7,8,9,10", "History sequence was renumbered or reordered.");
  const tombstone = ordered.find(({ state }) => state === "tombstone");
  assert(tombstone?.sequenceNo === 6 && typeof tombstone.lifecycleReceiptId === "string", "Turn 6 is not the safe receipt-backed tombstone.");
  assert(tombstone.majorTurnLabel === undefined && tombstone.nominationReason === undefined, "Tombstone leaked label or nomination metadata.");
  const active = ordered.filter(({ state }) => state === "active");
  assert(active.length === 9, `Expected nine active turns after deletion, received ${active.length}.`);
  const primary = active.find(({ sequenceNo }) => sequenceNo === 4) ?? active[0];
  assert(primary !== undefined, "No active primary turn exists.");
  const mediaBinding = primary.capturedThumbnail?.availability === "available" ? primary.capturedThumbnail : primary.capturedReplay?.availability === "available" ? primary.capturedReplay : undefined;
  assert(mediaBinding !== undefined, "Primary history trust projection lacks revision-bound safe media authority.");
  const primaryHtmlResponse = await page.request.get(`${ORIGIN}/replay/${primary.savePointId}`);
  assert(primaryHtmlResponse.ok(), `Primary replay route failed: ${primaryHtmlResponse.status()}`);
  const primaryHtml = await primaryHtmlResponse.text();
  const primaryBootstrapMatch = /window\.__REMO_SAVE_POINT__=(.*?);window\.__REMO_SAVE_POINT_SESSION__=/u.exec(primaryHtml);
  assert(primaryBootstrapMatch !== null, "Primary replay route lacks the selected safe detail bootstrap.");
  const primaryDetail = JSON.parse(primaryBootstrapMatch[1]);
  const historyReplayAvailable = primary.capturedReplay?.availability === "available";
  const detailReplayAvailable = primaryDetail.components.some(({ type, availability }) => type === "rrweb" && availability === "Available");
  const joinedTrust = {
    savePointId: primary.savePointId,
    turnId: primary.turnId,
    revision: mediaBinding.revision,
    manifestDigest: mediaBinding.manifestDigest,
    integrity: primary.integrity,
    fidelity: primary.fidelity,
    completeness: primary.integrity === "complete" ? "complete" : "incomplete",
    editability: primary.fidelity === "editable-eligible" ? "eligible" : "blocked",
    replayAvailability: historyReplayAvailable ? "available" : "unavailable",
  };
  assert(primaryDetail.savePointId === joinedTrust.savePointId && primaryDetail.turnId === joinedTrust.turnId, "Filmstrip and detail identities disagree.");
  assert(primaryDetail.revision === joinedTrust.revision && primaryDetail.manifestDigest === joinedTrust.manifestDigest, "Filmstrip and detail revision or manifest authority disagree.");
  assert(detailIntegrity(primaryDetail.integrity?.state) === joinedTrust.integrity, `Filmstrip/detail integrity contradiction: ${joinedTrust.integrity} versus ${primaryDetail.integrity?.state}.`);
  assert(detailFidelity(primaryDetail.fidelity?.state) === joinedTrust.fidelity, `Filmstrip/detail fidelity contradiction: ${joinedTrust.fidelity} versus ${primaryDetail.fidelity?.state}.`);
  assert(detailReplayAvailable === historyReplayAvailable, "Filmstrip and detail replay availability disagree.");

  const before = await immutableSnapshot(report.projectRoot, historyText);
  const orderBefore = ordered.map(({ savePointId, sequenceNo, lineageId, state }) => ({ savePointId, sequenceNo, lineageId, state }));
  const captures = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    captures.push(await captureState(page, `/replay/${primary.savePointId}`, primary.savePointId, `s003-primary-${viewport.name}.png`, "active"));

    const tombstoneRequestStart = failures.requestErrors.length + failures.requestCancellations.length;
    const observedRequests = [];
    const observe = (request) => observedRequests.push(request.url());
    page.on("request", observe);
    captures.push(await captureState(page, `/replay/${tombstone.savePointId}`, tombstone.savePointId, `s003-tombstone-${viewport.name}.png`, "tombstone"));
    page.off("request", observe);
    assert(failures.requestErrors.length + failures.requestCancellations.length === tombstoneRequestStart, `Tombstone produced a request failure at ${viewport.name}.`);
    assert(!observedRequests.some((url) => url.includes(`/api/save-points/${tombstone.savePointId}`) || url.includes("/media/")), `Tombstone fetched protected evidence at ${viewport.name}.`);

    captures.push(await captureState(page, "/replay/missing-safe-identity", undefined, `s003-degraded-${viewport.name}.png`, "degraded"));
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${ORIGIN}/replay/${primary.savePointId}`, { waitUntil: "networkidle" });
  await waitForWorkspace(page, primary.savePointId);
  const previousTarget = active.find(({ sequenceNo }) => sequenceNo === primary.sequenceNo - 1);
  const nextTarget = active.find(({ sequenceNo }) => sequenceNo === primary.sequenceNo + 1);
  assert(previousTarget !== undefined && nextTarget !== undefined, "Primary fixture lacks within-lineage transport neighbors.");
  const clickTransport = async (name, target) => {
    await page.getByRole("button", { name }).click();
    await page.locator(`.selected-turn code:text-is("${target.savePointId}")`).waitFor();
    await page.locator(".selected-detail-state").waitFor({ state: "detached" });
    await waitForReplaySettlement(page);
  };
  await clickTransport("Previous turn", previousTarget);
  await clickTransport("Next turn", primary);
  await clickTransport("Next turn", nextTarget);
  assert(await page.locator('[role="option"][aria-selected="true"]').getAttribute("data-lifecycle-state") === "active", "Within-lineage next selected an invalid lifecycle slot.");
  await page.goto(`${ORIGIN}/replay/${primary.savePointId}`, { waitUntil: "networkidle" });
  await waitForWorkspace(page, primary.savePointId);
  const selectedOption = page.locator('[role="option"][aria-selected="true"]');
  await selectedOption.focus();
  const pressAndSettle = async (key, target) => {
    const responsePromise = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/save-points/${target.savePointId}` && response.status() === 200);
    await page.keyboard.press(key);
    await responsePromise;
    await page.locator(`.selected-turn code:text-is("${target.savePointId}")`).waitFor();
    await page.locator(".selected-detail-state").waitFor({ state: "detached" });
    await waitForReplaySettlement(page);
  };
  await pressAndSettle("End", active.find(({ sequenceNo }) => sequenceNo === 10));
  assert(await page.locator('[role="option"][aria-selected="true"]').getAttribute("aria-posinset") === "10", "End did not select the last filmstrip option.");
  await pressAndSettle("Home", active.find(({ sequenceNo }) => sequenceNo === 1));
  assert(await page.locator('[role="option"][aria-selected="true"]').getAttribute("aria-posinset") === "1", "Home did not select the first filmstrip option.");
  await pressAndSettle("ArrowRight", active.find(({ sequenceNo }) => sequenceNo === 2));
  assert(await page.locator('[role="option"][aria-selected="true"]').getAttribute("aria-posinset") === "2", "ArrowRight did not move selection with focus.");

  const selectionSamples = [];
  const sampleTargets = active.filter(({ savePointId }) => savePointId !== primary.savePointId);
  for (let index = 0; index < 30; index += 1) {
    const target = sampleTargets[index % sampleTargets.length];
    const binding = target.capturedThumbnail?.availability === "available"
      ? target.capturedThumbnail
      : target.capturedReplay?.availability === "available" ? target.capturedReplay : undefined;
    assert(binding !== undefined, `Selection target ${target.savePointId} has no trustworthy detail binding.`);
    await page.evaluate((savePointId) => {
      const sample = { savePointId, detailRevision: undefined, detailManifestDigest: undefined, durationMs: undefined };
      globalThis.__REMO_S003_SELECTION_SAMPLE__ = sample;
      const started = performance.now();
      const observe = () => {
        const selected = document.querySelector(".selected-turn");
        const identity = selected?.querySelector("dl code")?.textContent;
        const nomination = selected?.querySelector(":scope > div > span");
        const trustSummary = selected?.querySelector("dl");
        const detailRevision = selected?.getAttribute("data-detail-revision");
        const detailManifestDigest = selected?.getAttribute("data-detail-manifest-digest");
        const targetDetailCommitted = identity === savePointId
          && /^[1-9][0-9]*$/u.test(detailRevision ?? "")
          && /^sha256:[0-9a-f]{64}$/u.test(detailManifestDigest ?? "");
        const visibleNonReplayEvidence = identity === savePointId
          && nomination !== null
          && (nomination.textContent ?? "").trim().length > 0
          && nomination.getClientRects().length > 0
          && trustSummary !== null
          && (trustSummary.textContent ?? "").includes("Integrity")
          && (trustSummary.textContent ?? "").includes("Fidelity")
          && trustSummary.getClientRects().length > 0;
        if (targetDetailCommitted && visibleNonReplayEvidence && document.querySelector(".selected-detail-state") === null) {
          sample.detailRevision = Number(detailRevision);
          sample.detailManifestDigest = detailManifestDigest;
          sample.durationMs = performance.now() - started;
        }
        else globalThis.requestAnimationFrame(observe);
      };
      globalThis.requestAnimationFrame(observe);
    }, target.savePointId);
    const responsePromise = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/save-points/${target.savePointId}` && response.status() === 200);
    await page.locator(`#history-option-${target.savePointId}`).click();
    let detailResponse;
    try {
      [detailResponse] = await Promise.all([
        responsePromise,
        page.waitForFunction(() => Number.isFinite(globalThis.__REMO_S003_SELECTION_SAMPLE__?.durationMs), undefined, { polling: "raf" }),
      ]);
    } catch (error) {
      const diagnostic = await page.evaluate(() => {
        const selected = document.querySelector(".selected-turn");
        const nomination = selected?.querySelector(":scope > div > span");
        const trustSummary = selected?.querySelector("dl");
        return {
          sample: globalThis.__REMO_S003_SELECTION_SAMPLE__,
          selectedIdentity: selected?.querySelector("dl code")?.textContent,
          detailRevision: selected?.getAttribute("data-detail-revision"),
          detailManifestDigest: selected?.getAttribute("data-detail-manifest-digest"),
          nomination: nomination?.textContent,
          nominationRects: nomination?.getClientRects().length,
          trustSummary: trustSummary?.textContent,
          trustRects: trustSummary?.getClientRects().length,
          detailState: document.querySelector(".selected-detail-state")?.textContent,
        };
      });
      throw new Error(`Target-bound S-003 selection did not settle: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const responseDetail = await detailResponse.json();
    const sample = await page.evaluate(() => globalThis.__REMO_S003_SELECTION_SAMPLE__);
    assert(sample.savePointId === target.savePointId && sample.detailRevision === responseDetail.revision && sample.detailManifestDigest === responseDetail.manifestDigest, `Timed target detail did not match its settled response: ${JSON.stringify({ target: target.savePointId, sample, response: { savePointId: responseDetail.savePointId, revision: responseDetail.revision, manifestDigest: responseDetail.manifestDigest } })}`);
    assert(binding.revision === responseDetail.revision && binding.manifestDigest === responseDetail.manifestDigest, `History media binding did not match the settled target detail for ${target.savePointId}.`);
    selectionSamples.push(sample.durationMs);
    await waitForReplaySettlement(page);
  }
  const selectionP95 = nearestRankP95(selectionSamples);
  assert(selectionP95 <= 200, `Warm loaded-ten-slot nearest-rank selection p95 exceeded 200 ms: ${selectionP95.toFixed(1)} ms; samples=${JSON.stringify(selectionSamples)}.`);

  const root = active.find(({ sequenceNo }) => sequenceNo === 4);
  assert(root !== undefined, "Alternate-lineage fixture root is missing.");
  const branchOperationId = "s003-alternate-operation";
  const alternateLineageId = `lineage:alternate:${branchOperationId}`;
  const alternateLineage = { lineageId: alternateLineageId, parentLineageId: "lineage:original", rootSavePointId: root.savePointId, branchOperationId, gitRef: `refs/heads/remo/${branchOperationId}`, worktreeRelativePath: `.remo/worktrees/${branchOperationId}`, state: "active-alternate" };
  const alternatePage = await context.newPage();
  attachFailureLedger(alternatePage, failures);
  await alternatePage.route(`${ORIGIN}/api/history`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...history, lineages: [...history.lineages, alternateLineage] }) }));
  await alternatePage.goto(`${ORIGIN}/replay`, { waitUntil: "networkidle" });
  try {
    await alternatePage.locator('[role="listbox"][aria-label="Major-turn history"]').waitFor();
  }
  catch (error) {
    const body = (await alternatePage.locator("body").innerText()).slice(0, 2_000);
    throw new Error(`Alternate-lineage history did not become ready: body=${body} failures=${JSON.stringify(failures)}`, { cause: error });
  }
  assert(await alternatePage.locator('[role="option"]').count() === 10, "Alternate-lineage fixture changed the ten-slot original lineage.");
  await alternatePage.getByRole("button", { name: "Alternate future" }).click();
  await alternatePage.locator(`.selected-turn code:text-is("${root.savePointId}")`).waitFor();
  await alternatePage.getByText(/Alternate lineage root context/u).waitFor();
  await alternatePage.getByText("Replay paused", { exact: true }).waitFor();
  assert(await alternatePage.getByRole("button", { name: "Previous turn" }).isDisabled(), "Previous escaped the one-anchor alternate lineage.");
  assert(await alternatePage.getByRole("button", { name: "Next turn" }).isDisabled(), "Next escaped the one-anchor alternate lineage.");
  await alternatePage.close();

  const restartSelection = active.find(({ sequenceNo }) => sequenceNo === 9) ?? active.at(-1);
  assert(restartSelection !== undefined, "No restart selection exists.");
  await page.goto(`${ORIGIN}/replay/${restartSelection.savePointId}`, { waitUntil: "networkidle" });
  await waitForWorkspace(page, restartSelection.savePointId);
  await context.close();
  await browser.close(); browser = undefined;
  await application.close(); application = undefined;

  application = await openApplication(report.projectRoot);
  browser = await chromium.launch({ headless: true });
  const restartContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const restartPage = await restartContext.newPage();
  attachFailureLedger(restartPage, failures);
  await restartPage.goto(`${ORIGIN}/replay/${restartSelection.savePointId}`, { waitUntil: "networkidle" });
  await waitForWorkspace(restartPage, restartSelection.savePointId);
  const orderAfter = await restartPage.locator('[role="option"]').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.id.replace("history-option-", ""),
    position: Number(node.getAttribute("aria-posinset")),
    state: node.getAttribute("data-lifecycle-state"),
  })));
  assert(JSON.stringify(orderAfter) === JSON.stringify(orderBefore.map(({ savePointId, sequenceNo, state }) => ({ id: savePointId, position: sequenceNo, state }))), "Restart changed selection addressability or filmstrip order.");
  const historyAfterResponse = await restartPage.request.get(`${ORIGIN}/api/history`);
  assert(historyAfterResponse.ok(), `Restart history API failed: ${historyAfterResponse.status()}`);
  const historyAfterText = await historyAfterResponse.text();
  const after = await immutableSnapshot(report.projectRoot, historyAfterText);
  assert(after.gitDigest === before.gitDigest, "Git identity/status changed during read-only filmstrip verification.");
  assert(after.sourceDigest === before.sourceDigest, "Tracked source digest changed during read-only filmstrip verification.");
  assert(after.lineageDigest === before.lineageDigest, "Lineage/history digest changed during read-only filmstrip verification or restart.");
  await restartContext.close();

  await browser.close(); browser = undefined;
  await application.close(); application = undefined;
  replayFixtureRoot = await mkdtemp(join(tmpdir(), "remo-s003-replay-media-"));
  await mkdir(join(replayFixtureRoot, ".git"));
  application = await openApplication(replayFixtureRoot, true);
  const candidateHtml = await (await fetch(`${ORIGIN}/candidate/review`)).text();
  const candidateMatch = /window\.__REMO_CANDIDATE__=(.*?);window\.__REMO_PROMOTION_SESSION__=(.*?);/u.exec(candidateHtml);
  assert(candidateMatch !== null, "T3 replay fixture candidate bootstrap is missing.");
  const candidate = JSON.parse(candidateMatch[1]);
  const promotionSession = JSON.parse(candidateMatch[2]);
  const promotion = await fetch(`${ORIGIN}/api/candidates/${candidate.turnId}/promote`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "x-remo-session-token": promotionSession.sessionToken }, body: JSON.stringify({ confirm: true, ...candidate.confirmationBinding }) });
  assert(promotion.ok, `T3 replay fixture promotion failed: ${promotion.status}.`);
  browser = await chromium.launch({ headless: true });
  const mediaContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const mediaPage = await mediaContext.newPage();
  attachFailureLedger(mediaPage, failures);
  await mediaPage.goto(`${ORIGIN}/replay/${candidate.confirmationBinding.savePointId}`, { waitUntil: "networkidle" });
  await waitForWorkspace(mediaPage, candidate.confirmationBinding.savePointId, 1);
  await mediaPage.locator(`.evidence-media[data-save-point-id="${candidate.confirmationBinding.savePointId}"] img[alt*="${candidate.confirmationBinding.savePointId}"]`).waitFor();
  await mediaPage.locator(".replay-state", { hasText: "Replay paused" }).waitFor();
  await mediaPage.getByRole("button", { name: "Restart", exact: true }).click();
  await mediaPage.locator('.replay-performance[data-latest-command="restart"]').waitFor();
  const restartCommand = await mediaPage.locator(".replay-performance").evaluate((node) => ({ command: node.getAttribute("data-latest-command"), acknowledgedMs: Number(node.getAttribute("data-latest-command-ms")) }));
  assert(restartCommand.command === "restart" && Number.isFinite(restartCommand.acknowledgedMs), "T3 restart command was not acknowledged by the trusted-parent replay surface.");
  await mediaContext.close();
  await browser.close(); browser = undefined;
  await application.close(); application = undefined;

  assert(failures.consoleErrors.length === 0, `Unexpected console errors: ${JSON.stringify(failures.consoleErrors)}`);
  assert(failures.pageErrors.length === 0, `Unexpected page errors: ${JSON.stringify(failures.pageErrors)}`);
  assert(failures.requestErrors.length === 0, `Unexpected request errors: ${JSON.stringify(failures.requestErrors)}`);
  assert(failures.unexpectedRequests.length === 0, `Unexpected cross-origin requests: ${JSON.stringify(failures.unexpectedRequests)}`);

  const captureEvidence = [];
  for (const capture of captures) {
    const bytes = await readFile(capture.file);
    captureEvidence.push({ file: relative(ROOT, capture.file).replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: sha256(bytes), overflow: capture.overflow });
  }
  const productionTenSave = {
    truthLabel: "observed",
    sourcePointer: "runTenSaveSequence(ROOT) project opened through the production web build at 127.0.0.1:4175; GET /api/history and replay-route safe bootstrap",
    fixture: { durableCount: report.durableCount, activeCount: active.length, tombstoneSavePointId: tombstone.savePointId, restartSelection: restartSelection.savePointId },
    joinedTrust,
    accessibility: { pattern: "horizontal single-select listbox", arrowSelection: "pass", homeEnd: "pass", tombstoneAnnounced: "pass" },
    performance: { profile: "production build; ten slots loaded once; 30 post-warm active selections; no CPU throttle", method: "nearest-rank", thresholdMs: 200, samplesMs: selectionSamples, p95Ms: selectionP95 },
    immutability: { before, after, gitUnchanged: true, sourceUnchanged: true, lineageUnchanged: true },
    failures,
    tombstoneNoFetch: true,
    withinLineageNavigation: true,
    restartStable: true,
    captures: captureEvidence,
  };
  const simulatedAlternateLineage = {
    truthLabel: "simulated",
    sourcePointer: "Playwright route interception for GET /api/history with one verified branch-lineage record in verify-s003.mjs",
    rootSavePointId: root.savePointId,
    alternateRootEvidenceSavePointId: root.savePointId,
    originalCount: 10,
    alternateCount: 1,
    boundaryNavigation: "pass",
  };
  const seededReplayRestart = {
    truthLabel: "simulated",
    sourcePointer: "startLocalApplication(replayFixtureRoot, seedImplementationFixture=true), seeded candidate promotion, unchanged T3 EvidenceMediaPanel on 127.0.0.1:4175/4176",
    restartCommand,
  };
  const ledger = {
    event: "s003.lineage-filmstrip.fixture-verification",
    occurredAt: new Date().toISOString(),
    runtime: {
      truthLabel: "observed",
      sourcePointer: "process.version, installed Playwright package metadata, and exact verifier constants",
      node: process.version,
      playwright: playwrightVersion,
      origin: ORIGIN,
      productionWebRoot: relative(ROOT, WEB_ROOT).replaceAll("\\", "/"),
    },
    acceptanceBoundary: {
      truthLabel: "verified",
      sourcePointer: "The three separately sourced evidence groups below",
      claim: "S-003 fixture verification passed; combined fixture evidence is not production acceptance.",
    },
    evidence: { productionTenSave, simulatedAlternateLineage, seededReplayRestart },
  };
  await writeFile(resolve(OUTPUT, "s003-acceptance-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ event: ledger.event, verdict: "PASS", acceptanceClaim: "fixture-verification-not-production-acceptance", captures: captureEvidence.length, selectionP95Ms: selectionP95, joinedTrust, restartCommand, withinLineageNavigation: true, alternateLineage: true, restartStable: true, tombstoneNoFetch: true, gitDigest: before.gitDigest, sourceDigest: before.sourceDigest, lineageDigest: before.lineageDigest })}\n`);
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (application !== undefined) await application.close().catch(() => undefined);
  if (replayFixtureRoot !== undefined) await rm(replayFixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  await report.dispose().catch(() => undefined);
}
