import { chromium, type Browser, type BrowserContext, type LaunchOptions } from "playwright";

const RECORDER_BOOTSTRAP = String.raw`
(() => {
  const state = {
    installedAt: Date.now(), active: true, events: [], observer: null,
    stop() { this.active = false; if (this.observer) this.observer.disconnect(); }
  };
  Object.defineProperty(window, "__REMO_BOUNDED_RECORDER__", {
    value: state, configurable: false, enumerable: false, writable: false
  });
})();
`;

export type CaptureStopReason = "user" | "test-cleanup" | "boundary-violation";
export type CaptureViolationCode = "browser.navigation" | "browser.popup" | "browser.frame" | "browser.origin-mismatch" | "browser.path-mismatch" | "browser.root-missing" | "browser.root-ambiguous";
export interface CaptureViolation { readonly reasonCode: CaptureViolationCode; readonly explanation: string }

export class CaptureBoundaryError extends Error {
  readonly reasonCode: CaptureViolationCode;
  constructor(violation: CaptureViolation) {
    super(violation.explanation);
    this.name = "CaptureBoundaryError";
    this.reasonCode = violation.reasonCode;
  }
}

export interface ControlledCaptureConfig {
  readonly origin: string;
  readonly path: string;
  readonly captureRoot: string;
  readonly launchOptions?: LaunchOptions;
  readonly viewport?: { readonly width: number; readonly height: number };
}
export type ControlledCaptureState =
  | { readonly status: "recording"; readonly url: string }
  | { readonly status: "stopped"; readonly url: string; readonly stopReason: CaptureStopReason }
  | { readonly status: "failed"; readonly url: string; readonly violation: CaptureViolation };
export interface ControlledCaptureSession {
  state(): ControlledCaptureState;
  stop(reason: CaptureStopReason): Promise<void>;
  waitForViolation(): Promise<CaptureViolation>;
  clickWithinRoot(selector: string): Promise<void>;
  readPageMarker(name: string): Promise<string | undefined>;
  captureRootCount(): Promise<number>;
}

function exactUrl(config: ControlledCaptureConfig): string {
  const origin = new URL(config.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== config.origin) {
    throw new CaptureBoundaryError({ reasonCode: "browser.origin-mismatch", explanation: "Capture requires one exact http://127.0.0.1 loopback origin." });
  }
  if (!config.path.startsWith("/") || config.path.includes("?") || config.path.includes("#")) {
    throw new CaptureBoundaryError({ reasonCode: "browser.path-mismatch", explanation: "Capture requires one exact path without query or fragment widening." });
  }
  return `${config.origin}${config.path}`;
}

async function closeQuietly(context: BrowserContext, browser: Browser): Promise<void> {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

export async function startControlledCapture(config: ControlledCaptureConfig): Promise<ControlledCaptureSession> {
  const allowedUrl = exactUrl(config);
  const browser = await chromium.launch(config.launchOptions);
  const context = await browser.newContext(config.viewport === undefined ? {} : { viewport: config.viewport });
  await context.addInitScript({ content: RECORDER_BOOTSTRAP });
  const page = await context.newPage();
  let currentState: ControlledCaptureState = { status: "recording", url: allowedUrl };
  let resolveViolation: ((violation: CaptureViolation) => void) | undefined;
  let activeViolation: CaptureViolation | undefined;
  const violationPromise = new Promise<CaptureViolation>((resolve) => { resolveViolation = resolve; });
  let closePromise: Promise<void> | undefined;
  const fail = (violation: CaptureViolation): void => {
    if (currentState.status !== "recording") return;
    activeViolation = violation;
    currentState = { status: "failed", url: page.url(), violation };
    resolveViolation?.(violation);
    closePromise = closeQuietly(context, browser);
  };

  context.on("page", (openedPage) => {
    if (openedPage !== page) fail({ reasonCode: "browser.popup", explanation: "A popup attempted to widen the capture surface." });
  });
  page.on("frameattached", () => fail({ reasonCode: "browser.frame", explanation: "A frame attempted to enter the bounded page." }));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url() !== allowedUrl) fail({ reasonCode: "browser.navigation", explanation: "The page navigated outside the exact allowed URL." });
  });

  try {
    await page.goto(allowedUrl, { waitUntil: "domcontentloaded" });
    if (activeViolation !== undefined) throw new CaptureBoundaryError(activeViolation);
    const rootCount = await page.locator(config.captureRoot).count();
    if (rootCount !== 1) {
      const violation: CaptureViolation = rootCount === 0
        ? { reasonCode: "browser.root-missing", explanation: "The exact capture root is missing." }
        : { reasonCode: "browser.root-ambiguous", explanation: "The capture root is ambiguous." };
      fail(violation);
      throw new CaptureBoundaryError(violation);
    }
    await page.evaluate((selector) => {
      const recorder = (window as Window & { __REMO_BOUNDED_RECORDER__?: { active: boolean; events: Array<{ type: "mutation"; at: number }>; observer: MutationObserver | null } }).__REMO_BOUNDED_RECORDER__;
      const root = document.querySelector(selector);
      if (recorder === undefined || root === null) throw new Error("bounded recorder or root missing");
      const observer = new MutationObserver(() => { if (recorder.active) recorder.events.push({ type: "mutation", at: Date.now() }); });
      observer.observe(root, { childList: true, subtree: true, attributes: true });
      recorder.observer = observer;
    }, config.captureRoot);
  } catch (error) {
    await (closePromise ?? closeQuietly(context, browser));
    throw error;
  }

  async function stop(reason: CaptureStopReason): Promise<void> {
    if (currentState.status === "stopped") return;
    if (currentState.status === "recording") {
      await page.evaluate(() => (window as Window & { __REMO_BOUNDED_RECORDER__?: { stop(): void } }).__REMO_BOUNDED_RECORDER__?.stop()).catch(() => undefined);
      currentState = { status: "stopped", url: allowedUrl, stopReason: reason };
    }
    await (closePromise ?? closeQuietly(context, browser));
  }

  return {
    state: () => currentState,
    stop,
    waitForViolation: () => violationPromise,
    async clickWithinRoot(selector) {
      try { await page.locator(config.captureRoot).locator(selector).click(); }
      catch (error) { if (currentState.status !== "failed") throw error; }
    },
    readPageMarker: (name) => page.evaluate((marker) => document.documentElement.dataset[marker], name),
    captureRootCount: () => page.locator(config.captureRoot).count(),
  };
}
