/* global URL, document, window, getComputedStyle, requestAnimationFrame, HTMLElement, performance, localStorage, sessionStorage, indexedDB, caches, navigator, process, fetch */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  completeRequestLifecycle,
  createResourceInventoryAudit,
  deriveFinalRequestChannels,
  expectedResourceInventory,
  selectFinalVerificationError,
  waitForInitialReplaySettlement,
  waitForStableRequestQuiescence,
} from "./verify-t5-contract.mjs";
import { runControlledComparisonProfile } from "./verify-t6-performance.mjs";

const verificationTask = process.env.REMO_REL001_VERIFICATION_TASK ?? "T5";
const baseUrlVariable = `REMO_${verificationTask}_BASE_URL`;
const outputVariable = `REMO_${verificationTask}_OUTPUT`;
const baseUrl = process.env[baseUrlVariable];
if (!baseUrl) throw new Error(`${baseUrlVariable} is required.`);
const repositoryRoot = resolve(import.meta.dirname, "../../../../../..");
const requireService = createRequire(resolve(repositoryRoot, "apps/service/package.json"));
const { chromium } = requireService("playwright");
const expectedOrigin = new URL(baseUrl).origin;
const outputRoot = resolve(process.env[outputVariable] ?? resolve(import.meta.dirname, "artifacts"));
const expectedInventory = expectedResourceInventory(expectedOrigin);
const resourceAudit = createResourceInventoryAudit(expectedOrigin, expectedInventory);
const directHtmlRoutes = ["/", "/save-points", "/replay"];
const viewports = [
  { name: "320", width: 320, height: 720 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function layoutEvidence(page, label) {
  const evidence = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const shell = document.querySelector(".hosted-demo-shell");
    const filmstrip = document.querySelector(".filmstrip-region");
    const scroll = document.querySelector(".filmstrip-scroll");
    const bounds = (element) => element === null ? undefined : {
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      width: element.getBoundingClientRect().width,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
    return {
      viewportWidth: window.innerWidth,
      document: { clientWidth: documentElement.clientWidth, scrollWidth: documentElement.scrollWidth },
      shell: bounds(shell),
      filmstrip: bounds(filmstrip),
      scroll: bounds(scroll),
    };
  });
  assert(evidence.document.scrollWidth <= evidence.document.clientWidth, `${label} document overflow: ${JSON.stringify(evidence)}`);
  assert(evidence.shell === undefined || (evidence.shell.left >= 0 && evidence.shell.right <= evidence.viewportWidth + 0.5), `${label} shell overflow: ${JSON.stringify(evidence)}`);
  assert(evidence.filmstrip === undefined || evidence.filmstrip.width <= evidence.viewportWidth + 0.5, `${label} filmstrip intrinsic overflow: ${JSON.stringify(evidence)}`);
  return evidence;
}

async function assertAccessibleNames(page, label) {
  const unnamed = await page.locator("a, button, input, iframe").evaluateAll((elements) => elements.flatMap((element) => {
    const labels = "labels" in element && element.labels ? [...element.labels].map((item) => item.textContent ?? "").join(" ") : "";
    const name = [element.getAttribute("aria-label"), element.getAttribute("title"), labels, element.textContent]
      .find((value) => value !== null && value.trim().length > 0) ?? "";
    return name.trim().length === 0 ? [element.outerHTML.slice(0, 160)] : [];
  }));
  assert(unnamed.length === 0, `${label} unnamed controls: ${JSON.stringify(unnamed)}`);
}

async function contrastEvidence(page) {
  return page.evaluate(() => {
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const rgb = (value) => {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/u);
      if (!match) throw new Error(`Unsupported computed color: ${value}`);
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const luminance = (value) => {
      const [red, green, blue] = rgb(value).map(channel);
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const ratio = (foreground, background) => {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const current = document.querySelector('.hosted-demo-navigation a[aria-current="page"]');
    const action = document.querySelector(".hosted-demo-comparison-link");
    if (current === null || action === null) throw new Error("Contrast targets are unavailable.");
    const currentStyle = getComputedStyle(current);
    const actionStyle = getComputedStyle(action);
    return {
      currentNavigation: ratio(currentStyle.color, currentStyle.backgroundColor),
      primaryAction: ratio(actionStyle.color, actionStyle.backgroundColor),
    };
  });
}

async function capture(page, state, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  const layout = await layoutEvidence(page, `${state}-${viewport.name}`);
  await assertAccessibleNames(page, `${state}-${viewport.name}`);
  const file = resolve(outputRoot, `${state}-${viewport.name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const bytes = await readFile(file);
  return { state, viewport, file: `${state}-${viewport.name}.png`, bytes: bytes.byteLength, sha256: sha256(bytes), layout };
}

await mkdir(outputRoot, { recursive: true });
const measurements = {};
let controlledProfileError;
if (verificationTask === "T6") {
  measurements.controlledComparisonProfile = await runControlledComparisonProfile({ chromium, repositoryRoot });
  if (measurements.controlledComparisonProfile.verdict !== "PASS") {
    controlledProfileError = new Error(`Controlled comparison profile failed: ${measurements.controlledComparisonProfile.errors.join(" ")}`);
  }
}
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
  serviceWorkers: "block",
});
const page = await context.newPage();
const requests = new Map();
const requestLedger = [];
const consoleLedger = [];
const pageErrors = [];
const responseSettlements = [];
const integrityFailures = [];
let primaryError;
let teardownError;
let finalChannels;
let finalVerificationError;
let activeRouteSettled = true;
let requestActivityVersion = 0;

page.on("request", (request) => {
  requestActivityVersion += 1;
  const navigationRole = request.isNavigationRequest() && request.resourceType() === "document"
    ? request.frame() === page.mainFrame() ? "top-document" : "iframe"
    : undefined;
  requests.set(request, { url: request.url(), method: request.method(), navigationRole, startedAt: Date.now() });
});
page.on("requestfinished", (request) => {
  const entry = requests.get(request);
  const settlement = (async () => {
    let status;
    try {
      const response = await request.response();
      if (response === null) throw new Error(`Finished request has no response: ${request.url()}.`);
      status = response.status();
      const body = status === 304 ? new Uint8Array() : await response.body();
      const integrity = resourceAudit.record({
        method: request.method(),
        url: request.url(),
        status: response.status(),
        contentType: response.headers()["content-type"] ?? "",
        body,
        headers: response.headers(),
        navigationRole: entry?.navigationRole,
      });
      requestLedger.push({ ...entry, status, failure: undefined, integrity });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      integrityFailures.push({ url: request.url(), method: request.method(), error: message });
      requestLedger.push({ ...entry, status, failure: undefined, integrityFailure: message });
    } finally {
      requests.delete(request);
    }
  })();
  responseSettlements.push(settlement);
});
page.on("requestfailed", (request) => {
  const entry = requests.get(request);
  requests.delete(request);
  requestLedger.push({ ...entry, status: undefined, failure: request.failure()?.errorText ?? "unknown" });
});
page.on("console", (message) => consoleLedger.push({ type: message.type(), text: message.text() }));
page.on("pageerror", (error) => pageErrors.push(error.message));

async function drainResponseSettlements() {
  let settled = 0;
  while (settled < responseSettlements.length) {
    const batch = responseSettlements.slice(settled);
    settled = responseSettlements.length;
    await Promise.all(batch);
  }
}

async function drainRequestLifecycle() {
  await drainResponseSettlements();
  assert(integrityFailures.length === 0, `Resource integrity failures: ${JSON.stringify(integrityFailures)}`);
}

async function settleRequestLifecycle() {
  await drainRequestLifecycle();
  assert(requests.size === 0, `Pending requests: ${JSON.stringify([...requests.values()])}`);
}

async function waitForSelectedEvidenceState() {
  await page.waitForFunction(() => {
    const history = document.querySelector(".hosted-demo-history");
    if (history === null) return true;
    const selection = history.querySelector(".hosted-demo-selection");
    if (selection === null) return false;
    if (selection.getAttribute("role") === "alert" || selection.getAttribute("role") === "status") return true;
    const selected = history.querySelector('[role="option"][aria-selected="true"]');
    if (!selected?.getAttribute("aria-label")?.startsWith("Turn 4,")) return true;
    const media = selection.querySelector(".evidence-media");
    if (media === null || media.querySelector(".media-loading") !== null) return false;
    const stateHeadings = [...media.querySelectorAll(".media-state strong")].map((element) => element.textContent ?? "");
    const screenshotReady = media.querySelector(".captured-screenshot") !== null || stateHeadings.some((heading) => heading.startsWith("Screenshot"));
    const replayReady = media.querySelector(".hosted-demo-replay") !== null || stateHeadings.some((heading) => heading.startsWith("Replay"));
    return screenshotReady && replayReady;
  });
}

async function settleCurrentRoute() {
  await waitForStableRequestQuiescence({
    waitForSelectedEvidence: waitForSelectedEvidenceState,
    replayIsPresent: async () => (await page.getByTitle("Isolated same-origin synthetic replay").count()) > 0,
    waitForReplayReady: async () => { await waitForInitialReplaySettlement(page); },
    drainResponses: async () => { await drainRequestLifecycle(); },
    observeBoundary: async () => page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))),
    activityVersion: () => requestActivityVersion,
    pendingCount: () => requests.size,
  });
  activeRouteSettled = true;
}

async function navigateToHtmlRoute(path, ready) {
  assert(activeRouteSettled, `Navigation left an unsettled route before ${path}.`);
  activeRouteSettled = false;
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  await ready();
  await settleCurrentRoute();
}

async function followClientRoute(action, ready) {
  assert(activeRouteSettled, "Client navigation left an unsettled route.");
  activeRouteSettled = false;
  await action();
  await ready();
  await settleCurrentRoute();
}

async function probeMissingNonHtmlInventory(page) {
  const paths = [...expectedInventory.entries()]
    .filter(([path, expected]) => expected.contentType !== "text/html" && !resourceAudit.seen.has(path))
    .map(([path]) => path);
  const results = await page.evaluate(async (paths) => {
    const responses = [];
    for (const path of paths) {
      const response = await fetch(path, { credentials: "omit", cache: "no-store", redirect: "error" });
      await response.arrayBuffer();
      responses.push({ path, status: response.status });
    }
    return responses;
  }, paths);
  assert(results.every(({ status }) => status === 200), `Inventory probe returned non-200 status: ${JSON.stringify(results)}`);
  await settleRequestLifecycle();
  return results;
}

const captures = [];
try {
  if (controlledProfileError !== undefined) throw controlledProfileError;
  const primaryStarted = Date.now();
  await navigateToHtmlRoute("/replay/demo-save-04", async () => {
    await page.getByRole("heading", { name: "Choose the consequential turn" }).waitFor();
    await page.getByRole("button", { name: "Run simulated preflight" }).waitFor();
    measurements.primaryUsableMs = Date.now() - primaryStarted;
  });
  assert(measurements.primaryUsableMs <= 2_500, `Primary controls usable in ${measurements.primaryUsableMs}ms, exceeding 2500ms.`);
  await page.getByText("Reduced-motion preference detected.").waitFor();
  assert((await page.getByText("Local installation package is on the planned roadmap. Coming to GitHub soon.").count()) === 1, "Exact roadmap CTA is missing or duplicated.");
  assert((await page.getByRole("link", { name: /download|install package|github/u }).count()) === 0, "Hosted CTA exposes a prohibited download/source link.");
  assert((await page.getByText(/Simulated\./u).count()) > 0, "Explicit simulation label is missing.");
  const anchorLabels = await page.getByRole("option").evaluateAll((options) => options.map((option) => option.getAttribute("aria-label")));
  assert(anchorLabels.length === 10, `Expected ten filmstrip anchors, received ${anchorLabels.length}.`);
  assert(anchorLabels.every((label, index) => label?.startsWith(`Turn ${index + 1},`)), `Filmstrip identities are not the exact ordered ten-turn fixture: ${JSON.stringify(anchorLabels)}.`);

  const screenshot = page.locator(".captured-screenshot img");
  await screenshot.waitFor();
  const screenshotEvidence = await screenshot.evaluate((image) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
    alt: image.alt,
  }));
  assert(screenshotEvidence.width === 1_440 && screenshotEvidence.height === 900 && screenshotEvidence.alt === "Privacy-checked captured UI for save point demo-save-04; viewport 1440 by 900.", `Turn 4 screenshot identity mismatch: ${JSON.stringify(screenshotEvidence)}.`);
  assert(await page.locator(".captured-screenshot figcaption").getByText("demo-turn-04:screenshot", { exact: true }).isVisible(), "Turn 4 screenshot component identity is missing.");
  await page.getByRole("heading", { name: "Bounded hosted replay" }).waitFor();
  await page.getByText("Replay paused", { exact: true }).waitFor();
  const replayRange = page.getByRole("slider", { name: "Seek within replay" });
  assert((await replayRange.getAttribute("max")) === "1252", "Hosted replay is not bound to the exact 1,252 ms fixture duration.");
  await page.getByRole("button", { name: "Start replay" }).click();
  await page.getByText("Playing synthetic historical evidence", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByText("Replay paused", { exact: true }).waitFor();
  await replayRange.fill("1250");
  await page.getByText("1.3s / 1.3s", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Restart" }).click();
  await page.getByText("0.0s / 1.3s", { exact: true }).waitFor();
  await page.getByText("Replay paused", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Should the navigation hierarchy change at this boundary?" }).waitFor();
  assert(await page.getByText("UI supervisor", { exact: true }).isVisible(), "Turn 4 contemporaneous decision owner is missing.");
  assert(await page.getByText("low · source human", { exact: true }).isVisible(), "Turn 4 human uncertainty is missing.");
  assert((await page.getByRole("link", { name: "Compare Turn 4 with Turn 5" }).getAttribute("href")) === "/compare?left=demo-save-04&right=demo-save-05", "Turn 4 comparison link does not bind the exact Turn 4 / Turn 5 pair.");
  measurements.joinedStory = { filmstripAnchors: anchorLabels, screenshot: screenshotEvidence, replayDurationMs: 1_252 };

  const turnFour = page.getByRole("option", { name: /Turn 4,/u });
  await turnFour.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Turn 10,"));
  assert((await page.getByRole("option", { name: /Turn 10,/u }).getAttribute("aria-selected")) === "true", "End did not select the last filmstrip item.");
  await settleCurrentRoute();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Turn 1,"));
  assert((await page.getByRole("option", { name: /Turn 1,/u }).getAttribute("aria-selected")) === "true", "Home did not select the first filmstrip item.");
  await settleCurrentRoute();
  const focusStyle = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) throw new Error("No focused HTML element.");
    const style = getComputedStyle(element);
    return { role: element.getAttribute("role"), label: element.getAttribute("aria-label"), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  assert(focusStyle.role === "option" && /Turn 1,/u.test(focusStyle.label ?? "") && focusStyle.outlineStyle !== "none" && Number.parseFloat(focusStyle.outlineWidth) >= 2, `Focused filmstrip option is not visibly outlined: ${JSON.stringify(focusStyle)}`);
  const interactionStarted = performance.now();
  await page.getByRole("option", { name: /Turn 4,/u }).click();
  await page.getByRole("heading", { name: "Choose the consequential turn" }).waitFor();
  measurements.cachedSelectionMs = performance.now() - interactionStarted;
  assert(measurements.cachedSelectionMs <= 250, `Cached selection took ${measurements.cachedSelectionMs.toFixed(1)}ms, exceeding 250ms.`);
  measurements.contrast = await contrastEvidence(page);
  assert(measurements.contrast.currentNavigation >= 4.5 && measurements.contrast.primaryAction >= 4.5, `Contrast target below 4.5:1: ${JSON.stringify(measurements.contrast)}`);
  await settleCurrentRoute();

  for (const viewport of viewports) captures.push(await capture(page, "primary", viewport));

  const degradedAlert = page.getByRole("heading", { name: "Fixture identity unavailable" });
  await navigateToHtmlRoute("/replay/demo-save-99", async () => degradedAlert.waitFor());
  assert(await page.getByText(/No alternate evidence was requested or invented/u).isVisible(), "Degraded state does not preserve truthful evidence status.");
  assert(await page.getByRole("link", { name: "Open the fixture history" }).isVisible(), "Degraded state has no bounded recovery action.");
  for (const viewport of viewports) captures.push(await capture(page, "degraded", viewport));

  await navigateToHtmlRoute("/compare", async () => page.getByRole("heading", { name: "Before and after, without an automated verdict" }).waitFor());
  await page.getByText(/Before Turn 4.*demo-save-04/u).waitFor();
  await page.getByText(/After Turn 5.*demo-save-05/u).waitFor();
  const comparisonImages = await page.locator(".comparison-screenshot img").evaluateAll((images) => images.map((image) => ({ alt: image.alt, width: image.naturalWidth, height: image.naturalHeight })));
  assert(JSON.stringify(comparisonImages) === JSON.stringify([
    { alt: "Before captured UI for demo-save-04; viewport 1440 by 900.", width: 1_440, height: 900 },
    { alt: "After captured UI for demo-save-05; viewport 1440 by 900.", width: 1_440, height: 900 },
  ]), `Comparison screenshot identities are not exact: ${JSON.stringify(comparisonImages)}.`);
  assert((await page.getByRole("link", { name: "Open this source turn and bounded replay" }).getAttribute("href")) === "/replay/demo-save-04?compareLeft=demo-save-04&compareRight=demo-save-05", "Comparison Turn 4 replay link is not exact.");
  assert((await page.getByRole("link", { name: "Open this source turn", exact: true }).getAttribute("href")) === "/replay/demo-save-05?compareLeft=demo-save-04&compareRight=demo-save-05", "Comparison Turn 5 source link is not exact.");
  const comparisonDriverStarted = performance.now();
  await followClientRoute(
    () => page.getByRole("link", { name: "Open this source turn and bounded replay" }).click(),
    async () => page.getByRole("heading", { name: "Choose the consequential turn" }).waitFor(),
  );
  measurements.joinedComparisonDriverSettledDiagnosticMs = performance.now() - comparisonDriverStarted;

  const originalFuture = page.getByRole("button", { name: "Original future" });
  const alternateFuture = page.getByRole("button", { name: "Alternate future" });
  assert((await originalFuture.getAttribute("aria-pressed")) === "true" && await alternateFuture.isDisabled(), "Alternate lineage became available before explicit confirmation.");
  await page.getByRole("button", { name: "Run simulated preflight" }).click();
  await page.getByRole("heading", { name: "Preflight passed" }).waitFor();
  assert((await page.locator(".branch-checks > li").count()) === 10, "Simulated preflight did not expose the exact ten ordered checks.");
  assert(await page.getByText("This fixed digest validates the synthetic demonstration receipt. It grants no authenticity or mutation authority.", { exact: true }).isVisible(), "Simulated preflight integrity boundary is missing.");
  await page.getByRole("button", { name: "Confirm simulated branch" }).click();
  await page.getByRole("status", { name: "Simulated alternate lineage ready" }).waitFor();
  assert(new URL(page.url()).search === "?demoBranch=simulated-created&lineage=lineage%3Asimulated-alternate", `Unexpected simulated branch URL state: ${page.url()}.`);
  assert((await alternateFuture.getAttribute("aria-pressed")) === "true", "Created alternate lineage is not selected.");
  assert((await page.getByRole("heading", { name: "One fixed simulated alternate lineage" }).count()) === 1, "Expected exactly one simulated alternate lineage.");
  await originalFuture.click();
  await page.getByText("Viewing the unchanged original fixture future.", { exact: true }).waitFor();
  const originalFutureIds = await page.getByTestId("original-future-item").locator("code").allTextContents();
  assert(JSON.stringify(originalFutureIds) === JSON.stringify(["demo-save-05", "demo-save-06", "demo-save-07", "demo-save-08", "demo-save-09", "demo-save-10"]), `Original future inventory changed: ${JSON.stringify(originalFutureIds)}.`);
  await alternateFuture.click();
  await page.getByText("Viewing one fixed simulated alternate lineage. No real repository is connected or changed.", { exact: true }).waitFor();
  assert((await page.getByRole("heading", { name: "One fixed simulated alternate lineage" }).count()) === 1, "Alternate lineage was duplicated after navigation.");
  measurements.joinedStory = { ...measurements.joinedStory, comparisonPair: ["demo-save-04", "demo-save-05"], preflightChecks: 10, originalFutureIds, alternateLineages: 1, simulationState: "simulated-created" };

  await navigateToHtmlRoute("/replay/demo-save-04?compareLeft=demo-save-04&compareRight=demo-save-05", async () => page.getByRole("heading", { name: "Choose the consequential turn" }).waitFor());
  for (const path of directHtmlRoutes) {
    await navigateToHtmlRoute(path, async () => page.getByRole("heading", { name: "Ten major-turn anchors" }).waitFor());
  }
  measurements.inventoryProbe = await probeMissingNonHtmlInventory(page);
  measurements.resourceInventory = resourceAudit.complete();
  const failed = requestLedger.filter(({ status, failure, integrityFailure }) => failure !== undefined || integrityFailure !== undefined || status === undefined || status >= 400);
  assert(failed.length === 0, `Failed requests: ${JSON.stringify(failed)}`);
  assert(consoleLedger.filter(({ type }) => type === "error" || type === "warning").length === 0, `Console errors/warnings: ${JSON.stringify(consoleLedger)}`);
  assert(pageErrors.length === 0, `Page errors: ${JSON.stringify(pageErrors)}`);

  measurements.storage = await page.evaluate(async () => ({
    localStorage: Object.keys(localStorage),
    sessionStorage: Object.keys(sessionStorage),
    indexedDB: typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map(({ name }) => name) : [],
    caches: typeof caches === "undefined" ? [] : await caches.keys(),
    serviceWorkers: "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => scope) : [],
  }));
  measurements.cookies = await context.cookies();
  assert(Object.values(measurements.storage).every((items) => items.length === 0) && measurements.cookies.length === 0, `Browser storage is not empty: ${JSON.stringify({ storage: measurements.storage, cookies: measurements.cookies })}`);
} catch (error) {
  primaryError = error;
} finally {
  try {
    const lifecycle = await completeRequestLifecycle({
      drainResponses: drainResponseSettlements,
      closePage: async () => page.close(),
      closeContext: async () => context.close(),
      closeBrowser: async () => browser.close(),
      snapshotChannels: () => deriveFinalRequestChannels({
        expectedOrigin,
        requestLedger,
        integrityFailures,
        pendingRequests: requests.values(),
      }),
    });
    teardownError = lifecycle.teardownError;
    finalChannels = lifecycle.channels;
  } catch (error) {
    teardownError = error;
    finalChannels = deriveFinalRequestChannels({
      expectedOrigin,
      requestLedger,
      integrityFailures,
      pendingRequests: requests.values(),
    });
  }
  finalVerificationError = selectFinalVerificationError({ primaryError, teardownError, channels: finalChannels, verificationLabel: verificationTask });
  const ledger = {
    schemaVersion: `remo.rel001.${verificationTask.toLowerCase()}.verification.v1`,
    baseUrl,
    expectedOrigin,
    credentialChannel: "none",
    verdict: finalVerificationError === undefined ? "PASS" : "FAIL",
    primaryError: primaryError instanceof Error ? primaryError.message : primaryError === undefined ? undefined : String(primaryError),
    teardownError: teardownError instanceof Error ? teardownError.message : teardownError === undefined ? undefined : String(teardownError),
    pendingRequests: finalChannels.pendingRequests,
    failedRequests: finalChannels.failedRequests,
    unexpectedRequests: finalChannels.unexpectedRequests,
    requests: requestLedger,
    resourceInventory: resourceAudit.records,
    integrityFailures: finalChannels.integrityFailures,
    console: consoleLedger,
    pageErrors,
    measurements,
    captures,
  };
  try {
    await writeFile(resolve(outputRoot, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  } catch (error) {
    teardownError ??= error;
    finalVerificationError = selectFinalVerificationError({ primaryError, teardownError, channels: finalChannels, verificationLabel: verificationTask });
  }
}

if (finalVerificationError !== undefined) throw finalVerificationError;
process.stdout.write(`${JSON.stringify({ verdict: "PASS", outputRoot: outputRoot.replaceAll("\\", "/"), captures: captures.length, requests: requestLedger.length, measurements }, null, 2)}\n`);
