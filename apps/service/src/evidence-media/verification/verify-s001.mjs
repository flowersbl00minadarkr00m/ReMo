/* global Buffer, clearTimeout, document, fetch, getComputedStyle, HTMLIFrameElement, HTMLElement, innerWidth, localStorage, MessageChannel, MessageEvent, parent, performance, process, requestAnimationFrame, scrollX, scrollY, sessionStorage, setTimeout, URL, window */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { LocalSavePointRepository } from "@remo/storage-local";

const repoRoot = resolve(import.meta.dirname, "../../../../..");
const { PNG } = createRequire(join(repoRoot, "packages/capture-playwright/package.json"))("pngjs");
const webRoot = join(repoRoot, "apps/web/dist");
const fixtureDirectory = join(repoRoot, "apps/service/src/evidence-media/fixtures/s-001");
const artifactDirectory = join(fixtureDirectory, "acceptance");
const { createCandidateReview, confirmCandidateIntent } = await import(pathToFileURL(join(repoRoot, "apps/service/src/candidates/candidate-service.ts")).href);
const { createPromotionService } = await import(pathToFileURL(join(repoRoot, "apps/service/src/promotion/promotion-service.ts")).href);
const { startLocalApplication } = await import(pathToFileURL(join(repoRoot, "apps/service/src/promotion/local-application.ts")).href);

const PARENT_ORIGIN = "http://127.0.0.1:4175";
const RUNTIME_ORIGIN = "http://127.0.0.1:4176";
const TURN_ID = "01J000000000000000000000T5";
const SAVE_POINT_ID = "01J000000000000000000000S5";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SOURCE_COMMIT = "54474fd8d763cb9acaaa2e83b6df44df36fe7d92";
const CAPTURED_AT = "2026-08-18T11:30:00.000Z";
const VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function nearestRankP95(values) {
  assert(values.length > 0, "A p95 profile requires at least one sample.");
  return [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1];
}

function candidate(rrwebBytes, screenshotBytes, receipt) {
  const correlation = { projectId: "remo", turnId: TURN_ID, captureWindowId: "window-t3-s001", boundaryRevision: "boundary-v1" };
  const componentTypes = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"];
  const evidence = componentTypes.map((componentType) => ({
    componentId: `${TURN_ID}:${componentType}`,
    componentType,
    authority: componentType === "source" ? "git" : componentType === "rrweb" ? "rrweb" : componentType === "trace" ? "langfuse" : "remo",
    correlation,
    capturedAt: CAPTURED_AT,
    digest: digest(Buffer.from(`s001:${componentType}`)),
    ...(componentType === "trace" ? { externalId: TRACE_ID } : {}),
    availability: "available",
    provenance: componentType === "decision" ? "user-supplied" : "observed",
    policyRevision: "remo.privacy.v1",
    claims: { sourceState: SOURCE_COMMIT, fixtureId: "vs001-sequence:5:approved-binding-fixture" },
  }));
  return createCandidateReview({
    finalization: { schemaVersion: "remo.bundle.v1", identityVersion: "ulid-v1", policyRevision: "remo.privacy.v1", savePointId: SAVE_POINT_ID, correlation, evidence },
    nomination: { status: "candidate", categories: ["responsive", "accessibility"], boundaries: [{ kind: "verification", boundaryId: "t3-s001-actual-media", occurredAt: CAPTURED_AT }], reasonCodes: ["nomination.meaningful-change-with-boundary"] },
    privacyCapture: { status: "passed", evidence: { rrwebBytes, screenshotBytes, receipt } },
    createdAt: CAPTURED_AT,
  });
}

function expectedRequest(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "blob:" && parsed.origin === PARENT_ORIGIN) return true;
  if (parsed.origin === PARENT_ORIGIN) {
    return parsed.pathname === "/"
      || parsed.pathname === `/save-points/${SAVE_POINT_ID}`
      || parsed.pathname.startsWith("/assets/")
      || parsed.pathname === `/api/save-points/${SAVE_POINT_ID}/media/screenshot`
      || parsed.pathname === `/api/save-points/${SAVE_POINT_ID}/media/rrweb`;
  }
  return parsed.origin === RUNTIME_ORIGIN && (parsed.pathname === "/runtime" || parsed.pathname.startsWith("/assets/"));
}

function createTelemetry(page) {
  const telemetry = { consoleErrors: [], pageErrors: [], unexpectedRequests: [], webSockets: [], runtimeCredentialRequests: [], responsePolicyFailures: [], requestChecks: [], responseChecks: [] };
  page.on("console", (message) => { if (message.type() === "error") telemetry.consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => telemetry.pageErrors.push(error.message));
  page.on("websocket", (socket) => telemetry.webSockets.push(socket.url()));
  page.on("request", (request) => {
    if (!expectedRequest(request.url())) telemetry.unexpectedRequests.push(request.url());
    if (new URL(request.url()).origin === RUNTIME_ORIGIN) {
      telemetry.requestChecks.push(request.allHeaders().then((headers) => {
        if (headers.cookie !== undefined || headers.authorization !== undefined || headers["proxy-authorization"] !== undefined) telemetry.runtimeCredentialRequests.push(request.url());
      }));
    }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).origin === RUNTIME_ORIGIN) {
      telemetry.responseChecks.push(response.allHeaders().then((headers) => {
        if (headers["set-cookie"] !== undefined || headers["access-control-allow-origin"] !== undefined || headers["access-control-allow-credentials"] !== undefined) telemetry.responsePolicyFailures.push(response.url());
      }));
    }
  });
  return telemetry;
}

async function assertTelemetry(telemetry, label) {
  await Promise.all([...telemetry.requestChecks, ...telemetry.responseChecks]);
  assert(telemetry.consoleErrors.length === 0, `${label} console errors: ${telemetry.consoleErrors.join(" | ")}`);
  assert(telemetry.pageErrors.length === 0, `${label} page errors: ${telemetry.pageErrors.join(" | ")}`);
  assert(telemetry.unexpectedRequests.length === 0, `${label} unexpected requests: ${telemetry.unexpectedRequests.join(" | ")}`);
  assert(telemetry.webSockets.length === 0, `${label} opened WebSockets: ${telemetry.webSockets.join(" | ")}`);
  assert(telemetry.runtimeCredentialRequests.length === 0, `${label} sent credentials to the replay runtime.`);
  assert(telemetry.responsePolicyFailures.length === 0, `${label} replay runtime exposed cookies or CORS.`);
}

async function runtimeFrameProof(page) {
  const runtime = page.frames().find((frame) => frame.url() === `${RUNTIME_ORIGIN}/runtime`);
  assert(runtime !== undefined, "The exact 4176 runtime frame is missing.");
  return runtime.evaluate(() => {
    const root = document.querySelector("#replay-root");
    const nested = document.querySelector("iframe.remo-reconstruction-frame");
    const nestedDocument = nested instanceof HTMLIFrameElement ? nested.contentDocument : null;
    const rect = nested instanceof HTMLIFrameElement ? nested.getBoundingClientRect() : null;
    const text = nestedDocument?.body?.innerText.trim() ?? "";
    const elements = nestedDocument?.body?.querySelectorAll("*").length ?? 0;
    const documentElement = nestedDocument?.documentElement;
    const keyContent = nestedDocument === null ? undefined : [...nestedDocument.body.querySelectorAll("*")].find((element) => element.textContent?.trim() === "Save point evidence");
    const keyRect = keyContent?.getBoundingClientRect();
    const keyStyle = keyContent === undefined || !(nested instanceof HTMLIFrameElement) ? undefined : nested.contentWindow?.getComputedStyle(keyContent);
    const rootRect = root?.getBoundingClientRect();
    const wrapper = document.querySelector(".remo-reconstruction-wrapper");
    const wrapperRect = wrapper?.getBoundingClientRect();
    const styleFields = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return { display: style.display, visibility: style.visibility, opacity: style.opacity, transform: style.transform, position: style.position, zIndex: style.zIndex, overflow: style.overflow, backgroundColor: style.backgroundColor };
    };
    return {
      runtimeState: root?.getAttribute("data-runtime-state"),
      fullSnapshotRebuilt: root?.getAttribute("data-full-snapshot-rebuilt") === "true",
      paintBoundaryConfirmed: root?.getAttribute("data-paint-boundary-confirmed") === "true",
      visibleContentConfirmed: root?.getAttribute("data-visible-content-confirmed") === "true",
      firstFrameMs: Number(root?.getAttribute("data-first-frame-ms")),
      text: text.slice(0, 240),
      textLength: text.length,
      elements,
      geometry: rect === null ? null : { width: rect.width, height: rect.height, scrollWidth: nestedDocument?.documentElement.scrollWidth ?? 0, scrollHeight: nestedDocument?.documentElement.scrollHeight ?? 0 },
      keyContent: keyContent?.textContent?.trim() ?? null,
      keyGeometry: keyRect === undefined ? null : { x: keyRect.x, y: keyRect.y, width: keyRect.width, height: keyRect.height },
      keyVisible: keyRect !== undefined
        && documentElement !== undefined
        && keyRect.width > 0
        && keyRect.height > 0
        && keyRect.right > 0
        && keyRect.bottom > 0
        && keyRect.left < documentElement.clientWidth
        && keyRect.top < documentElement.clientHeight
        && keyStyle?.visibility !== "hidden"
        && keyStyle?.display !== "none"
        && keyStyle?.opacity !== "0",
      compositor: {
        root: { rect: rootRect === undefined ? null : { x: rootRect.x, y: rootRect.y, width: rootRect.width, height: rootRect.height }, style: styleFields(root) },
        wrapper: { rect: wrapperRect === undefined ? null : { x: wrapperRect.x, y: wrapperRect.y, width: wrapperRect.width, height: wrapperRect.height }, style: styleFields(wrapper) },
        frame: { rect: rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: styleFields(nested) },
        keyStyle: keyStyle === undefined ? null : { display: keyStyle.display, visibility: keyStyle.visibility, opacity: keyStyle.opacity, color: keyStyle.color, backgroundColor: keyStyle.backgroundColor },
      },
      lifecycle: window.__REMO_REPLAY_LIFECYCLE__?.(),
    };
  });
}

function analyzeRenderedPixels(buffer, clip) {
  const png = PNG.sync.read(buffer);
  const inset = 8;
  const left = Math.max(inset, Math.floor(clip?.x ?? 0) + inset);
  const top = Math.max(inset, Math.floor(clip?.y ?? 0) + inset);
  const right = Math.min(png.width - inset, Math.ceil((clip?.x ?? 0) + (clip?.width ?? png.width)) - inset);
  const bottom = Math.min(png.height - inset, Math.ceil((clip?.y ?? 0) + (clip?.height ?? png.height)) - inset);
  const background = [238, 242, 247];
  let sampledPixels = 0;
  let nonBackgroundPixels = 0;
  let luminanceTotal = 0;
  let luminanceSquaredTotal = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (png.width * y + x) * 4;
      const red = png.data[index];
      const green = png.data[index + 1];
      const blue = png.data[index + 2];
      const difference = Math.abs(red - background[0]) + Math.abs(green - background[1]) + Math.abs(blue - background[2]);
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      sampledPixels += 1;
      if (difference > 24) nonBackgroundPixels += 1;
      luminanceTotal += luminance;
      luminanceSquaredTotal += luminance * luminance;
    }
  }
  const mean = luminanceTotal / sampledPixels;
  const standardDeviation = Math.sqrt(Math.max(0, luminanceSquaredTotal / sampledPixels - mean * mean));
  return { width: right - left, height: bottom - top, sampledPixels, nonBackgroundPixels, nonBackgroundRatio: nonBackgroundPixels / sampledPixels, luminanceStandardDeviation: standardDeviation, pngBytes: buffer.length };
}

async function renderedPixelProof(page) {
  const replayFrame = page.locator('iframe[title="Isolated non-interactive historical replay"]');
  await replayFrame.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
  return analyzeRenderedPixels(await replayFrame.screenshot());
}

function assertTruthfulFirstFrame(proof, label) {
  assert(proof.runtimeState === "ready" && proof.fullSnapshotRebuilt && proof.paintBoundaryConfirmed && proof.visibleContentConfirmed, `${label} did not pass the rebuild/paint/visibility gates: ${JSON.stringify(proof)}`);
  assert(Number.isFinite(proof.firstFrameMs) && proof.firstFrameMs >= 0 && proof.firstFrameMs <= 1_000, `${label} first-frame timing is not truthful: ${JSON.stringify(proof)}`);
  assert(proof.elements > 10 && proof.textLength > 0 && proof.keyContent === "Save point evidence" && proof.keyVisible, `${label} reconstructed content is blank, clipped, or not S-001: ${JSON.stringify(proof)}`);
  assert(proof.geometry?.width > 0 && proof.geometry.height > 0 && proof.geometry.scrollWidth > 0 && proof.geometry.scrollHeight > 0, `${label} reconstructed geometry is not visible: ${JSON.stringify(proof)}`);
}

async function waitForPrimary(page, telemetry) {
  await page.getByRole("img", { name: /Privacy-checked captured UI/u }).waitFor();
  await page.getByRole("heading", { name: "Bounded replay", exact: true }).waitFor();
  try {
    await page.getByText("Replay paused", { exact: true }).waitFor({ timeout: 1_500 });
    const proof = await runtimeFrameProof(page);
    assertTruthfulFirstFrame(proof, "Initial paused viewport");
    return proof;
  }
  catch {
    const body = (await page.locator("body").innerText()).slice(0, 2_000);
    const runtime = page.frames().find((frame) => frame.url() === `${RUNTIME_ORIGIN}/runtime`);
    const runtimeState = runtime === undefined ? "missing-frame" : await runtime.locator("#replay-root").getAttribute("data-runtime-state");
    throw new Error(`Replay did not reach paused: runtime=${String(runtimeState)} console=${telemetry.consoleErrors.join(" | ")} page=${telemetry.pageErrors.join(" | ")} body=${body}`);
  }
}

async function sampleCount(page) {
  return Number(await page.getByLabel("Replay performance samples").getAttribute("data-sample-count"));
}

async function clickAndMeasure(page, locator) {
  const before = await sampleCount(page);
  await locator.click();
  await page.waitForFunction((count) => Number(document.querySelector('[aria-label="Replay performance samples"]')?.getAttribute("data-sample-count")) > count, before);
  const output = page.getByLabel("Replay performance samples");
  return Number(await output.getAttribute("data-latest-command-ms"));
}

async function assertResponsive(page, state) {
  const results = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(50);
    let firstFrameProof;
    if (state === "primary") {
      firstFrameProof = await runtimeFrameProof(page);
      assertTruthfulFirstFrame(firstFrameProof, `${viewport.width}x${viewport.height} primary capture`);
      firstFrameProof.pixelProof = await renderedPixelProof(page);
      assert(firstFrameProof.pixelProof.nonBackgroundRatio > 0.002 && firstFrameProof.pixelProof.luminanceStandardDeviation > 2, `${viewport.width}x${viewport.height} primary replay pixels are blank: ${JSON.stringify(firstFrameProof)}`);
    }
    const measurements = await page.evaluate(() => {
      const surface = document.querySelector(".evidence-media")?.getBoundingClientRect();
      const visibleControls = [...document.querySelectorAll(".replay-controls button, .replay-controls input")].filter((element) => element.getBoundingClientRect().width > 0);
      const widest = [...document.querySelectorAll("body *")].map((element) => ({ element, rect: element.getBoundingClientRect() })).sort((left, right) => right.rect.right - left.rect.right)[0];
      const overflowers = [...document.querySelectorAll("body *")].filter((element) => element.scrollWidth > element.clientWidth + 1).sort((left, right) => (right.scrollWidth - right.clientWidth) - (left.scrollWidth - left.clientWidth)).slice(0, 20).map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 80), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        surfaceContained: surface !== undefined && surface.left >= 0 && surface.right <= innerWidth,
        controlsContained: visibleControls.every((element) => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }),
        widest: widest === undefined ? null : { tag: widest.element.tagName, className: widest.element.className, text: widest.element.textContent?.slice(0, 80), left: widest.rect.left, right: widest.rect.right, width: widest.rect.width },
        overflowers,
      };
    });
    assert(measurements.documentWidth <= viewport.width && measurements.bodyWidth <= viewport.width && measurements.surfaceContained && measurements.controlsContained, `${state} replay overflow at ${viewport.width}x${viewport.height}: ${JSON.stringify(measurements)}`);
    const capturePath = join(artifactDirectory, `${state}-${viewport.width}x${viewport.height}.png`);
    let replayDocumentBounds;
    if (state === "primary") {
      replayDocumentBounds = await page.locator('iframe[title="Isolated non-interactive historical replay"]').evaluate((frame) => {
        const rect = frame.getBoundingClientRect();
        return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
      });
    }
    let capturePixelProof;
    if (replayDocumentBounds !== undefined) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.screenshot({ path: capturePath, fullPage: true });
        capturePixelProof = analyzeRenderedPixels(await readFile(capturePath), replayDocumentBounds);
        if (capturePixelProof.nonBackgroundRatio > 0.002 && capturePixelProof.luminanceStandardDeviation > 2) break;
        await page.waitForTimeout(100);
      }
      assert(capturePixelProof.nonBackgroundRatio > 0.002 && capturePixelProof.luminanceStandardDeviation > 2, `${viewport.width}x${viewport.height} saved primary capture has a blank replay viewport: ${JSON.stringify(capturePixelProof)}`);
    }
    else await page.screenshot({ path: capturePath, fullPage: true });
    results.push({ ...viewport, ...measurements, ...(firstFrameProof === undefined ? {} : { firstFrameProof }), ...(capturePixelProof === undefined ? {} : { capturePixelProof }) });
  }
  return results;
}

async function startExactApplication(projectRoot, selectedWebRoot = webRoot) {
  const application = await startLocalApplication({ projectRoot, webRoot: selectedWebRoot, port: 4175, seedImplementationFixture: false, now: () => new Date("2026-08-18T11:36:00.000Z"), lifecycleSweepEveryMs: 60 * 60 * 1000 });
  assert(application.origin === PARENT_ORIGIN, `Parent did not bind exact 4175: ${application.origin}`);
  return application;
}

function assertClosedLifecycle(snapshot, label) {
  for (const counter of ["frames", "channels", "ports", "players", "timers", "listeners", "objectUrls", "heapProxyResources"]) assert(snapshot?.[counter] === 0, `${label} retained ${counter}: ${JSON.stringify(snapshot)}`);
}

async function verifyTerminalBootstrap(browser, projectRoot, events, eventBytes) {
  const application = await startExactApplication(projectRoot);
  const context = await browser.newContext();
  const results = {};
  async function runtimePage() {
    const page = await context.newPage();
    const response = await page.goto(`${RUNTIME_ORIGIN}/runtime`);
    assert(response?.status() === 200, "Direct runtime handler page did not load.");
    return page;
  }
  async function snapshot(page) {
    return page.evaluate(() => ({ state: document.querySelector("#replay-root")?.getAttribute("data-runtime-state"), lifecycle: window.__REMO_REPLAY_LIFECYCLE__?.() }));
  }
  try {
    const invalidCases = [
      { label: "wrong-source", origin: PARENT_ORIGIN, sourceKind: "null", data: { type: "remo.replay.bootstrap", protocol: "remo.replay-runtime.v1" }, ports: 1 },
      { label: "wrong-origin", origin: "http://127.0.0.1:4999", sourceKind: "parent", data: { type: "remo.replay.bootstrap", protocol: "remo.replay-runtime.v1" }, ports: 1 },
      { label: "wrong-window", origin: PARENT_ORIGIN, sourceKind: "frame", data: { type: "remo.replay.bootstrap", protocol: "remo.replay-runtime.v1" }, ports: 1 },
      { label: "malformed-bootstrap", origin: PARENT_ORIGIN, sourceKind: "parent", data: { type: "remo.replay.bootstrap", protocol: "wrong" }, ports: 1 },
      { label: "duplicate-transferred-port", origin: PARENT_ORIGIN, sourceKind: "parent", data: { type: "remo.replay.bootstrap", protocol: "remo.replay-runtime.v1" }, ports: 2 },
    ];
    for (const testCase of invalidCases) {
      const page = await runtimePage();
      await page.evaluate((test) => {
        const channels = Array.from({ length: test.ports }, () => new MessageChannel());
        let source = null;
        if (test.sourceKind === "parent") source = window;
        if (test.sourceKind === "frame") { const frame = document.createElement("iframe"); document.body.append(frame); source = frame.contentWindow; }
        window.dispatchEvent(new MessageEvent("message", { data: test.data, origin: test.origin, source, ports: channels.map(({ port1 }) => port1) }));
      }, testCase);
      await page.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "bootstrap-rejected");
      const result = await snapshot(page);
      assertClosedLifecycle(result.lifecycle, testCase.label);
      results[testCase.label] = result;
      await page.close();
    }

    const latePage = await runtimePage();
    await latePage.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "bootstrap-timeout", undefined, { timeout: 4_000 });
    const beforeLate = await snapshot(latePage);
    assertClosedLifecycle(beforeLate.lifecycle, "bootstrap-timeout");
    await latePage.evaluate(({ origin, protocol }) => {
      const channel = new MessageChannel();
      window.dispatchEvent(new MessageEvent("message", { data: { type: "remo.replay.bootstrap", protocol }, origin, source: window, ports: [channel.port1] }));
    }, { origin: PARENT_ORIGIN, protocol: "remo.replay-runtime.v1" });
    await latePage.waitForTimeout(50);
    const afterLate = await snapshot(latePage);
    assert(afterLate.state === "bootstrap-timeout", `Late bootstrap changed terminal state: ${JSON.stringify(afterLate)}`);
    assertClosedLifecycle(afterLate.lifecycle, "late-bootstrap");
    results["timeout-then-late"] = afterLate;
    await latePage.close();

    const initialization = {
      protocol: "remo.replay-runtime.v1",
      type: "initialize",
      capability: "A".repeat(43),
      identity: { savePointId: SAVE_POINT_ID, componentId: `${TURN_ID}:rrweb`, revision: 3, manifestDigest: `sha256:${"a".repeat(64)}`, digest: `sha256:${"b".repeat(64)}` },
      durationMs: Math.max(...events.map(({ timestamp }) => timestamp)) - Math.min(...events.map(({ timestamp }) => timestamp)),
      eventBytes,
      viewport: { width: 1440, height: 900 },
      events,
    };
    async function bootstrapValid(page, message = initialization) {
      await page.evaluate(({ origin, bootstrapProtocol, initialize }) => {
        const channel = new MessageChannel();
        const session = { port: channel.port2, capability: initialize.capability, identityKey: "", messages: [] };
        window.__T3_RUNTIME_HANDLER_TEST__ = session;
        channel.port2.onmessage = ({ data }) => {
          session.messages.push(data);
          if (data?.type === "frame-rebuilt") {
            session.identityKey = data.identityKey;
            channel.port2.postMessage({ protocol: bootstrapProtocol, type: "confirm-painted-frame", capability: data.capability, identityKey: data.identityKey });
          }
        };
        channel.port2.start();
        window.dispatchEvent(new MessageEvent("message", { data: { type: "remo.replay.bootstrap", protocol: bootstrapProtocol }, origin, source: window, ports: [channel.port1] }));
        channel.port2.postMessage(initialize);
      }, { origin: PARENT_ORIGIN, bootstrapProtocol: "remo.replay-runtime.v1", initialize: message });
    }

    const malformedPage = await runtimePage();
    await bootstrapValid(malformedPage, { invalid: true });
    await malformedPage.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "initialize-rejected");
    const malformed = await snapshot(malformedPage);
    assertClosedLifecycle(malformed.lifecycle, "malformed-initialize");
    results["malformed-initialize"] = malformed;
    await malformedPage.close();

    const duplicatePage = await runtimePage();
    await bootstrapValid(duplicatePage);
    await duplicatePage.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "ready");
    await duplicatePage.evaluate((initialize) => window.__T3_RUNTIME_HANDLER_TEST__.port.postMessage(initialize), initialization);
    await duplicatePage.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "replay.protocol-failure");
    const duplicate = await snapshot(duplicatePage);
    assertClosedLifecycle(duplicate.lifecycle, "duplicate-initialize");
    results["duplicate-initialize"] = duplicate;
    await duplicatePage.close();

    const duplicateBootstrapPage = await runtimePage();
    await bootstrapValid(duplicateBootstrapPage);
    await duplicateBootstrapPage.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "ready");
    await duplicateBootstrapPage.evaluate(({ origin, protocol }) => {
      const channel = new MessageChannel();
      const transferred = channel.port1;
      const originalClose = window.MessagePort.prototype.close;
      const duplicate = { port: channel.port2, transferredCloseCalls: 0, restoreClose: () => { window.MessagePort.prototype.close = originalClose; } };
      window.MessagePort.prototype.close = function closeInstrumentedPort() {
        duplicate.transferredCloseCalls += 1;
        return originalClose.call(this);
      };
      window.__T3_DUPLICATE_BOOTSTRAP_TEST__ = duplicate;
      channel.port2.start();
      window.dispatchEvent(new MessageEvent("message", { data: { type: "remo.replay.bootstrap", protocol }, origin, source: window, ports: [transferred] }));
      channel.port2.postMessage({ type: "initialize", capability: "B".repeat(43) });
    }, { origin: PARENT_ORIGIN, protocol: "remo.replay-runtime.v1" });
    await duplicateBootstrapPage.waitForFunction(() => window.__T3_DUPLICATE_BOOTSTRAP_TEST__?.transferredCloseCalls === 1);
    await duplicateBootstrapPage.evaluate(() => window.__T3_DUPLICATE_BOOTSTRAP_TEST__.restoreClose());
    const duplicateBootstrapAcceptedState = await snapshot(duplicateBootstrapPage);
    assert(duplicateBootstrapAcceptedState.state === "ready", `Duplicate bootstrap changed the accepted session: ${JSON.stringify(duplicateBootstrapAcceptedState)}`);
    await duplicateBootstrapPage.evaluate((protocol) => {
      const session = window.__T3_RUNTIME_HANDLER_TEST__;
      session.port.postMessage({ protocol, type: "restart", capability: session.capability, identityKey: session.identityKey, commandId: 1 });
    }, "remo.replay-runtime.v1");
    await duplicateBootstrapPage.waitForFunction(() => window.__T3_RUNTIME_HANDLER_TEST__?.messages.some((message) => message?.type === "status" && message.commandId === 1 && message.state === "paused"));
    await duplicateBootstrapPage.evaluate((protocol) => {
      const session = window.__T3_RUNTIME_HANDLER_TEST__;
      session.port.postMessage({ protocol, type: "destroy", capability: session.capability, identityKey: session.identityKey, commandId: 2 });
    }, "remo.replay-runtime.v1");
    await duplicateBootstrapPage.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "destroyed");
    const duplicateBootstrap = await snapshot(duplicateBootstrapPage);
    assertClosedLifecycle(duplicateBootstrap.lifecycle, "accepted-then-duplicate-bootstrap");
    results["accepted-then-duplicate-bootstrap"] = { ...duplicateBootstrap, duplicateTransferredPortCloseCalls: 1, acceptedSessionCommandAfterDuplicate: "restart-acknowledged" };
    await duplicateBootstrapPage.close();

    const destroyedPage = await runtimePage();
    await bootstrapValid(destroyedPage);
    await destroyedPage.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "ready");
    await destroyedPage.evaluate((protocol) => {
      const session = window.__T3_RUNTIME_HANDLER_TEST__;
      session.port.postMessage({ protocol, type: "destroy", capability: session.capability, identityKey: session.identityKey, commandId: 1 });
      session.port.postMessage({ protocol, type: "play", capability: session.capability, identityKey: session.identityKey, commandId: 2 });
    }, "remo.replay-runtime.v1");
    await destroyedPage.waitForFunction(() => document.querySelector("#replay-root")?.getAttribute("data-runtime-state") === "destroyed");
    const postDestroy = await snapshot(destroyedPage);
    assertClosedLifecycle(postDestroy.lifecycle, "post-destroy");
    results["post-destroy"] = postDestroy;
    await destroyedPage.close();
  } finally {
    await context.close();
    await application.close();
  }
  return results;
}

async function verifyRepeatedLifecycle(browser, projectRoot) {
  const application = await startExactApplication(projectRoot);
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const cycles = [];
  const telemetry = createTelemetry(page);
  const terminalBinding = "__T3_REMO_RUNTIME_TERMINAL__";
  const pendingTerminalReports = new Map();
  const terminalDeliveryCounts = new Map();
  const observerErrors = [];
  await page.exposeBinding(terminalBinding, ({ frame }, report) => {
    try {
      assert(frame.url() === `${RUNTIME_ORIGIN}/runtime`, `Terminal lifecycle report came from an unexpected frame: ${frame.url()}`);
      assert(report !== null && typeof report === "object", `Terminal lifecycle report is malformed: ${JSON.stringify(report)}`);
      const { cycleId, runtimeRealmId } = report;
      assert(typeof cycleId === "string" && typeof runtimeRealmId === "string", `Terminal lifecycle correlation is malformed: ${JSON.stringify(report)}`);
      terminalDeliveryCounts.set(cycleId, (terminalDeliveryCounts.get(cycleId) ?? 0) + 1);
      const pending = pendingTerminalReports.get(cycleId);
      assert(pending !== undefined, `Terminal lifecycle report has no pending cycle: ${JSON.stringify(report)}`);
      assert(pending.runtimeRealmId === runtimeRealmId, `Terminal lifecycle report crossed runtime realms: ${JSON.stringify({ expected: pending.runtimeRealmId, report })}`);
      pendingTerminalReports.delete(cycleId);
      pending.resolve({ ...report, sourceFrameUrl: frame.url() });
    } catch (error) {
      observerErrors.push(error instanceof Error ? error.message : String(error));
    }
  });
  function waitForTerminalReport(cycleId, runtimeRealmId) {
    return new Promise((resolveReport, rejectReport) => {
      const timeout = setTimeout(() => {
        pendingTerminalReports.delete(cycleId);
        rejectReport(new Error(`Cycle ${cycleId} did not report terminal runtime lifecycle before detachment.`));
      }, 5_000);
      pendingTerminalReports.set(cycleId, {
        runtimeRealmId,
        resolve: (report) => {
          clearTimeout(timeout);
          resolveReport(report);
        },
      });
    });
  }
  try {
    await page.goto(`${PARENT_ORIGIN}/save-points/${SAVE_POINT_ID}?replayLifecycleProfile=same-document`, { waitUntil: "networkidle" });
    await waitForPrimary(page, telemetry);
    const realmId = await page.evaluate(() => {
      window.__T3_SAME_DOCUMENT_REALM__ = window.crypto.randomUUID();
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new window.PopStateEvent("popstate"));
      return window.__T3_SAME_DOCUMENT_REALM__;
    });
    await page.locator("iframe.replay-frame").waitFor({ state: "detached" });
    const originalBaseline = await page.evaluate(() => window.__REMO_REPLAY_LIFECYCLE__?.());
    assertClosedLifecycle(originalBaseline, "original-same-document-baseline");
    const baselineDomNodes = originalBaseline.domNodes;
    for (let cycle = 0; cycle < 8; cycle += 1) {
      await page.evaluate((path) => { window.history.pushState({}, "", path); window.dispatchEvent(new window.PopStateEvent("popstate")); }, `/save-points/${SAVE_POINT_ID}?replayLifecycleProfile=same-document`);
      await waitForPrimary(page, telemetry);
      await page.getByRole("button", { name: "Start replay", exact: true }).click();
      await page.getByText("Playing historical evidence", { exact: true }).waitFor();
      const activeParent = await page.evaluate(() => window.__REMO_REPLAY_LIFECYCLE__?.());
      const activeRuntimeFrame = page.frames().find((frame) => frame.url() === `${RUNTIME_ORIGIN}/runtime`);
      assert(activeRuntimeFrame !== undefined, `Cycle ${cycle + 1} runtime frame is missing before observer installation.`);
      const activeRuntime = (await runtimeFrameProof(page)).lifecycle;
      assert(activeParent?.frames === 1 && activeParent.channels === 1 && activeParent.ports === 1 && activeParent.players === 0 && activeParent.timers === 1 && activeParent.listeners === 2 && activeParent.objectUrls === 1, `Cycle ${cycle + 1} parent lifecycle is unstable during playback: ${JSON.stringify(activeParent)}`);
      assert(activeRuntime?.frames === 0 && activeRuntime.channels === 1 && activeRuntime.ports === 1 && activeRuntime.players === 1 && activeRuntime.timers === 0 && activeRuntime.listeners === 4 && activeRuntime.objectUrls === 0, `Cycle ${cycle + 1} runtime lifecycle is unstable: ${JSON.stringify(activeRuntime)}`);
      const cycleId = `same-document-cycle-${cycle + 1}`;
      const observerRegistration = await activeRuntimeFrame.evaluate(({ bindingName, correlatedCycleId }) => {
        const reporter = window[bindingName];
        if (typeof reporter !== "function") throw new Error("Verifier terminal lifecycle binding is unavailable.");
        const runtimeRealmId = window.crypto.randomUUID();
        const lifecycleAtRegistration = window.__REMO_REPLAY_LIFECYCLE__?.();
        window.addEventListener("pagehide", () => {
          const root = document.querySelector("#replay-root");
          const lifecycle = window.__REMO_REPLAY_LIFECYCLE__?.();
          void reporter({ cycleId: correlatedCycleId, runtimeRealmId, terminalState: root?.getAttribute("data-runtime-state"), lifecycle });
        }, { once: true });
        return { cycleId: correlatedCycleId, runtimeRealmId, lifecycleAtRegistration };
      }, { bindingName: terminalBinding, correlatedCycleId: cycleId });
      assert(JSON.stringify(observerRegistration.lifecycleAtRegistration) === JSON.stringify(activeRuntime), `Cycle ${cycle + 1} verifier observer changed tracked runtime resources: ${JSON.stringify({ activeRuntime, observerRegistration })}`);
      const terminalReportPromise = waitForTerminalReport(cycleId, observerRegistration.runtimeRealmId);
      await page.evaluate(() => { window.history.pushState({}, "", "/"); window.dispatchEvent(new window.PopStateEvent("popstate")); });
      const terminalRuntime = await terminalReportPromise;
      assert(terminalRuntime.terminalState === "pagehide" || terminalRuntime.terminalState === "destroyed", `Cycle ${cycle + 1} runtime reported an unapproved terminal state: ${JSON.stringify(terminalRuntime)}`);
      assertClosedLifecycle(terminalRuntime.lifecycle, `cycle-${cycle + 1}-terminal-runtime`);
      assert(terminalDeliveryCounts.get(cycleId) === 1, `Cycle ${cycle + 1} verifier observer delivered more than once.`);
      await page.locator("iframe.replay-frame").waitFor({ state: "detached" });
      await page.waitForFunction(() => window.__REMO_REPLAY_LIFECYCLE__?.().heapProxyResources === 0);
      const baseline = await page.evaluate(() => window.__REMO_REPLAY_LIFECYCLE__?.());
      assertClosedLifecycle(baseline, `cycle-${cycle + 1}-baseline`);
      assert(page.frames().length === 1, `Cycle ${cycle + 1} retained a runtime frame.`);
      assert(baseline.domNodes === baselineDomNodes, `Cycle ${cycle + 1} DOM proxy did not return to baseline: ${JSON.stringify({ baselineDomNodes, current: baseline.domNodes })}`);
      const realm = await page.evaluate(() => ({ id: window.__T3_SAME_DOCUMENT_REALM__, navigationEntries: performance.getEntriesByType("navigation").length }));
      assert(realm.id === realmId && realm.navigationEntries === 1, `Cycle ${cycle + 1} replaced the browser realm: ${JSON.stringify(realm)}`);
      cycles.push({
        cycle: cycle + 1,
        transition: "same-document-pushState-popstate",
        activeParent,
        activeRuntime,
        terminalRuntime,
        observer: {
          type: "verifier-only-one-shot-pagehide",
          registeredAfterRuntimeTeardownListener: true,
          trackedLifecycleUnchangedOnRegistration: true,
          deliveryCount: terminalDeliveryCounts.get(cycleId),
          pendingAfterDelivery: pendingTerminalReports.has(cycleId),
        },
        baseline,
        frameCount: page.frames().length,
        realm: { ...realm, runtimeId: observerRegistration.runtimeRealmId },
      });
    }
    assert(observerErrors.length === 0, `Verifier terminal observer errors: ${observerErrors.join(" | ")}`);
    assert(pendingTerminalReports.size === 0, `Verifier terminal observer retained pending cycles: ${JSON.stringify([...pendingTerminalReports.keys()])}`);
    assert([...terminalDeliveryCounts.values()].every((count) => count === 1), `Verifier terminal observer delivery counts are unstable: ${JSON.stringify([...terminalDeliveryCounts])}`);
    await assertTelemetry(telemetry, "repeated-lifecycle");
  } finally {
    await context.close();
    await application.close();
  }
  return cycles;
}

async function verifyPrimary(browser, projectRoot) {
  const application = await startExactApplication(projectRoot);
  assert(application.replayRuntime.state === "available" && application.replayRuntime.origin === RUNTIME_ORIGIN, `Replay runtime was not composed on exact 4176: ${JSON.stringify(application.replayRuntime)}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const telemetry = createTelemetry(page);
  const route = `${PARENT_ORIGIN}/save-points/${SAVE_POINT_ID}`;
  const selectionMs = [];
  const firstFrameMs = [];
  const commandMs = [];
  let security;
  let primaryResponsive;
  let runtimeLossScreenshotRetained = false;
  try {
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const response = await page.goto(route, { waitUntil: "networkidle" });
      assert(response?.status() === 200, `Primary route returned ${String(response?.status())}.`);
      await waitForPrimary(page, telemetry);
      selectionMs.push(performance.now() - started);
      if (index === 0) { primaryResponsive = await assertResponsive(page, "primary"); await page.setViewportSize({ width: 1440, height: 900 }); }
      if (index < 5) {
        commandMs.push(await clickAndMeasure(page, page.getByRole("button", { name: "Start replay", exact: true })));
        const metric = Number(await page.getByLabel("Replay performance samples").getAttribute("data-first-frame-ms"));
        assert(Number.isFinite(metric), `First-frame sample ${index + 1} is missing.`);
        firstFrameMs.push(metric);
      }
    }

    const parentResponse = await page.goto(route, { waitUntil: "networkidle" });
    const parentCsp = parentResponse?.headers()["content-security-policy"] ?? "";
    assert(parentCsp.includes("style-src 'self'") && parentCsp.includes(`frame-src ${RUNTIME_ORIGIN}`) && !parentCsp.includes("unsafe-inline") && !parentCsp.includes("unsafe-eval") && !parentCsp.includes("*"), `Parent CSP widened: ${parentCsp}`);
    await waitForPrimary(page, telemetry);
    await page.evaluate(() => { window.__REMO_REPLAY_INTEGRITY_MARKER__ = "parent-unchanged"; document.body.dataset.replayIntegrityMarker = "parent-unchanged"; });
    commandMs.length = 0;
    for (let index = 0; index < 10; index += 1) {
      commandMs.push(await clickAndMeasure(page, page.getByRole("button", { name: /^(?:Start|Resume) replay$/u })));
      await page.getByText("Playing historical evidence", { exact: true }).waitFor();
      commandMs.push(await clickAndMeasure(page, page.getByRole("button", { name: "Pause", exact: true })));
      await page.getByText("Replay paused", { exact: true }).waitFor();
    }
    const slider = page.getByRole("slider", { name: "Seek within replay" });
    for (let index = 0; index < 5; index += 1) {
      const duration = Number(await slider.getAttribute("max"));
      const target = Math.floor((duration * ((index + 1) / 6)) / 50) * 50;
      const before = await sampleCount(page);
      await slider.fill(String(target));
      await page.waitForFunction((count) => Number(document.querySelector('[aria-label="Replay performance samples"]')?.getAttribute("data-sample-count")) > count, before);
      commandMs.push(Number(await page.getByLabel("Replay performance samples").getAttribute("data-latest-command-ms")));
      commandMs.push(await clickAndMeasure(page, page.getByRole("button", { name: "Restart", exact: true })));
    }
    assert(commandMs.length === 30, `Expected 30 warm command samples, received ${commandMs.length}.`);

    const outer = page.locator("iframe.replay-frame");
    assert(await outer.getAttribute("sandbox") === "allow-scripts allow-same-origin", "Outer replay iframe sandbox changed.");
    const runtimeFrame = page.frames().find((frame) => frame.url() === `${RUNTIME_ORIGIN}/runtime`);
    assert(runtimeFrame !== undefined, "Cross-origin runtime frame is missing.");
    const parentCannotReadRuntime = await page.evaluate(() => {
      const frame = document.querySelector("iframe.replay-frame");
      if (!(frame instanceof HTMLIFrameElement)) return false;
      try { return frame.contentDocument === null && frame.contentWindow?.document === undefined; } catch { return frame.contentDocument === null; }
    });
    const runtimeIsolation = await runtimeFrame.evaluate(() => {
      let parentReadable = false;
      try { parentReadable = parent.document.body.dataset.replayIntegrityMarker === "parent-unchanged"; } catch { parentReadable = false; }
      const nested = document.querySelector("iframe.remo-reconstruction-frame");
      const activeNodes = nested instanceof HTMLIFrameElement ? nested.contentDocument?.querySelectorAll("script,iframe,frame,object,embed,form,audio,video,source,track,canvas").length ?? -1 : -1;
      const nestedDocument = nested instanceof HTMLIFrameElement ? nested.contentDocument : null;
      return {
        parentReadable,
        cookie: document.cookie,
        localStorageLength: localStorage.length,
        sessionStorageLength: sessionStorage.length,
        nestedSandbox: nested?.getAttribute("sandbox"),
        nestedTabIndex: nested?.getAttribute("tabindex"),
        activeNodes,
        nestedElementCount: nestedDocument?.querySelectorAll("*").length ?? -1,
        nestedText: nestedDocument?.body?.innerText.slice(0, 160) ?? "",
        nestedViewport: nested instanceof HTMLIFrameElement ? { width: nested.clientWidth, height: nested.clientHeight, scrollWidth: nestedDocument?.documentElement.scrollWidth ?? -1, scrollHeight: nestedDocument?.documentElement.scrollHeight ?? -1 } : null,
        wrapperInert: document.querySelector(".remo-reconstruction-wrapper")?.hasAttribute("inert") ?? false,
      };
    });
    const parentMarker = await page.evaluate(() => window.__REMO_REPLAY_INTEGRITY_MARKER__);
    assert(parentCannotReadRuntime && !runtimeIsolation.parentReadable && parentMarker === "parent-unchanged", "Parent/runtime DOM isolation failed.");
    assert(runtimeIsolation.cookie === "" && runtimeIsolation.localStorageLength === 0 && runtimeIsolation.sessionStorageLength === 0, "Replay runtime touched cookies or origin storage.");
    assert(runtimeIsolation.nestedSandbox === "allow-same-origin" && runtimeIsolation.nestedTabIndex === "-1" && runtimeIsolation.activeNodes === 0 && runtimeIsolation.nestedElementCount > 10 && runtimeIsolation.nestedText.includes("Save point evidence") && runtimeIsolation.nestedViewport?.width > 0 && runtimeIsolation.nestedViewport.height > 0 && runtimeIsolation.wrapperInert, `Reconstruction boundary is not a meaningful safe frame: ${JSON.stringify(runtimeIsolation)}`);
    security = { parentCsp, parentCannotReadRuntime, parentMarker, runtimeIsolation };

    assert(nearestRankP95(commandMs) <= 100, `Warm command p95 exceeded 100ms: ${nearestRankP95(commandMs)}ms.`);
    assert(nearestRankP95(firstFrameMs) <= 1_000, `First-safe-frame p95 exceeded 1000ms: ${nearestRankP95(firstFrameMs)}ms.`);
    await outer.dispatchEvent("load");
    await page.getByText("Replay runtime was lost", { exact: true }).waitFor();
    runtimeLossScreenshotRetained = await page.getByRole("img", { name: /Privacy-checked captured UI/u }).isVisible();
    assert(runtimeLossScreenshotRetained, "Runtime loss removed the authoritative screenshot.");
    await assertTelemetry(telemetry, "primary/runtime-loss");
  } finally {
    await context.close();
    await application.close();
  }
  const runtimeClosed = await fetch(`${RUNTIME_ORIGIN}/runtime`).then(() => false, () => true);
  assert(runtimeClosed, "Replay listener remained reachable after composed shutdown.");
  return { route, selectionMs, commandMs, firstFrameMs, security, primaryResponsive, runtimeLossScreenshotRetained, telemetry: { consoleErrors: telemetry.consoleErrors, pageErrors: telemetry.pageErrors, unexpectedRequests: telemetry.unexpectedRequests, webSockets: telemetry.webSockets, runtimeCredentialRequests: telemetry.runtimeCredentialRequests, responsePolicyFailures: telemetry.responsePolicyFailures } };
}

async function verifyDegraded(browser, projectRoot) {
  const degradedRoot = join(projectRoot, "web-runtime-assets-missing");
  await cp(webRoot, degradedRoot, { recursive: true });
  await rm(join(degradedRoot, ".vite/manifest.json"));
  let application = await startExactApplication(projectRoot, degradedRoot);
  assert(application.replayRuntime.state === "listener-unavailable" && application.replayRuntime.reasonCode === "replay.runtime-assets-unavailable", `Missing runtime assets did not project truthfully: ${JSON.stringify(application.replayRuntime)}`);
  let context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  let page = await context.newPage();
  let telemetry = createTelemetry(page);
  try {
    await page.goto(`${PARENT_ORIGIN}/save-points/${SAVE_POINT_ID}`, { waitUntil: "networkidle" });
    await page.getByRole("img", { name: /Privacy-checked captured UI/u }).waitFor();
    await page.getByText("Replay runtime unavailable", { exact: true }).waitFor();
    assert(await page.locator("iframe.replay-frame").count() === 0, "Assets failure created a replay iframe.");
    await assertTelemetry(telemetry, "runtime-assets-unavailable");
  } finally {
    await context.close();
    await application.close();
  }

  const blocker = createServer((_request, response) => response.writeHead(404).end());
  blocker.listen(4176, "127.0.0.1");
  await once(blocker, "listening");
  application = await startExactApplication(projectRoot);
  assert(application.replayRuntime.state === "listener-unavailable" && application.replayRuntime.reasonCode === "replay.listener-unavailable", `Bound listener did not project truthfully: ${JSON.stringify(application.replayRuntime)}`);
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page = await context.newPage();
  telemetry = createTelemetry(page);
  let degradedResponsive;
  try {
    await page.goto(`${PARENT_ORIGIN}/save-points/${SAVE_POINT_ID}`, { waitUntil: "networkidle" });
    await page.getByRole("img", { name: /Privacy-checked captured UI/u }).waitFor();
    await page.getByText("Replay runtime unavailable", { exact: true }).waitFor();
    assert(await page.locator("iframe.replay-frame").count() === 0, "Listener failure created a replay iframe.");
    degradedResponsive = await assertResponsive(page, "degraded-listener-unavailable");
    await assertTelemetry(telemetry, "listener-unavailable");
  } finally {
    await context.close();
    await application.close();
    blocker.close();
    await once(blocker, "close");
  }
  return { assetsFailure: "replay.runtime-assets-unavailable", listenerFailure: "replay.listener-unavailable", degradedResponsive };
}

const projectRoot = await mkdtemp(join(tmpdir(), "remo-t3-s001-"));
await mkdir(join(projectRoot, ".git"));
await mkdir(artifactDirectory, { recursive: true });
const rrwebBytes = await readFile(join(fixtureDirectory, "privacy-cleared.rrweb.json"));
const screenshotBytes = await readFile(join(fixtureDirectory, "privacy-cleared.png"));
const metadata = JSON.parse(await readFile(join(fixtureDirectory, "capture-metadata.json"), "utf8"));
assert(metadata.privacyReceipt.rrwebDigest === digest(rrwebBytes) && metadata.privacyReceipt.screenshotDigest === digest(screenshotBytes), "Tracked S-001 media no longer matches its privacy receipt.");
const reviewed = candidate(rrwebBytes, screenshotBytes, metadata.privacyReceipt);
assert(reviewed.status === "reviewable", "S-001 actual media must remain privacy-cleared and reviewable.");
const repository = new LocalSavePointRepository({ projectRoot, now: () => new Date("2026-08-18T11:35:00.000Z") });
await createPromotionService(repository).promote(reviewed, confirmCandidateIntent(reviewed));
repository.close();

const browser = await chromium.launch({ headless: true });
try {
  const terminalBootstrap = await verifyTerminalBootstrap(browser, projectRoot, JSON.parse(rrwebBytes.toString("utf8")), rrwebBytes.byteLength);
  const repeatedLifecycle = await verifyRepeatedLifecycle(browser, projectRoot);
  const primary = await verifyPrimary(browser, projectRoot);
  const degraded = await verifyDegraded(browser, projectRoot);
  const ledger = {
    event: "s001.actual-media.production-acceptance",
    composition: { parentOrigin: PARENT_ORIGIN, runtimeOrigin: RUNTIME_ORIGIN, replayPackage: "@rrweb/replay@2.1.1", webRoot: "apps/web/dist" },
    browser: { name: "chromium", version: await browser.version(), headless: true, reducedMotion: "reduce" },
    media: { rrwebDigest: digest(rrwebBytes), rrwebSize: rrwebBytes.byteLength, screenshotDigest: digest(screenshotBytes), screenshotSize: screenshotBytes.byteLength, eventCount: JSON.parse(rrwebBytes.toString("utf8")).length },
    streams: { activeSafelyAvailable: [SAVE_POINT_ID], reconstructed: [SAVE_POINT_ID], missingOrDeleted: "covered by focused service/web degradation suites" },
    performance: {
      profile: { selections: 30, commands: 30, firstFrameStarts: 5, lifecycleCycles: repeatedLifecycle.length, cpuThrottling: false, nearestRank: true },
      selectionP95Ms: Number(nearestRankP95(primary.selectionMs).toFixed(3)),
      commandP95Ms: Number(nearestRankP95(primary.commandMs).toFixed(3)),
      firstSafeFrameP95Ms: Number(nearestRankP95(primary.firstFrameMs).toFixed(3)),
      thresholdsMs: { commandAcknowledgement: 100, firstSafeFrame: 1_000 },
    },
    responsive: { primary: primary.primaryResponsive, degraded: degraded.degradedResponsive },
    security: { ...primary.security, telemetry: primary.telemetry, terminalBootstrap, activeContentRejection: "focused handler/runtime tests", runtimeLossScreenshotRetained: primary.runtimeLossScreenshotRetained },
    degradation: degraded,
    cleanup: { composedShutdownClosed4176: true, contextsClosed: true, repeatedLifecycle, temporaryProjectRemovedByVerifier: true },
  };
  await writeFile(join(artifactDirectory, "acceptance-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(ledger)}\n`);
} finally {
  await browser.close();
  await rm(projectRoot, { recursive: true, force: true });
}
