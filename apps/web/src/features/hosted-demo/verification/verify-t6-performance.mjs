/* global document, getComputedStyle, performance, requestAnimationFrame, window */

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { performance as nodePerformance } from "node:perf_hooks";
import { clearTimeout as cancelTimer, setTimeout as scheduleTimer } from "node:timers";
import { URL } from "node:url";

import { createResourceInventoryAudit, expectedResourceInventory } from "./verify-t5-contract.mjs";

export const CONTROLLED_PROFILE_ID = "rel001-t6-controlled-profile";
export const CONTROLLED_PROFILE_SAMPLE_COUNT = 20;
export const CONTROLLED_PROFILE_BUDGET_MS = 250;
export const CONTROLLED_PROFILE_DEADLINE_MS = 120_000;
export const CONTROLLED_PROFILE_TARGET = "Choose the consequential turn";
export const CONTROLLED_PROFILE_DESTINATION = "/replay/demo-save-04?compareLeft=demo-save-04&compareRight=demo-save-05";
export const PROFILE_HANDOFF_PREFIX = "remo.rel001.t6.performance:";

const activeProfileOwners = new Set();
const contentTypes = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function claimControlledProfileOwnership(registry = activeProfileOwners, ownerId = CONTROLLED_PROFILE_ID) {
  if (registry.has(ownerId)) throw new Error(`Controlled-profile ownership conflict for ${ownerId}.`);
  registry.add(ownerId);
  let released = false;
  return {
    ownerId,
    established: true,
    release() {
      if (!released) registry.delete(ownerId);
      released = true;
    },
  };
}

export function createProfileDeadline({
  limitMs = CONTROLLED_PROFILE_DEADLINE_MS,
  onExpire,
  schedule = scheduleTimer,
  cancel = cancelTimer,
}) {
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new Error(`Invalid controlled-profile deadline: ${limitMs}.`);
  let expired = false;
  let cancelled = false;
  let expiration = Promise.resolve();
  const handle = schedule(() => {
    if (cancelled) return;
    expired = true;
    expiration = Promise.resolve().then(onExpire);
  }, limitMs);
  return {
    limitMs,
    get expired() { return expired; },
    get expiration() { return expiration; },
    cancel() {
      if (!cancelled) cancel(handle);
      cancelled = true;
    },
  };
}

export function decodeProfileHandoff(value, {
  prefix = PROFILE_HANDOFF_PREFIX,
  maxSample = CONTROLLED_PROFILE_SAMPLE_COUNT,
  expectedSample,
  expectedAttemptId,
  expectedDestination,
} = {}) {
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(value.slice(prefix.length));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (Object.keys(parsed).sort().join(",") !== "attemptId,clickMark,destination,phase,sample") return undefined;
    if (!Number.isInteger(parsed.sample) || parsed.sample < 0 || parsed.sample > maxSample) return undefined;
    if (!Number.isFinite(parsed.clickMark) || parsed.clickMark < 0) return undefined;
    if (parsed.phase !== "activated") return undefined;
    if (typeof parsed.attemptId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(parsed.attemptId)) return undefined;
    if (typeof parsed.destination !== "string" || !parsed.destination.startsWith("/") || parsed.destination.startsWith("//")) return undefined;
    if (expectedSample !== undefined && parsed.sample !== expectedSample) return undefined;
    if (expectedAttemptId !== undefined && parsed.attemptId !== expectedAttemptId) return undefined;
    if (expectedDestination !== undefined && parsed.destination !== expectedDestination) return undefined;
    return { sample: parsed.sample, clickMark: parsed.clickMark, phase: parsed.phase, attemptId: parsed.attemptId, destination: parsed.destination };
  } catch {
    return undefined;
  }
}

export function consumeProfileHandoff(targetWindow, options, decode = decodeProfileHandoff) {
  const value = targetWindow.name;
  if (typeof value !== "string" || !value.startsWith(options.prefix)) return undefined;
  targetWindow.name = "";
  return decode(value, options);
}

export function validateCompletedMeasurement(measurement, { sample, attemptId, destination }) {
  const valid = measurement !== null
    && typeof measurement === "object"
    && measurement.phase === "complete"
    && measurement.sample === sample
    && measurement.attemptId === attemptId
    && measurement.destination === destination
    && measurement.target === CONTROLLED_PROFILE_TARGET
    && measurement.paintBoundary === "double-requestAnimationFrame"
    && Number.isFinite(measurement.clickMark)
    && Number.isFinite(measurement.paintMark)
    && measurement.paintMark >= measurement.clickMark
    && Number.isFinite(measurement.browserDurationMs)
    && measurement.browserDurationMs === measurement.paintMark - measurement.clickMark;
  if (!valid) throw new Error(`Invalid completed controlled-profile measurement: ${JSON.stringify(measurement)}.`);
  return measurement;
}

export function nearestRankPercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("Nearest-rank percentile requires at least one value.");
  if (!(percentile > 0 && percentile <= 1)) throw new Error(`Invalid nearest-rank percentile: ${percentile}.`);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Nearest-rank percentile values must be finite non-negative numbers.");
  const orderedValues = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(percentile * orderedValues.length);
  return { method: "nearest-rank", percentile, rank, orderedValues, value: orderedValues[rank - 1] };
}

export async function runPredeterminedSamples({ sampleCount, warmUp, sample }) {
  if (sampleCount !== CONTROLLED_PROFILE_SAMPLE_COUNT) throw new Error(`Controlled profile requires exactly ${CONTROLLED_PROFILE_SAMPLE_COUNT} predetermined samples; received ${sampleCount}.`);
  let warmUpResult;
  try {
    warmUpResult = await warmUp();
  } catch (error) {
    warmUpResult = { kind: "warm-up", error: errorMessage(error) };
    return { warmUp: warmUpResult, samples: [] };
  }
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const sampleNumber = index + 1;
    try {
      samples.push(await sample({ sample: sampleNumber }));
    } catch (error) {
      samples.push({ sample: sampleNumber, error: errorMessage(error) });
      break;
    }
  }
  return { warmUp: warmUpResult, samples };
}

function nonEmptyChannels(lifecycleChannels) {
  return Object.entries(lifecycleChannels).filter(([, entries]) => Array.isArray(entries) && entries.length > 0);
}

export function deriveControlledProfileVerdict({
  samples,
  ownership,
  lifecycleChannels,
  warmUp = { kind: "warm-up" },
  budgetMs = CONTROLLED_PROFILE_BUDGET_MS,
}) {
  const errors = [];
  for (const entry of lifecycleChannels.deadlineErrors ?? []) errors.push(`Controlled-profile deadlineErrors is non-empty: ${JSON.stringify([entry])}.`);
  if (ownership?.established !== true) errors.push("Controlled-profile ownership was not established.");
  if (warmUp?.error !== undefined) errors.push(`Declared warm-up failed: ${warmUp.error}`);
  if (samples.length !== CONTROLLED_PROFILE_SAMPLE_COUNT) errors.push(`Incomplete controlled sample set: expected ${CONTROLLED_PROFILE_SAMPLE_COUNT}, received ${samples.length}.`);
  for (const sample of samples) {
    if (!Number.isInteger(sample.sample) || sample.sample < 1 || sample.sample > CONTROLLED_PROFILE_SAMPLE_COUNT) errors.push(`Invalid predetermined sample identity: ${JSON.stringify(sample)}.`);
    if (sample.error !== undefined) errors.push(`Sample ${sample.sample} failed: ${sample.error}`);
    if (!Number.isFinite(sample.browserDurationMs) || sample.browserDurationMs < 0) errors.push(`Sample ${sample.sample} is missing a valid browser duration.`);
    if (!Number.isFinite(sample.clickMark)) errors.push(`Sample ${sample.sample} is missing its browser click mark.`);
    if (!Number.isFinite(sample.paintMark)) errors.push(`Sample ${sample.sample} is missing its browser paint mark.`);
    if (sample.target !== CONTROLLED_PROFILE_TARGET) errors.push(`Sample ${sample.sample} is missing the exact visible semantic target.`);
    if (sample.paintBoundary !== "double-requestAnimationFrame") errors.push(`Sample ${sample.sample} is missing the deterministic double-requestAnimationFrame paint boundary.`);
    if (!Number.isFinite(sample.driverWallMs) || !Number.isFinite(sample.settledWallMs)) errors.push(`Sample ${sample.sample} is missing driver or settled wall-time diagnostics.`);
  }
  for (const [channel, entries] of nonEmptyChannels(lifecycleChannels)) {
    if (channel !== "deadlineErrors") errors.push(`Controlled-profile ${channel} is non-empty: ${JSON.stringify(entries)}.`);
  }
  const browserValues = samples.map(({ browserDurationMs }) => browserDurationMs).filter((value) => Number.isFinite(value) && value >= 0);
  const p95 = browserValues.length === CONTROLLED_PROFILE_SAMPLE_COUNT ? nearestRankPercentile(browserValues, 0.95) : undefined;
  if (p95 !== undefined && p95.value > budgetMs) errors.push(`Controlled-profile browser p95 ${p95.value.toFixed(3)}ms exceeds ${budgetMs}ms.`);
  return {
    verdict: errors.length === 0 ? "PASS" : "FAIL",
    budgetMs,
    warmUp,
    samples,
    p95,
    lifecycleChannels,
    errors,
  };
}

async function startOwnedStaticServer(webRoot, serverErrors) {
  const normalizedRoot = resolve(webRoot);
  const pending = new Set();
  const requests = [];
  const server = createServer((request, response) => {
    const record = { method: request.method, url: request.url, startedAt: Date.now() };
    requests.push(record);
    pending.add(record);
    void (async () => {
      try {
        if (request.method !== "GET") throw new Error(`Unexpected controlled-profile server method: ${request.method}.`);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const requestedPath = decodeURIComponent(url.pathname);
        const relativePath = requestedPath === "/demo-replay.html"
          ? "demo-replay.html"
          : extname(requestedPath) === "" ? "index.html" : requestedPath.slice(1);
        const file = resolve(normalizedRoot, relativePath);
        if (file !== normalizedRoot && !file.startsWith(`${normalizedRoot}${sep}`)) throw new Error(`Controlled-profile path escaped the web root: ${requestedPath}.`);
        const info = await stat(file);
        if (!info.isFile()) throw new Error(`Controlled-profile resource is not a file: ${requestedPath}.`);
        const body = await readFile(file);
        record.status = 200;
        record.bytes = body.byteLength;
        record.sha256 = createHash("sha256").update(body).digest("hex");
        response.writeHead(200, {
          "content-type": contentTypes.get(extname(file)) ?? "application/octet-stream",
          "cache-control": requestedPath.startsWith("/assets/") || requestedPath.startsWith("/hosted-demo/") ? "public, max-age=31536000, immutable" : "no-store",
          "content-length": body.byteLength,
        });
        response.end(body);
      } catch (error) {
        const message = errorMessage(error);
        record.status = 500;
        record.error = message;
        serverErrors.push({ url: request.url, error: message });
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
        response.end("Controlled profile server failure.");
      } finally {
        pending.delete(record);
      }
    })();
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Controlled-profile server did not expose an exclusive TCP address.");
  let closePromise;
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    pending,
    close: () => {
      closePromise ??= new Promise((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
      return closePromise;
    },
  };
}

async function doubleAnimationFrame(page) {
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

async function clearProfileHandoffState(page) {
  if (page === undefined || page.isClosed()) return;
  await page.evaluate(() => {
    window.name = "";
    delete window.__remoT6ControlledProfile;
  });
}

export async function teardownControlledProfileResources({ page, context, browser, server, ownership, clearHandoff = clearProfileHandoffState }) {
  const errors = [];
  for (const [resource, close] of [
    ["handoff", async () => clearHandoff(page)],
    ["page", async () => page?.close()],
    ["context", async () => context?.close()],
    ["browser", async () => browser?.close()],
    ["server", async () => server?.close()],
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push({ resource, error: errorMessage(error) });
    }
  }
  ownership?.release();
  return errors;
}

async function prepareComparisonPage(page, origin, recordProgress) {
  await clearProfileHandoffState(page);
  recordProgress("comparison-navigation-started");
  await page.goto(`${origin}/compare`, { waitUntil: "load" });
  await page.getByRole("heading", { name: "Before and after, without an automated verdict" }).waitFor();
  await page.getByRole("link", { name: "Open this source turn and bounded replay" }).waitFor();
  await page.waitForLoadState("networkidle");
  await doubleAnimationFrame(page);
  recordProgress("comparison-ready");
}

async function measureActivatingClick(page, sampleNumber, recordProgress) {
  const link = page.getByRole("link", { name: "Open this source turn and bounded replay" });
  const attemptId = randomUUID();
  await link.evaluate((element, input) => {
    const destination = new URL(element.href).pathname + new URL(element.href).search;
    if (destination !== input.destination) throw new Error(`Controlled-profile activating link destination mismatch: ${destination}.`);
    element.addEventListener("click", (event) => {
      if (event.currentTarget !== element || event.button !== 0) return;
      const state = {
        sample: input.sample,
        clickMark: performance.timeOrigin + performance.now(),
        phase: "activated",
        attemptId: input.attemptId,
        destination: input.destination,
      };
      window.name = `${input.prefix}${JSON.stringify(state)}`;
    }, { capture: true, once: true });
  }, { sample: sampleNumber, prefix: PROFILE_HANDOFF_PREFIX, attemptId, destination: CONTROLLED_PROFILE_DESTINATION });
  recordProgress("click-mark-armed");

  const driverStarted = nodePerformance.now();
  try {
    await link.click();
    recordProgress("activating-click-dispatched");
    await page.waitForFunction(() => window.__remoT6ControlledProfile?.complete === true || window.__remoT6ControlledProfile?.error !== undefined);
    const browserMeasurement = await page.evaluate(() => ({ ...window.__remoT6ControlledProfile }));
    if (browserMeasurement.error !== undefined) throw new Error(browserMeasurement.error);
    validateCompletedMeasurement(browserMeasurement, { sample: sampleNumber, attemptId, destination: CONTROLLED_PROFILE_DESTINATION });
    recordProgress("browser-paint-complete", { browserDurationMs: browserMeasurement.browserDurationMs });
    const driverWallMs = nodePerformance.now() - driverStarted;
    await page.getByRole("heading", { name: CONTROLLED_PROFILE_TARGET }).waitFor();
    await page.getByText("Replay paused", { exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    await doubleAnimationFrame(page);
    const settledWallMs = nodePerformance.now() - driverStarted;
    recordProgress("fully-settled", { driverWallMs, settledWallMs });
    return { ...browserMeasurement, driverWallMs, settledWallMs };
  } finally {
    await clearProfileHandoffState(page);
  }
}

async function runControlledComparison({ chromium, repositoryRoot, diagnosticWarmUpOnly }) {
  let ownership;
  let ownedServer;
  let browser;
  let context;
  let page;
  const requestFailures = [];
  const unexpectedRequests = [];
  const integrityFailures = [];
  const consoleErrors = [];
  const pageErrors = [];
  const serverErrors = [];
  const browserPending = new Map();
  const responseSettlements = [];
  let run = { warmUp: { kind: "warm-up", error: "Controlled profile did not start." }, samples: [] };
  let setupError;
  let deadline;
  let deadlineExceeded = false;
  const teardownErrors = [];
  const progress = [];
  const recordProgress = (phase, details = {}) => progress.push({ sequence: progress.length + 1, phase, atMs: nodePerformance.now(), ...details });

  try {
    ownership = claimControlledProfileOwnership();
    recordProgress("ownership-established", { ownerId: ownership.ownerId });
    deadline = createProfileDeadline({
      onExpire: async () => {
        deadlineExceeded = true;
        recordProgress("overall-deadline-exceeded", { limitMs: CONTROLLED_PROFILE_DEADLINE_MS });
        teardownErrors.push(...await teardownControlledProfileResources({ page, context, browser, server: ownedServer, ownership }));
      },
    });
    ownedServer = await startOwnedStaticServer(resolve(repositoryRoot, "apps/web/dist"), serverErrors);
    if (deadlineExceeded) throw new Error("Controlled-profile overall deadline exceeded during owned-server setup.");
    recordProgress("owned-server-listening", { port: ownedServer.port });
    const resourceAudit = createResourceInventoryAudit(ownedServer.origin, expectedResourceInventory(ownedServer.origin));
    browser = await chromium.launch({ headless: true, channel: "msedge" });
    if (deadlineExceeded) throw new Error("Controlled-profile overall deadline exceeded during browser setup.");
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
    if (deadlineExceeded) throw new Error("Controlled-profile overall deadline exceeded during context setup.");
    await context.addInitScript({
      content: `window.__remoT6DecodeProfileHandoff = ${decodeProfileHandoff.toString()};\nwindow.__remoT6ConsumeProfileHandoff = ${consumeProfileHandoff.toString()};`,
    });
    await context.addInitScript(({ prefix, target, maxSample }) => {
      const begin = (handoff) => {
        const state = {
          sample: handoff.sample,
          clickMark: handoff.clickMark,
          attemptId: handoff.attemptId,
          destination: handoff.destination,
          target,
          paintBoundary: "double-requestAnimationFrame",
        };
        window.__remoT6ControlledProfile = state;
        const observeTarget = () => {
          const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
            .find((candidate) => candidate.textContent?.trim() === target);
          const visible = heading !== undefined && heading.getClientRects().length > 0 && getComputedStyle(heading).visibility !== "hidden";
          if (!visible) {
            requestAnimationFrame(observeTarget);
            return;
          }
          requestAnimationFrame(() => requestAnimationFrame(() => {
            state.paintMark = performance.timeOrigin + performance.now();
            state.browserDurationMs = state.paintMark - state.clickMark;
            state.phase = "complete";
            state.complete = true;
          }));
        };
        requestAnimationFrame(observeTarget);
      };
      const hadProfileHandoff = window.name.startsWith(prefix);
      const handoff = window.__remoT6ConsumeProfileHandoff(
        window,
        { prefix, maxSample },
        window.__remoT6DecodeProfileHandoff,
      );
      if (hadProfileHandoff && handoff === undefined) {
        window.__remoT6ControlledProfile = { error: "Invalid cross-document measurement handoff." };
      } else if (handoff !== undefined) {
        const currentDestination = window.location.pathname + window.location.search;
        if (handoff.destination !== currentDestination) {
          window.__remoT6ControlledProfile = { error: `Cross-document measurement destination mismatch: ${currentDestination}.` };
        } else {
          begin(handoff);
        }
      }
    }, { prefix: PROFILE_HANDOFF_PREFIX, target: CONTROLLED_PROFILE_TARGET, maxSample: CONTROLLED_PROFILE_SAMPLE_COUNT });
    page = await context.newPage();
    if (deadlineExceeded) throw new Error("Controlled-profile overall deadline exceeded during page setup.");
    recordProgress("dedicated-browser-context-ready");
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleErrors.push({ type: message.type(), text: message.text() });
    });
    page.on("pageerror", (error) => pageErrors.push({ error: error.message }));
    page.on("request", (request) => {
      browserPending.set(request, { method: request.method(), url: request.url() });
      try {
        const url = new URL(request.url());
        if (url.protocol !== "blob:" && url.origin !== ownedServer.origin) unexpectedRequests.push({ method: request.method(), url: request.url() });
      } catch (error) {
        unexpectedRequests.push({ method: request.method(), url: request.url(), error: errorMessage(error) });
      }
    });
    page.on("requestfailed", (request) => {
      requestFailures.push({ method: request.method(), url: request.url(), failure: request.failure()?.errorText ?? "unknown" });
      browserPending.delete(request);
    });
    page.on("requestfinished", (request) => {
      const settlement = (async () => {
        try {
          const response = await request.response();
          if (response === null) throw new Error("Request finished without a response.");
          const status = response.status();
          const body = status === 304 ? new Uint8Array() : await response.body();
          resourceAudit.record({
            method: request.method(),
            url: request.url(),
            status,
            contentType: response.headers()["content-type"] ?? "",
            body,
            navigationRole: request.isNavigationRequest() && request.resourceType() === "document" ? request.frame() === page.mainFrame() ? "top-document" : "iframe" : undefined,
          });
        } catch (error) {
          integrityFailures.push({ method: request.method(), url: request.url(), error: errorMessage(error) });
        } finally {
          browserPending.delete(request);
        }
      })();
      responseSettlements.push(settlement);
    });

    const exercise = async (sampleNumber) => {
      const label = sampleNumber === 0 ? "warm-up" : `sample-${sampleNumber}`;
      recordProgress("attempt-started", { label });
      await prepareComparisonPage(page, ownedServer.origin, (phase, details) => recordProgress(phase, { label, ...details }));
      const result = await measureActivatingClick(page, sampleNumber, (phase, details) => recordProgress(phase, { label, ...details }));
      recordProgress("attempt-complete", { label });
      return result;
    };
    if (diagnosticWarmUpOnly) {
      try {
        run = { warmUp: { kind: "diagnostic-warm-up-only", ...(await exercise(0)) }, samples: [] };
      } catch (error) {
        run = { warmUp: { kind: "diagnostic-warm-up-only", error: errorMessage(error) }, samples: [] };
      }
    } else {
      run = await runPredeterminedSamples({
        sampleCount: CONTROLLED_PROFILE_SAMPLE_COUNT,
        warmUp: async () => ({ kind: "declared-warm-up", ...(await exercise(0)) }),
        sample: async ({ sample }) => ({ sample, ...(await exercise(sample)) }),
      });
    }
    await Promise.allSettled(responseSettlements);
  } catch (error) {
    setupError = deadlineExceeded ? "Controlled-profile overall deadline exceeded." : errorMessage(error);
    recordProgress("profile-error", { error: setupError });
  }

  if (deadline?.expired) await deadline.expiration;
  teardownErrors.push(...await teardownControlledProfileResources({ page, context, browser, server: ownedServer, ownership }));
  if (deadline?.expired) await deadline.expiration;
  await Promise.allSettled(responseSettlements);
  deadline?.cancel();

  const lifecycleChannels = {
    requestFailures,
    pendingRequests: [
      ...browserPending.values(),
      ...(ownedServer === undefined ? [] : [...ownedServer.pending].map(({ method, url }) => ({ method, url, source: "owned-server" }))),
    ],
    unexpectedRequests,
    integrityFailures,
    consoleErrors,
    pageErrors,
    serverErrors,
    ...(deadlineExceeded ? { deadlineErrors: [{ limitMs: CONTROLLED_PROFILE_DEADLINE_MS, error: "Controlled-profile overall deadline exceeded." }] } : {}),
    ...(setupError === undefined ? {} : { setupErrors: [{ error: setupError }] }),
    teardownErrors,
  };
  const result = diagnosticWarmUpOnly
    ? (() => {
        const errors = [];
        if (run.warmUp?.error !== undefined) errors.push(`Diagnostic warm-up failed: ${run.warmUp.error}`);
        for (const [channel, entries] of nonEmptyChannels(lifecycleChannels)) errors.push(`Controlled-profile diagnostic ${channel} is non-empty: ${JSON.stringify(entries)}.`);
        return {
          classification: "diagnostic-warm-up-only-not-a-sample-set-or-p95-evidence",
          verdict: errors.length === 0 ? "PASS" : "FAIL",
          warmUp: run.warmUp,
          samples: [],
          p95: undefined,
          lifecycleChannels,
          errors,
        };
      })()
    : deriveControlledProfileVerdict({
        samples: run.samples,
        ownership: { established: ownership?.established === true, ownerId: ownership?.ownerId },
        lifecycleChannels,
        warmUp: run.warmUp,
      });
  return {
    schemaVersion: diagnosticWarmUpOnly ? "remo.rel001.t6.controlled-comparison-warm-up-diagnostic.v1" : "remo.rel001.t6.controlled-comparison-profile.v1",
    profile: {
      ownerId: ownership?.ownerId ?? CONTROLLED_PROFILE_ID,
      exclusivelyOwned: ownership?.established === true,
      server: ownedServer === undefined ? undefined : { host: "127.0.0.1", port: ownedServer.port, origin: ownedServer.origin, requests: ownedServer.requests },
      browser: { engine: "chromium", channel: "msedge", headless: true },
      context: { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" },
      preconditions: { hostedBuildRoot: "apps/web/dist", dedicatedBrowserContextServer: true },
      sampling: diagnosticWarmUpOnly
        ? { warmUps: 1, samples: 0, order: "one-navigation-warm-up-only", adaptive: false, retries: 0, evidenceClassification: "diagnostic-only" }
        : { warmUps: 1, samples: CONTROLLED_PROFILE_SAMPLE_COUNT, order: "predetermined-1-through-20", adaptive: false, retries: 0 },
      overallDeadlineMs: CONTROLLED_PROFILE_DEADLINE_MS,
      start: "browser performance.timeOrigin + performance.now() at the exact captured activating click event",
      end: `${CONTROLLED_PROFILE_TARGET} visible plus deterministic double-requestAnimationFrame paint boundary`,
    },
    progress,
    ...result,
  };
}

export function runControlledComparisonProfile(options) {
  return runControlledComparison({ ...options, diagnosticWarmUpOnly: false });
}

export function runControlledComparisonWarmUpDiagnostic(options) {
  return runControlledComparison({ ...options, diagnosticWarmUpOnly: true });
}
