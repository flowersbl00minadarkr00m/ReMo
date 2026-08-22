/* global document, fetch, getComputedStyle, HTMLImageElement, HTMLElement, process, setTimeout, URL, URLSearchParams */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { runTenSaveSequence } from "../../../../../service/src/acceptance-sequence/ten-save-sequence.ts";
import { startLocalApplication } from "../../../../../service/src/promotion/local-application.ts";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const WEB_ROOT = resolve(ROOT, "apps/web/dist");
const COMMITTED_OUTPUT = resolve(import.meta.dirname);
const EVIDENCE_ROOT = "apps/web/src/features/comparison/verification";
const ORIGIN = "http://127.0.0.1:4175";
const VIEWPORTS = [
  { name: "320", width: 320, height: 720 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
];
const refreshCommitted = process.env.REMO_REFRESH_S004_EVIDENCE === "1";
const output = refreshCommitted ? COMMITTED_OUTPUT : await mkdtemp(resolve(tmpdir(), "remo-s004-output-"));
const requireService = createRequire(resolve(ROOT, "apps/service/package.json"));
const { chromium } = requireService("playwright");
const playwrightVersion = requireService("playwright/package.json").version;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const FIRST_PARTY_QUIET_MS = 200;

function attachFailureLedger(page, failures) {
  const tracker = { pending: new Set(), lastActivityAt: Date.now() };
  const observed = () => { tracker.lastActivityAt = Date.now(); };
  page.on("console", (message) => { if (message.type() === "error") failures.consoleErrors.push(`${message.text()} @ ${page.url()}`); });
  page.on("pageerror", (error) => failures.pageErrors.push(`${error.message} @ ${page.url()}`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === ORIGIN) { tracker.pending.add(request); observed(); }
    if (url.protocol === "http:" && url.origin !== ORIGIN) failures.unexpectedRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on("requestfinished", (request) => { if (tracker.pending.delete(request)) observed(); });
  page.on("requestfailed", (request) => {
    tracker.pending.delete(request);
    observed();
    failures.requestErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
  });
  page.on("response", (response) => { if (response.status() >= 400) failures.requestErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`); });
  return tracker;
}

async function waitForFirstPartySettlement(tracker, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (tracker.pending.size === 0 && Date.now() - tracker.lastActivityAt >= FIRST_PARTY_QUIET_MS) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert(false, `${label} did not reach a ${FIRST_PARTY_QUIET_MS}ms first-party quiet window: pending=${JSON.stringify([...tracker.pending].map((request) => `${request.method()} ${request.url()}`))}, quietForMs=${Date.now() - tracker.lastActivityAt}`);
}

async function waitForComparison(page, tracker, expectedImages) {
  try {
    await page.getByRole("heading", { name: "Comparison qualification" }).waitFor();
    await page.locator(".comparison-state").waitFor({ state: "detached" });
    await page.locator(".comparison-picker select").first().locator("option").nth(1).waitFor({ state: "attached" });
    await page.locator(".comparison-media-state[role=status]").waitFor({ state: "detached" });
    if (expectedImages > 0) {
      await page.locator(".comparison-screenshot img").first().waitFor();
      await page.locator(".comparison-screenshot img").evaluateAll(async (images) => Promise.all(images.map(async (image) => {
        if (!(image instanceof HTMLImageElement)) throw new Error("Comparison media is not an image.");
        if (!image.complete) await new Promise((resolveImage, rejectImage) => { image.addEventListener("load", resolveImage, { once: true }); image.addEventListener("error", rejectImage, { once: true }); });
        await image.decode();
      })));
    }
    await page.waitForFunction(() => document.querySelector(".comparison-workspace")?.getAttribute("aria-busy") === "false");
    assert(await page.locator(".comparison-screenshot img").count() === expectedImages, `Expected ${expectedImages} authenticated screenshots.`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    await waitForFirstPartySettlement(tracker, "Comparison readiness");
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: document.location.href,
      readyState: document.readyState,
      ariaBusy: document.querySelector(".comparison-workspace")?.getAttribute("aria-busy") ?? "missing",
      comparisonState: [...document.querySelectorAll(".comparison-state")].map((element) => element.textContent?.trim() ?? ""),
      qualificationPresent: document.querySelector("#comparison-qualification-title") !== null,
      screenshotCount: document.querySelectorAll(".comparison-screenshot img").length,
    })).catch((diagnosticError) => ({ diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) }));
    throw new Error(`Comparison readiness failed: cause=${error instanceof Error ? error.message : String(error)} diagnostics=${JSON.stringify(state)} pending=${JSON.stringify([...tracker.pending].map((request) => `${request.method()} ${request.url()}`))}`);
  }
}

async function capture(page, pendingFirstParty, state, pair, viewport, expectedImages) {
  await waitForFirstPartySettlement(pendingFirstParty, "Pre-navigation");
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${ORIGIN}/compare?${new URLSearchParams({ left: pair.left, right: pair.right })}`, { waitUntil: "networkidle" });
  await waitForComparison(page, pendingFirstParty, expectedImages);
  const qualification = await page.locator(".comparison-qualification").innerText();
  const qualificationText = qualification.toLocaleLowerCase("en-US");
  if (state === "matched") assert(qualificationText.includes("mismatch blocks equivalence") && qualificationText.includes("decision evidence") && qualificationText.includes("unknown"), `Context-matched decision-unknown comparison was not visibly blocked: ${qualification}`);
  else assert(qualificationText.includes("mismatch blocks equivalence") && qualificationText.includes("mismatch"), `${state} comparison did not communicate mismatch in text.`);
  const roles = await page.locator(".comparison-side .comparison-role").allTextContents();
  assert(JSON.stringify(roles) === JSON.stringify(["Before · left", "After · right"]), `Comparison reading order or roles changed: ${JSON.stringify(roles)}`);
  const sideIdentities = await page.locator(".comparison-side-identity").allTextContents();
  assert(sideIdentities.length === 2 && sideIdentities.every((value) => value.includes("Lineage ")), `Persistent side identity is incomplete: ${JSON.stringify(sideIdentities)}`);
  const evidenceLabels = await page.locator(".comparison-side dt").allTextContents();
  for (const label of ["Source change", "Decision", "Verification", "Integrity", "Fidelity"]) assert(evidenceLabels.filter((value) => value === label).length === 2, `${state} omitted ${label} on a side.`);
  if (state === "degraded") assert((await page.getByText(/Deleted side.*protected media is not fetched/u).count()) === 1, "Deleted side did not expose its no-fetch degradation.");
  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(dimensions.scrollWidth <= dimensions.clientWidth, `${state}-${viewport.name} has document-level horizontal overflow: ${JSON.stringify(dimensions)}`);
  const narrowSides = await page.locator(".comparison-side").evaluateAll((sides) => sides.map((side) => {
    const identity = side.querySelector(".comparison-side-identity");
    const style = getComputedStyle(side);
    const identityStyle = identity === null ? undefined : getComputedStyle(identity);
    const before = side.scrollTop;
    side.scrollTop = Math.min(80, side.scrollHeight);
    const after = side.scrollTop;
    side.scrollTop = before;
    return { overflowY: style.overflowY, scrollHeight: side.scrollHeight, clientHeight: side.clientHeight, scrolled: after > 0, identityPosition: identityStyle?.position };
  }));
  if (viewport.width <= 390) assert(narrowSides.length === 2 && narrowSides.every(({ overflowY, scrollHeight, clientHeight, scrolled, identityPosition }) => overflowY === "auto" && scrollHeight > clientHeight && scrolled && identityPosition === "sticky"), `${state}-${viewport.name} lacks independently scrollable sides with sticky identity: ${JSON.stringify(narrowSides)}`);
  const primary = page.getByRole("button", { name: "Compare selected turns" });
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  for (let index = 0; index < 20 && !(await primary.evaluate((element) => document.activeElement === element)); index += 1) await page.keyboard.press("Tab");
  const focus = await primary.evaluate((element) => { const style = getComputedStyle(element); return { active: document.activeElement === element, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }; });
  assert(focus.active && focus.outlineStyle !== "none" && focus.outlineWidth !== "0px", `${state}-${viewport.name} lacks visible keyboard focus: ${JSON.stringify(focus)}`);
  const fileName = `s004-${state}-${viewport.name}.png`;
  const file = resolve(output, fileName);
  await page.screenshot({ path: file, fullPage: true });
  await waitForFirstPartySettlement(pendingFirstParty, `Post-capture ${state}-${viewport.name}`);
  return { fileName, file, state, viewport: { width: viewport.width, height: viewport.height }, dimensions, focus, roles, sideIdentities, narrowSides, qualification };
}

function assertObservedBinding(side) {
  assert(side.context?.provenance === "observed", `Comparison context is not observed for ${side.savePointId}: ${JSON.stringify(side)}`);
  assert(side.screenshot?.availability === "available" && side.screenshot.componentId.endsWith(":screenshot") && /^sha256:[0-9a-f]{64}$/u.test(side.screenshot.digest), `Authenticated screenshot metadata is incomplete for ${side.savePointId}.`);
  assert(side.context.viewport.width === side.screenshot.width && side.context.viewport.height === side.screenshot.height, `Observed context is not dimension-bound to ${side.savePointId}'s screenshot.`);
}

await mkdir(output, { recursive: true });
const report = await runTenSaveSequence(ROOT, { captureViewportByTurn: { 3: { width: 1440, height: 1000 } } });
let application;
let browser;
let context;
try {
  const activeIds = report.summaries.map(({ savePointId }) => savePointId);
  const matchedCandidates = report.summaries.filter(({ integrity, fidelity }) => integrity === "Complete" && fidelity === "Editable eligible");
  assert(activeIds.length === 9, "S-004 expected nine active save points after the established deletion fixture.");
  assert(matchedCandidates.length >= 3, "S-004 requires three safely viewable complete fixture turns.");
  const before = matchedCandidates[0]?.savePointId;
  const after = matchedCandidates[1]?.savePointId;
  const mismatchAfter = matchedCandidates[2]?.savePointId;
  const deleted = "01J00000000000000000000S06";
  assert(before !== undefined && after !== undefined && mismatchAfter !== undefined, "S-004 pair identities are incomplete.");
  application = await startLocalApplication({ projectRoot: report.projectRoot, webRoot: WEB_ROOT, port: 4175, seedImplementationFixture: false });
  const sameIdentity = await fetch(`${ORIGIN}/api/comparisons?left=${before}&right=${before}`);
  assert(sameIdentity.status === 400 && (await sameIdentity.json()).error === "comparison.same-identity", "Same-identity comparison was not rejected.");
  const deletedProjection = await (await fetch(`${ORIGIN}/api/comparisons?left=${before}&right=${deleted}`)).json();
  assert(deletedProjection.right.state === "deleted" && deletedProjection.right.screenshot.availability === "unavailable" && deletedProjection.parityClaimAllowed === false, "Deleted side did not remain payload-neutral and equivalence-blocking.");
  const matchedProjection = await (await fetch(`${ORIGIN}/api/comparisons?left=${before}&right=${after}`)).json();
  const mismatchProjection = await (await fetch(`${ORIGIN}/api/comparisons?left=${before}&right=${mismatchAfter}`)).json();
  for (const side of [matchedProjection.left, matchedProjection.right, mismatchProjection.left, mismatchProjection.right]) assertObservedBinding(side);
  assert(matchedProjection.parityClaimAllowed === false && matchedProjection.left.decision.state === "unknown" && matchedProjection.right.decision.state === "unknown", "Context-matched production pair did not fail closed on its truthful unknown decisions.");
  assert(matchedProjection.left.context.route === matchedProjection.right.context.route
    && matchedProjection.left.context.viewport.width === 1440 && matchedProjection.right.context.viewport.width === 1440
    && matchedProjection.left.context.viewport.height === matchedProjection.right.context.viewport.height
    && matchedProjection.left.context.fixture === matchedProjection.right.context.fixture
    && matchedProjection.left.context.dependencyDigest === matchedProjection.right.context.dependencyDigest
    && JSON.stringify(matchedProjection.left.context.policyRevisions) === JSON.stringify(matchedProjection.right.context.policyRevisions)
    && matchedProjection.left.context.lineageId === matchedProjection.right.context.lineageId,
  "Matched-layout production pair did not retain equal independently observed comparison context.");
  assert(matchedProjection.qualifiers.some(({ code, severity, explanation }) => code === "evidence" && severity === "blocks-equivalence" && explanation.includes("decision evidence") && explanation.includes("unknown")), "Context-matched decision-unknown pair omitted its blocking evidence qualifier.");
  assert(mismatchProjection.parityClaimAllowed === false && mismatchProjection.right.context.viewport.width === 1440 && mismatchProjection.right.context.viewport.height === 1000, "Production mismatch did not come from the independently captured alternate-viewport save.");
  assert(mismatchProjection.qualifiers.some(({ code, explanation }) => code === "viewport" && explanation.includes("1440x900") && explanation.includes("1440x1000")), "Observed viewport mismatch was not qualified.");
  assert(!mismatchProjection.qualifiers.some(({ code }) => code === "lineage"), "Forbidden lineage qualifier enum escaped into S-004.");
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const failures = { consoleErrors: [], pageErrors: [], requestErrors: [], unexpectedRequests: [] };
  const pendingFirstParty = attachFailureLedger(page, failures);
  const captures = [];
  for (const viewport of VIEWPORTS) {
    captures.push(await capture(page, pendingFirstParty, "matched", { left: before, right: after }, viewport, 2));
    captures.push(await capture(page, pendingFirstParty, "mismatch", { left: before, right: mismatchAfter }, viewport, 2));
    captures.push(await capture(page, pendingFirstParty, "degraded", { left: before, right: deleted }, viewport, 1));
  }
  await page.waitForLoadState("networkidle");
  await waitForFirstPartySettlement(pendingFirstParty, "Final comparison page");
  await page.goto("about:blank", { waitUntil: "load" });
  await waitForFirstPartySettlement(pendingFirstParty, "Blank-page teardown");
  await context.close();
  context = undefined;
  await waitForFirstPartySettlement(pendingFirstParty, "Post-context-close teardown");
  assert(failures.consoleErrors.length === 0, `Unexpected console errors: ${JSON.stringify(failures.consoleErrors)}`);
  assert(failures.pageErrors.length === 0, `Unexpected page errors: ${JSON.stringify(failures.pageErrors)}`);
  assert(failures.requestErrors.length === 0, `Unexpected request errors: ${JSON.stringify(failures.requestErrors)}`);
  assert(failures.unexpectedRequests.length === 0, `Unexpected requests: ${JSON.stringify(failures.unexpectedRequests)}`);
  const captureEvidence = [];
  for (const item of captures) {
    const bytes = await readFile(item.file);
    const stableItem = { ...item };
    delete stableItem.file;
    captureEvidence.push({ ...stableItem, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const binding = (side) => ({ savePointId: side.savePointId, componentId: side.screenshot.componentId, digest: side.screenshot.digest, dimensions: { width: side.screenshot.width, height: side.screenshot.height }, context: side.context });
  const ledger = {
    event: "s004.qualified-basic-comparison.production-fixture-verification",
    runtime: { truthLabel: "observed", sourcePointer: "production web build and local application at exact 127.0.0.1:4175", node: process.version, playwright: playwrightVersion, outputMode: refreshCommitted ? "explicit-committed-refresh" : "isolated-default", evidenceRoot: EVIDENCE_ROOT },
    acceptanceBoundary: { truthLabel: "verified", sourcePointer: "actual production UI, authenticated immutable per-save screenshots, persisted capture context, and assertions in apps/web/src/features/comparison/verification/verify-s004.mjs", claim: "S-004 context-matched layout with truthful unknown-decision parity blocking, independently observed viewport mismatch, same-identity rejection, and deleted-side degradation passed without rich-diff or verdict claims." },
    pairs: { matched: { before: binding(matchedProjection.left), after: binding(matchedProjection.right) }, mismatch: { before: binding(mismatchProjection.left), after: binding(mismatchProjection.right), truthLabel: "verified", sourcePointer: "independent production capture/save paths; turn 3 was captured and persisted at 1440x1000" }, degraded: { before, after: deleted } },
    sameIdentityRejection: { status: sameIdentity.status, error: "comparison.same-identity" },
    deletedSide: { state: deletedProjection.right.state, screenshot: deletedProjection.right.screenshot.availability, parityClaimAllowed: deletedProjection.parityClaimAllowed, protectedFetch: false },
    matchedContext: { parityClaimAllowed: matchedProjection.parityClaimAllowed, decisions: [matchedProjection.left.decision.state, matchedProjection.right.decision.state], qualifiers: matchedProjection.qualifiers },
    mismatch: { parityClaimAllowed: mismatchProjection.parityClaimAllowed, qualifiers: mismatchProjection.qualifiers },
    lifecycle: { quietWindowMs: FIRST_PARTY_QUIET_MS, pendingFirstPartyRequests: pendingFirstParty.pending.size, contextClosedBeforeFailureAssertions: true },
    failures,
    captures: captureEvidence,
  };
  await writeFile(resolve(output, "s004-acceptance-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ event: ledger.event, verdict: "PASS", outputMode: ledger.runtime.outputMode, captures: captures.length, sameIdentity: true, deletedNoFetch: true, zeroUnexpectedErrors: true })}\n`);
} finally {
  if (context !== undefined) await context.close().catch(() => undefined);
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (application !== undefined) await application.close().catch(() => undefined);
  await report.dispose().catch(() => undefined);
  if (!refreshCommitted) process.stdout.write(`${JSON.stringify({ event: "s004.isolated-output-retained", output: output.replaceAll("\\", "/") })}\n`);
}
