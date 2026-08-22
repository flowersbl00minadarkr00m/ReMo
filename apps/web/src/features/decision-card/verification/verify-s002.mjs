/* global URL, document, fetch, process, setTimeout */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { buildDecisionRecord } from "../../../../../../packages/domain/src/index.ts";
import { LocalSavePointRepository } from "../../../../../../packages/storage-local/src/index.ts";
import { runTenSaveSequence } from "../../../../../service/src/acceptance-sequence/ten-save-sequence.ts";
import { createDecisionService } from "../../../../../service/src/decisions/decision-service.ts";
import { startLocalApplication } from "../../../../../service/src/promotion/local-application.ts";
import { createNavigationRequestLifecycle, isCausallyBoundNavigationMediaFailure } from "./navigation-request-lifecycle.mjs";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../../../../..");
const WEB_ROOT = resolve(ROOT, "apps/web/dist");
const COMMITTED_OUTPUT = resolve(import.meta.dirname);
const EVIDENCE_ROOT = "apps/web/src/features/decision-card/verification";
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
const EXPECTED_NAVIGATION_MEDIA_CANCELLATIONS = 0;
const EXPECTED_UNKNOWN_DECISION_READS = VIEWPORTS.length;
const FIRST_PARTY_QUIET_MS = 250;
const FIRST_PARTY_SETTLEMENT_TIMEOUT_MS = 10_000;
const refreshCommitted = process.env.REMO_REFRESH_S002_EVIDENCE === "1";
const OUTPUT = refreshCommitted ? COMMITTED_OUTPUT : await mkdtemp(join(tmpdir(), "remo-s002-output-"));
const ids = (turn) => ({ turnId: `01J00000000000000000000T${String(turn).padStart(2, "0")}`, savePointId: `01J00000000000000000000S${String(turn).padStart(2, "0")}` });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const unknown = (recordedAt) => ({ provenance: "unknown", sourceComponentIds: [], recordedAt });
const field = (value, provenance, sourceComponentIds, recordedAt) => ({ value, provenance, sourceComponentIds, recordedAt });

function failures(page, options = {}) {
  const currentNavigation = options.currentNavigation ?? (() => undefined);
  const expectedRequestFailures = options.expectedRequestFailures ?? new WeakSet();
  const requestBindings = new WeakMap();
  const pendingFirstParty = new Set();
  let requestSequence = 0;
  let lastFirstPartyActivityAt = Date.now();
  const ledger = { consoleErrors: [], unexpectedConsoleErrors: [], observedUnknownDecisionReads: [], navigationMediaCancellations: [], expectedResponseLosses: [], expectedResponseLossConsoleErrors: [], pageErrors: [], requestFailures: [], unexpectedRequestFailures: [], requestErrors: [], unexpectedRequests: [], readinessDiagnostics: [] };
  const finishFirstParty = (request) => {
    if (!pendingFirstParty.delete(request)) return;
    lastFirstPartyActivityAt = Date.now();
  };
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    ledger.consoleErrors.push(`${message.text()} @ ${location || "unknown"}`);
  });
  page.on("pageerror", (error) => ledger.pageErrors.push(error.message));
  page.on("requestfinished", finishFirstParty);
  page.on("requestfailed", (request) => {
    finishFirstParty(request);
    const binding = requestBindings.get(request);
    const failure = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`;
    ledger.requestFailures.push(failure);
    if (expectedRequestFailures.has(request)) ledger.expectedResponseLosses.push({ ...binding, method: request.method(), url: request.url(), errorText: request.failure()?.errorText ?? "failed" });
    else {
      if (isCausallyBoundNavigationMediaFailure({ binding, method: request.method(), url: request.url(), errorText: request.failure()?.errorText })) ledger.navigationMediaCancellations.push({ ...binding, method: request.method(), url: request.url(), errorText: request.failure()?.errorText });
      ledger.unexpectedRequestFailures.push(failure);
    }
  });
  page.on("response", (response) => {
    if (response.status() === 200 && response.url().endsWith(`/api/save-points/${ids(7).savePointId}/decision`)) ledger.observedUnknownDecisionReads.push(response.url());
    if (response.status() >= 400) ledger.requestErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  page.on("request", (request) => {
    const navigation = currentNavigation();
    requestSequence += 1;
    requestBindings.set(request, { requestId: `request-${requestSequence}`, ...(navigation === undefined ? {} : { navigationId: navigation.navigationId, navigationUrl: navigation.url }) });
    const url = new URL(request.url());
    if (url.origin === ORIGIN || url.origin === REPLAY_ORIGIN) { pendingFirstParty.add(request); lastFirstPartyActivityAt = Date.now(); }
    if (url.protocol === "http:" && url.origin !== ORIGIN && url.origin !== REPLAY_ORIGIN) ledger.unexpectedRequests.push(`${request.method()} ${request.url()}`);
  });
  return { ledger, pendingFirstParty, lastFirstPartyActivityAt: () => lastFirstPartyActivityAt };
}

async function waitForFirstPartyQuiet(failureState, label) {
  const deadline = Date.now() + FIRST_PARTY_SETTLEMENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const quietForMs = Date.now() - failureState.lastFirstPartyActivityAt();
    if (failureState.pendingFirstParty.size === 0 && quietForMs >= FIRST_PARTY_QUIET_MS) {
      const diagnostic = { label, pendingFirstPartyRequests: 0, quietWindowMs: FIRST_PARTY_QUIET_MS, observedQuietForMs: quietForMs };
      failureState.ledger.readinessDiagnostics.push(diagnostic);
      return diagnostic;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const pending = [...failureState.pendingFirstParty].map((request) => `${request.method()} ${request.url()}`);
  throw new Error(`${label} did not reach first-party settlement plus a ${FIRST_PARTY_QUIET_MS}ms quiet window: ${JSON.stringify({ pending })}`);
}

async function waitForApplicationMediaReady(page, failureState, savePointId, label) {
  await page.getByRole("heading", { name: "Major turns" }).waitFor();
  await page.locator(`.evidence-media[data-save-point-id="${savePointId}"]`).waitFor();
  await page.waitForFunction(() => {
    const activeOptions = [...document.querySelectorAll('.filmstrip-option:not([data-lifecycle-state="tombstone"])')];
    return activeOptions.length > 0
      && activeOptions.every((option) => option.querySelector('.filmstrip-thumbnail')?.getAttribute("data-thumbnail-availability") === "available")
      && document.querySelector(".evidence-media .media-loading") === null;
  });
  const applicationMedia = await page.evaluate(() => ({
    activeFilmstripItems: document.querySelectorAll('.filmstrip-option:not([data-lifecycle-state="tombstone"])').length,
    availableFilmstripThumbnails: document.querySelectorAll('.filmstrip-option:not([data-lifecycle-state="tombstone"]) .filmstrip-thumbnail[data-thumbnail-availability="available"]').length,
    selectedMediaLoadingStates: document.querySelectorAll(".evidence-media .media-loading").length,
  }));
  failureState.ledger.readinessDiagnostics.push({ label, applicationMedia });
  await waitForFirstPartyQuiet(failureState, `${label} network settlement`);
}

async function noOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(dimensions.scrollWidth <= dimensions.clientWidth, `${label} overflows horizontally: ${JSON.stringify(dimensions)}`);
  return dimensions;
}

async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.locator("img").evaluateAll(async (images) => Promise.all(images.map(async (image) => {
    if (!image.complete) await new Promise((resolveImage, rejectImage) => { image.addEventListener("load", resolveImage, { once: true }); image.addEventListener("error", rejectImage, { once: true }); });
    await image.decode();
  })));
  const dimensions = await noOverflow(page, name);
  const path = resolve(OUTPUT, name);
  await page.screenshot({ path, fullPage: true });
  const bytes = await readFile(path);
  return { file: name, sha256: sha256(bytes), byteSize: bytes.byteLength, viewport: page.viewportSize(), dimensions };
}

async function candidateBeforePromotion(browser) {
  const projectRoot = await mkdtemp(join(tmpdir(), "remo-s002-candidate-"));
  await exec("git", ["init", "--initial-branch=main"], { cwd: projectRoot, windowsHide: true });
  let application;
  try {
    application = await startLocalApplication({ projectRoot, webRoot: WEB_ROOT, port: 4175, seedDecisionFixtureTurn4: true, now: () => new Date("2026-08-16T07:34:00.000Z"), lifecycleSweepEveryMs: 60 * 60 * 1000 });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const expectedResponseLossRequests = new WeakSet();
    const failureState = failures(page, { expectedRequestFailures: expectedResponseLossRequests });
    const failureLedger = failureState.ledger;
    const initialCandidateRead = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/candidates/${ids(4).turnId}/decision` && response.status() === 200);
    await page.goto(`${ORIGIN}/candidate/review`, { waitUntil: "domcontentloaded" });
    await initialCandidateRead;
    await page.getByLabel("Decision question").waitFor();
    await waitForFirstPartyQuiet(failureState, "Candidate decision-entry readiness");
    await page.getByLabel("Decision question").fill("Should the navigation hierarchy change at this boundary?");
    await page.getByLabel("First considered option").fill("Adopt the revised hierarchy");
    await page.getByLabel("Second considered option").fill("Keep the prior hierarchy");
    await page.getByRole("radio").first().check();
    await page.getByLabel("Decision owner").fill("UI supervisor");
    await page.getByRole("combobox", { name: "Expressed uncertainty" }).selectOption("low");
    await page.locator(".decision-evidence-picker input").nth(1).check();
    await page.locator(".decision-evidence-picker input").nth(4).check();
    await page.getByLabel("Expected effect").fill("The revised hierarchy should make the primary destination easier to find.");
    await page.getByLabel(/Proposed from observable evidence/u).check();
    await page.getByLabel("Verification plan").fill("Verify keyboard order, responsive layout, and the selected destination.");
    const captures = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      captures.push(await capture(page, `s002-candidate-turn4-${viewport.name}.png`));
      await waitForFirstPartyQuiet(failureState, `Candidate capture ${viewport.name}`);
    }
    const candidateDecisionUrl = `${ORIGIN}/api/candidates/${ids(4).turnId}/decision`;
    let committed;
    await page.route(candidateDecisionUrl, async (route) => {
      const response = await route.fetch();
      assert(response.status() === 201, `Injected response-loss commit failed with ${response.status()}.`);
      committed = await response.json();
      expectedResponseLossRequests.add(route.request());
      await route.abort("failed");
    }, { times: 1 });
    await page.getByRole("button", { name: "Record decision before promotion" }).click();
    await page.locator(".decision-entry-action [role=alert]").waitFor();
    assert(committed !== undefined && committed.revision === 1, "The injected lost response did not commit exactly one candidate decision.");
    const afterLoss = await page.request.get(candidateDecisionUrl);
    const afterLossProjection = await afterLoss.json();
    assert(afterLoss.ok() && afterLossProjection.revisions.length === 1 && afterLossProjection.current.digest === committed.digest, "Response loss did not leave exactly one readable committed candidate decision.");
    assert(await page.getByRole("button", { name: "Confirm durable save" }).isDisabled(), "Promotion became available before the lost response was reconciled.");
    await page.unroute(candidateDecisionUrl);
    const retriedResponse = page.waitForResponse((response) => response.url() === candidateDecisionUrl && response.status() === 201);
    await page.getByRole("button", { name: "Record decision before promotion" }).click();
    const saved = await (await retriedResponse).json();
    assert(saved.digest === committed.digest, "Same-page retry did not return the exact committed decision identity.");
    const afterRetry = await page.request.get(candidateDecisionUrl);
    const afterRetryProjection = await afterRetry.json();
    assert(afterRetry.ok() && afterRetryProjection.revisions.length === 1 && afterRetryProjection.current.digest === saved.digest, "Same-page retry created a duplicate candidate decision.");
    assert(saved.revision === 1 && saved.expectedEffect.provenance === "inferred" && saved.outcome.provenance === "unknown", "Candidate decision did not preserve inferred and unknown provenance.");
    const reloadCandidateRead = page.waitForResponse((response) => response.url() === candidateDecisionUrl && response.status() === 200);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Recovered decision revision 1 recorded before promotion. Outcome remains unknown.", { exact: true }).waitFor();
    await reloadCandidateRead;
    await waitForFirstPartyQuiet(failureState, "Candidate reload recovery");
    const afterReload = await page.request.get(candidateDecisionUrl);
    const afterReloadProjection = await afterReload.json();
    assert(afterReload.ok() && afterReloadProjection.revisions.length === 1 && afterReloadProjection.current.digest === saved.digest, "Reload recovery did not preserve the exact single candidate decision.");
    const promote = page.getByRole("button", { name: "Confirm durable save" });
    assert(await promote.isEnabled(), "Durable promotion did not become available after lost-response retry and reload recovery.");
    await promote.click();
    await page.getByText("Durable save created", { exact: true }).waitFor();
    const durable = await page.request.get(`${ORIGIN}/api/save-points/${ids(4).savePointId}/decision`);
    assert(durable.ok(), "Promoted turn-4 decision was not readable.");
    const projection = await durable.json();
    assert(projection.current.digest === saved.digest && projection.current.revision === 1, "Promotion did not preserve the exact pre-promotion decision revision.");
    failureLedger.expectedResponseLossConsoleErrors = failureLedger.consoleErrors.filter((entry) => entry === `Failed to load resource: net::ERR_FAILED @ ${candidateDecisionUrl}`);
    failureLedger.unexpectedConsoleErrors = failureLedger.consoleErrors.filter((entry) => entry !== `Failed to load resource: net::ERR_FAILED @ ${candidateDecisionUrl}`);
    await waitForFirstPartyQuiet(failureState, "Candidate pre-teardown");
    await context.close();
    await waitForFirstPartyQuiet(failureState, "Candidate post-context-close teardown");
    assert(failureLedger.expectedResponseLosses.length === 1, `Expected exactly one causally bound response-loss failure: ${JSON.stringify(failureLedger)}`);
    assert(failureLedger.expectedResponseLossConsoleErrors.length === 1, `Expected exactly one causally bound response-loss console event: ${JSON.stringify(failureLedger)}`);
    assert(failureLedger.requestFailures.length === 1 && failureLedger.requestFailures[0] === `POST ${candidateDecisionUrl} net::ERR_FAILED`, `Response-loss requestfailed reporting was not retained verbatim: ${JSON.stringify(failureLedger)}`);
    assert(failureLedger.unexpectedConsoleErrors.length === 0 && failureLedger.pageErrors.length === 0 && failureLedger.unexpectedRequestFailures.length === 0 && failureLedger.requestErrors.length === 0 && failureLedger.unexpectedRequests.length === 0 && failureState.pendingFirstParty.size === 0, `Candidate browser failures after teardown: ${JSON.stringify(failureLedger)}`);
    await application.close(); application = undefined;
    application = await startLocalApplication({ projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false, now: () => new Date("2026-08-16T07:35:00.000Z"), lifecycleSweepEveryMs: 60 * 60 * 1000 });
    const restarted = await fetch(`${ORIGIN}/api/save-points/${ids(4).savePointId}/decision`);
    assert(restarted.ok && (await restarted.json()).current.digest === saved.digest, "Candidate decision was not durable across application restart.");
    return { truthLabel: "observed", sourcePointer: "production candidate UI and authenticated loopback mutation before explicit promotion", recordDigest: saved.digest, responseLossCommitted: true, samePageRetryRecovered: true, reloadRecovered: true, duplicateRevisionCount: 1, restartDurable: true, captures, failures: failureLedger };
  } finally {
    if (application !== undefined) await application.close().catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function appendBase(repository, turn, record) {
  repository.appendDecisionRevision({ savePointId: ids(turn).savePointId, turnId: ids(turn).turnId, revision: 1, canonicalRecord: record, expectedDigest: record.digest, recordedAt: record.question.recordedAt });
}

async function durableCases(report) {
  let clock = new Date("2026-08-16T08:30:00.000Z");
  let repository = new LocalSavePointRepository({ projectRoot: report.projectRoot, now: () => clock });
  const evidenceByTurn = new Map(report.promotionEvidence.map((entry) => [entry.turnId, entry.evidence.map(({ componentId }) => componentId)]));
  const identity = (savePointId) => {
    const entry = repository.listHistory().anchors.find((anchor) => anchor.savePointId === savePointId && anchor.state === "active");
    const evidenceComponentIds = entry === undefined ? undefined : evidenceByTurn.get(entry.turnId);
    return entry === undefined || evidenceComponentIds === undefined ? undefined : { savePointId, turnId: entry.turnId, evidenceComponentIds };
  };
  const service = createDecisionService({ repository, findCandidate: () => undefined, findDurable: identity, now: () => clock });
  const t4 = ids(4); const t4Evidence = evidenceByTurn.get(t4.turnId); assert(t4Evidence !== undefined, "Turn 4 evidence authority is missing.");
  const t4Stamp = "2026-08-16T08:04:00.000Z";
  const t4Record = buildDecisionRecord({ decisionId: "decision-turn-4", ...t4, revision: 1,
    question: field("Should the navigation hierarchy change at this boundary?", "user-supplied", [], t4Stamp),
    options: field([{ id: "adopt", label: "Adopt the revised hierarchy" }, { id: "retain", label: "Keep the prior hierarchy" }], "user-supplied", [], t4Stamp),
    selectedOptionId: field("adopt", "user-supplied", [], t4Stamp), owner: field("UI supervisor", "user-supplied", [], t4Stamp),
    uncertainty: field({ level: "low", source: "human" }, "user-supplied", [], t4Stamp), evidenceComponentIds: [t4Evidence[1], t4Evidence[5]],
    expectedEffect: field("The revised hierarchy should make the primary destination easier to find.", "inferred", [t4Evidence[1]], t4Stamp),
    verification: field("Verify keyboard order, responsive layout, and the selected destination.", "user-supplied", [t4Evidence[5]], t4Stamp), outcome: unknown(t4Stamp),
  });
  appendBase(repository, 4, t4Record);
  clock = new Date("2026-08-16T08:31:00.000Z");
  const confirmed = service.revise(t4.savePointId, { expectedRevision: 1, mutation: "confirm-inferred", fields: ["expectedEffect"] });
  assert(confirmed.expectedEffect.provenance === "inferred" && confirmed.expectedEffect.confirmedAt !== undefined, "Confirmation relabeled inferred provenance.");

  const t8 = ids(8); const t8Evidence = evidenceByTurn.get(t8.turnId); assert(t8Evidence !== undefined, "Turn 8 evidence authority is missing.");
  const t8Stamp = "2026-08-16T08:32:00.000Z";
  const t8Unknown = buildDecisionRecord({ decisionId: "decision-turn-8", ...t8, revision: 1, question: unknown(t8Stamp), options: unknown(t8Stamp), selectedOptionId: unknown(t8Stamp), owner: unknown(t8Stamp), uncertainty: unknown(t8Stamp), evidenceComponentIds: [], expectedEffect: unknown(t8Stamp), verification: unknown(t8Stamp), outcome: unknown(t8Stamp) });
  appendBase(repository, 8, t8Unknown);
  clock = new Date("2026-08-16T08:33:00.000Z");
  const reconstructed = service.revise(t8.savePointId, { expectedRevision: 1, mutation: "reconstructed-supplement", evidenceComponentIds: [t8Evidence[1], t8Evidence[5]], changes: {
    question: { value: "Which compact navigation treatment was retained?", provenance: "reconstructed", sourceComponentIds: [t8Evidence[1]] },
    options: { value: [{ id: "compact", label: "Retain compact navigation" }, { id: "expanded", label: "Restore expanded navigation" }], provenance: "reconstructed", sourceComponentIds: [t8Evidence[1]] },
    selectedOptionId: { value: "compact", provenance: "reconstructed", sourceComponentIds: [t8Evidence[1]] },
    expectedEffect: { value: "Compact navigation was expected to preserve content width.", provenance: "reconstructed", sourceComponentIds: [t8Evidence[1]] }, verification: { value: "Responsive verification evidence was preserved.", provenance: "reconstructed", sourceComponentIds: [t8Evidence[5]] },
  } });
  clock = new Date("2026-08-16T08:34:00.000Z");
  const corrected = service.revise(t8.savePointId, { expectedRevision: 2, mutation: "correction", changes: { expectedEffect: { value: "Compact navigation was retained to preserve room for the evidence panel.", provenance: "user-supplied", sourceComponentIds: [t8Evidence[5]] } } });
  assert(reconstructed.digest === corrected.predecessorDigest && t8Unknown.digest === reconstructed.predecessorDigest, "Turn 8 predecessor chain was rewritten.");
  assert(reconstructed.owner.provenance === "unknown" && reconstructed.owner.value === undefined && reconstructed.uncertainty.provenance === "unknown" && reconstructed.uncertainty.value === undefined, "Turn 8 reconstruction invented owner or uncertainty evidence.");
  assert(corrected.owner.provenance === "unknown" && corrected.owner.value === undefined && corrected.uncertainty.provenance === "unknown" && corrected.uncertainty.value === undefined, "Turn 8 correction upgraded unknown owner or uncertainty.");
  const turn4Manifest = repository.getCurrentRevision(t4.savePointId); const turn8Manifest = repository.getCurrentRevision(t8.savePointId);
  const revisions = {
    turn4: turn4Manifest === undefined ? undefined : { revision: turn4Manifest.revision, predecessorRevision: turn4Manifest.predecessorRevision, manifestDigest: turn4Manifest.manifestDigest, predecessorManifestDigest: turn4Manifest.predecessorManifestDigest },
    turn8: turn8Manifest === undefined ? undefined : { revision: turn8Manifest.revision, predecessorRevision: turn8Manifest.predecessorRevision, manifestDigest: turn8Manifest.manifestDigest, predecessorManifestDigest: turn8Manifest.predecessorManifestDigest },
  };
  assert(revisions.turn4?.revision === 3 && revisions.turn8?.revision === 4, "Decision and manifest revisions did not advance together.");
  repository.close();
  repository = new LocalSavePointRepository({ projectRoot: report.projectRoot, now: () => clock });
  const restartedService = createDecisionService({ repository, findCandidate: () => undefined, findDurable: identity, now: () => clock });
  const turn4 = restartedService.read(t4.savePointId); const turn8 = restartedService.read(t8.savePointId);
  assert(turn4?.revisions.length === 2 && turn8?.revisions.length === 3, "Decision revision chains did not survive restart.");
  repository.close();
  return { turn4, turn8, manifestRevisions: revisions, restartDurable: true };
}

const report = await runTenSaveSequence(ROOT);
let application;
let browser;
try {
  await mkdir(OUTPUT, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const candidate = await candidateBeforePromotion(browser);
  const cases = await durableCases(report);
  application = await startLocalApplication({ projectRoot: report.projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false, lifecycleSweepEveryMs: 60 * 60 * 1000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const verifierNavigation = createNavigationRequestLifecycle();
  const failureState = failures(page, { currentNavigation: () => verifierNavigation.current() });
  const failureLedger = failureState.ledger;
  const captures = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const turn of [4, 8, 7]) {
      const url = `${ORIGIN}/replay/${ids(turn).savePointId}`;
      await waitForFirstPartyQuiet(failureState, `Pre-navigation ${viewport.name} turn ${turn}`);
      const requiredDecisionUrl = `${ORIGIN}/api/save-points/${ids(turn).savePointId}/decision`;
      const requiredDecisionRead = page.waitForResponse((response) => response.url() === requiredDecisionUrl && response.status() === 200);
      const navigationId = `s002-${viewport.name}-turn-${turn}`;
      verifierNavigation.begin({ navigationId, url });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      verifierNavigation.documentLoaded(navigationId);
      const heading = turn === 7 ? "Decision context unknown" : turn === 4 ? "Should the navigation hierarchy change at this boundary?" : "Which compact navigation treatment was retained?";
      await page.getByRole("heading", { name: heading }).waitFor();
      await requiredDecisionRead;
      await waitForApplicationMediaReady(page, failureState, ids(turn).savePointId, `Decision and media readiness ${viewport.name} turn ${turn}`);
      if (turn === 4) {
        assert(await page.getByText("inferred", { exact: true }).count() > 0 && await page.getByText(/provenance unchanged/u).count() > 0, "Turn 4 did not expose inferred-confirmed evidence.");
        assert(await page.getByText("Unknown", { exact: true }).count() > 0, "Turn 4 did not preserve unknown outcome.");
      }
      if (turn === 8) {
        assert(await page.getByText("reconstructed", { exact: true }).count() > 0 && await page.getByText("Revision and supersession trail (3)").count() === 1, "Turn 8 did not expose reconstruction and correction history.");
        const owner = page.locator(".decision-field").filter({ has: page.locator("dt", { hasText: "Owner" }) });
        const uncertainty = page.locator(".decision-field").filter({ has: page.locator("dt", { hasText: "Uncertainty" }) });
        assert(await owner.locator("strong").innerText() === "Unknown" && await owner.getByText("unknown", { exact: true }).count() === 1, "Turn 8 owner was not visibly unknown.");
        assert(await uncertainty.locator("strong").innerText() === "Unknown" && await uncertainty.getByText("unknown", { exact: true }).count() === 1, "Turn 8 uncertainty was not visibly unknown.");
        const summary = page.getByText("Revision and supersession trail (3)"); await summary.focus(); await page.keyboard.press("Enter"); assert(await summary.evaluate((node) => node.parentElement.open), "Revision trail was not keyboard operable.");
      }
      captures.push(await capture(page, `s002-turn${turn}-${viewport.name}.png`));
      await waitForFirstPartyQuiet(failureState, `Post-capture ${viewport.name} turn ${turn}`);
      verifierNavigation.settle(navigationId);
    }
  }
  await waitForFirstPartyQuiet(failureState, "Final decision page");
  const teardownNavigationId = "s002-durable-blank-page-teardown";
  verifierNavigation.begin({ navigationId: teardownNavigationId, url: "about:blank" });
  await page.goto("about:blank", { waitUntil: "load" });
  verifierNavigation.documentLoaded(teardownNavigationId);
  await waitForFirstPartyQuiet(failureState, "Blank-page teardown");
  await context.close();
  await waitForFirstPartyQuiet(failureState, "Post-context-close teardown");
  verifierNavigation.settle(teardownNavigationId);
  failureLedger.unexpectedConsoleErrors = [...failureLedger.consoleErrors];
  assert(failureLedger.unexpectedConsoleErrors.length === 0 && failureLedger.pageErrors.length === 0 && failureLedger.requestFailures.length === 0 && failureLedger.unexpectedRequestFailures.length === 0 && failureLedger.requestErrors.length === 0 && failureLedger.unexpectedRequests.length === 0 && failureState.pendingFirstParty.size === 0, `Decision-card browser failures after teardown: ${JSON.stringify(failureLedger)}`);
  assert(failureLedger.navigationMediaCancellations.length === EXPECTED_NAVIGATION_MEDIA_CANCELLATIONS, `Expected exactly ${EXPECTED_NAVIGATION_MEDIA_CANCELLATIONS} causally bound navigation cancellations: ${JSON.stringify(failureLedger)}`);
  assert(new Set(failureLedger.navigationMediaCancellations.map(({ requestId }) => requestId)).size === EXPECTED_NAVIGATION_MEDIA_CANCELLATIONS && failureLedger.navigationMediaCancellations.every(({ navigationId, navigationUrl }) => typeof navigationId === "string" && typeof navigationUrl === "string"), `Navigation cancellation identities were duplicated or unbound: ${JSON.stringify(failureLedger)}`);
  assert(failureLedger.observedUnknownDecisionReads.length === EXPECTED_UNKNOWN_DECISION_READS, `Expected exactly ${EXPECTED_UNKNOWN_DECISION_READS} known-unknown decision reads: ${JSON.stringify(failureLedger)}`);
  const ledger = {
    event: "s002.structured-decision-evidence.fixture-verification",
    occurredAt: new Date().toISOString(),
    runtime: { truthLabel: "observed", node: process.version, playwright: playwrightVersion, origin: ORIGIN, webRoot: "apps/web/dist", outputMode: refreshCommitted ? "explicit-committed-refresh" : "isolated-default", evidenceRoot: EVIDENCE_ROOT },
    acceptanceBoundary: { truthLabel: "verified", claim: "S-002 fixture verification passed; this is not production acceptance." },
    evidence: {
      candidate,
      durable: {
        truthLabel: "observed",
        sourcePointer: "VS-001 ten-save fixture extended through production storage/service/replay seams",
        turn4RevisionCount: cases.turn4.revisions.length,
        turn8RevisionCount: cases.turn8.revisions.length,
        inferredConfirmed: true,
        reconstructed: true,
        corrected: true,
        unknown: true,
        turn8OwnerUnknown: cases.turn8.current.owner.provenance === "unknown" && cases.turn8.current.owner.value === undefined,
        turn8UncertaintyUnknown: cases.turn8.current.uncertainty.provenance === "unknown" && cases.turn8.current.uncertainty.value === undefined,
        exactNavigationMediaCancellations: failureLedger.navigationMediaCancellations.length,
        exactUnknownDecisionReads: failureLedger.observedUnknownDecisionReads.length,
        restartDurable: cases.restartDurable,
        manifestRevisions: cases.manifestRevisions,
        captures,
        failures: failureLedger,
      },
    },
  };
  await writeFile(resolve(OUTPUT, "s002-acceptance-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ event: ledger.event, verdict: "PASS", acceptanceClaim: "fixture-verification-not-production-acceptance", outputMode: ledger.runtime.outputMode, captures: candidate.captures.length + captures.length, responseLossCommitted: true, exactResponseLosses: candidate.failures.expectedResponseLosses.length, samePageRetryRecovered: true, reloadRecovered: true, inferredConfirmed: true, reconstructed: true, corrected: true, unknown: true, turn8OwnerUnknown: true, turn8UncertaintyUnknown: true, exactNavigationMediaCancellations: EXPECTED_NAVIGATION_MEDIA_CANCELLATIONS, exactUnknownDecisionReads: EXPECTED_UNKNOWN_DECISION_READS, unexpectedCancellations: failureLedger.unexpectedRequestFailures.length, pendingFirstPartyRequests: failureState.pendingFirstParty.size, restartDurable: true })}\n`);
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (application !== undefined) await application.close().catch(() => undefined);
  await report.dispose().catch(() => undefined);
  if (!refreshCommitted) process.stdout.write(`${JSON.stringify({ event: "s002.isolated-output-retained", output: OUTPUT.replaceAll("\\", "/") })}\n`);
}
