import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import type { BrowserContext, Locator, Page } from "playwright";
import {
  PRIVACY_POLICY_REVISION,
  createQuarantineReceipt,
  type PrivacyPassReceipt,
  type PrivacyQuarantineReceipt,
  type PrivacyReasonCode,
} from "../../../domain/src/privacy/receipt.js";

export const PRIVACY_CANARY = "REMO_SECRET_CANARY_V1" as const;

export interface PrivacyCapturePolicy {
  readonly allowedOrigin: string;
  readonly allowedPath: string;
  readonly captureRoot: string;
  readonly maskSelectors: readonly string[];
  readonly blockSelectors: readonly string[];
  readonly ignoreSelectors?: readonly string[];
  readonly forbiddenFields: readonly string[];
  readonly canary: string;
  readonly maskColor: `#${string}`;
}

export interface RrwebPrivacyOptions {
  readonly maskAllInputs: true;
  readonly maskTextSelector: string;
  readonly blockSelector: string;
  readonly ignoreSelector?: string;
  readonly recordCanvas: false;
  readonly recordCrossOriginIframes: false;
  readonly collectFonts: false;
  readonly inlineImages: false;
  readonly recordAfter: "DOMContentLoaded";
  readonly slimDOMOptions: "all";
}

export interface MaskRegion {
  readonly selector: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SafeCandidateEvidence {
  readonly rrwebBytes: Buffer;
  readonly screenshotBytes: Buffer;
  readonly receipt: PrivacyPassReceipt;
}

export type PrivacyCaptureResult =
  | { readonly status: "passed"; readonly evidence: SafeCandidateEvidence }
  | { readonly status: "quarantined"; readonly receipt: PrivacyQuarantineReceipt };

export class PrivacyPreflightError extends Error {
  readonly reasonCode: PrivacyReasonCode;
  constructor(reasonCode: PrivacyReasonCode) {
    super("The privacy capture boundary did not pass preflight.");
    this.name = "PrivacyPreflightError";
    this.reasonCode = reasonCode;
  }
}

interface BrowserPrivacyController {
  start(): void;
  stop(): unknown[];
}

declare global {
  interface Window {
    __REMO_PRIVACY_RRWEB_READY__?: boolean;
    __REMO_PRIVACY_RRWEB__?: BrowserPrivacyController;
  }
}

const require = createRequire(import.meta.url);

function combineSelectors(selectors: readonly string[]): string | undefined {
  return selectors.length === 0 ? undefined : selectors.join(", ");
}

export function createRrwebPrivacyOptions(policy: PrivacyCapturePolicy): RrwebPrivacyOptions {
  const siblingBlock = `body > :not(${policy.captureRoot})`;
  const options: RrwebPrivacyOptions = {
    maskAllInputs: true,
    maskTextSelector: combineSelectors(policy.maskSelectors) ?? policy.captureRoot,
    blockSelector: combineSelectors([...policy.blockSelectors, siblingBlock]) ?? siblingBlock,
    recordCanvas: false,
    recordCrossOriginIframes: false,
    collectFonts: false,
    inlineImages: false,
    recordAfter: "DOMContentLoaded",
    slimDOMOptions: "all",
  };
  const ignoreSelector = policy.ignoreSelectors === undefined ? undefined : combineSelectors(policy.ignoreSelectors);
  return ignoreSelector === undefined ? options : { ...options, ignoreSelector };
}

export async function preparePrivacyRecorder(
  context: BrowserContext,
  policy: PrivacyCapturePolicy,
): Promise<void> {
  const rrwebEntry = require.resolve("rrweb");
  const bundle = await readFile(join(dirname(rrwebEntry), "rrweb.umd.min.cjs"), "utf8");
  const options = createRrwebPrivacyOptions(policy);
  await context.addInitScript({ content: bundle });
  await context.addInitScript(
    ({ rrwebOptions }) => {
      const events: unknown[] = [];
      let stopRecording: (() => void) | undefined;
      Object.defineProperty(window, "__REMO_PRIVACY_RRWEB_READY__", { value: true, configurable: false });
      Object.defineProperty(window, "__REMO_PRIVACY_RRWEB__", {
        configurable: false,
        value: {
          start() {
            if (stopRecording !== undefined) return;
            const rrwebGlobal = (window as Window & { rrweb?: { record(options: Record<string, unknown>): (() => void) | undefined } }).rrweb;
            if (rrwebGlobal === undefined) throw new Error("privacy recorder unavailable");
            stopRecording = rrwebGlobal.record({ ...rrwebOptions, emit: (event: unknown) => events.push(event) });
          },
          stop() {
            stopRecording?.();
            stopRecording = undefined;
            return structuredClone(events);
          },
        },
      });
    },
    { rrwebOptions: options },
  );
}

function exactUrl(policy: PrivacyCapturePolicy): string {
  const origin = new URL(policy.allowedOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== policy.allowedOrigin) {
    throw new PrivacyPreflightError("privacy.origin-mismatch");
  }
  if (!policy.allowedPath.startsWith("/") || policy.allowedPath.includes("?") || policy.allowedPath.includes("#")) {
    throw new PrivacyPreflightError("privacy.origin-mismatch");
  }
  return `${policy.allowedOrigin}${policy.allowedPath}`;
}

async function requireOne(page: Page, selector: string): Promise<Locator> {
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count === 0) throw new PrivacyPreflightError("privacy.selector-missing");
  if (count !== 1) throw new PrivacyPreflightError("privacy.selector-ambiguous");
  return locator;
}

export async function startPrivacyRecording(page: Page, policy: PrivacyCapturePolicy): Promise<void> {
  if (page.url() !== exactUrl(policy)) throw new PrivacyPreflightError("privacy.origin-mismatch");
  if (page.frames().length !== 1) throw new PrivacyPreflightError("privacy.frame-scope");
  await requireOne(page, policy.captureRoot);
  for (const selector of [...policy.maskSelectors, ...policy.blockSelectors]) await requireOne(page, selector);
  const ready = await page.evaluate(() => window.__REMO_PRIVACY_RRWEB_READY__ === true);
  if (!ready) throw new PrivacyPreflightError("privacy.selector-missing");
  await page.evaluate(() => window.__REMO_PRIVACY_RRWEB__?.start());
}

function inspectRrwebValue(value: unknown, policy: PrivacyCapturePolicy, findings: PrivacyReasonCode[], parentKey?: string): void {
  if (Array.isArray(value)) {
    for (const child of value) inspectRrwebValue(child, policy, findings, parentKey);
    return;
  }
  if (typeof value === "string") {
    if (parentKey === "tagName" && value.toLowerCase() === "iframe") findings.push("privacy.frame-scope");
    if (["href", "src"].includes(parentKey ?? "") && /^https?:/iu.test(value)) {
      try { if (new URL(value).origin !== policy.allowedOrigin) findings.push("privacy.origin-mismatch"); }
      catch { findings.push("privacy.origin-mismatch"); }
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  const forbiddenFields = new Set(policy.forbiddenFields);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenFields.has(key)) findings.push("privacy.forbidden-field");
    inspectRrwebValue(child, policy, findings, key);
  }
}

export function verifyRrwebPayload(events: readonly unknown[], policy: PrivacyCapturePolicy): readonly PrivacyReasonCode[] {
  const findings: PrivacyReasonCode[] = [];
  const serialized = JSON.stringify(events);
  if (serialized.includes(policy.canary)) findings.push("privacy.canary-detected");
  inspectRrwebValue(events, policy, findings);
  return [...new Set(findings)].sort();
}

function parseMaskColor(color: `#${string}`): readonly [number, number, number] {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) throw new TypeError("Mask color must use six hexadecimal digits.");
  return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16)];
}

export function verifyScreenshotMaskRegions(
  screenshot: Buffer,
  regions: readonly MaskRegion[],
  viewport: { readonly width: number; readonly height: number },
  maskColor: `#${string}`,
): boolean {
  const png = PNG.sync.read(screenshot);
  const [red, green, blue] = parseMaskColor(maskColor);
  const scaleX = png.width / viewport.width;
  const scaleY = png.height / viewport.height;
  return regions.length > 0 && regions.every((region) => {
    const left = Math.max(0, Math.ceil((region.x + 1) * scaleX));
    const top = Math.max(0, Math.ceil((region.y + 1) * scaleY));
    const right = Math.min(png.width, Math.floor((region.x + region.width - 1) * scaleX));
    const bottom = Math.min(png.height, Math.floor((region.y + region.height - 1) * scaleY));
    if (right <= left || bottom <= top) return false;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (png.width * y + x) * 4;
        if (png.data[offset] !== red || png.data[offset + 1] !== green || png.data[offset + 2] !== blue || png.data[offset + 3] !== 255) return false;
      }
    }
    return true;
  });
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function collectPrivacyClearedEvidence(input: {
  readonly page: Page;
  readonly policy: PrivacyCapturePolicy;
  readonly checkedAt: string;
}): Promise<PrivacyCaptureResult> {
  const { page, policy } = input;
  const failedComponents = new Set<"rrweb" | "screenshot" | "boundary">();
  const findings: PrivacyReasonCode[] = [];
  if (page.url() !== exactUrl(policy)) {
    findings.push("privacy.origin-mismatch");
    failedComponents.add("boundary");
  }
  if (page.frames().length !== 1) {
    findings.push("privacy.frame-scope");
    failedComponents.add("boundary");
  }
  const maskLocators: Locator[] = [];
  const maskRegions: MaskRegion[] = [];
  for (const selector of policy.maskSelectors) {
    try {
      const locator = await requireOne(page, selector);
      const box = await locator.boundingBox();
      if (box === null) throw new PrivacyPreflightError("privacy.selector-missing");
      maskLocators.push(locator);
      maskRegions.push({ selector, ...box });
    } catch (error) {
      findings.push(error instanceof PrivacyPreflightError ? error.reasonCode : "privacy.selector-missing");
      failedComponents.add("screenshot");
    }
  }
  const events = await page.evaluate(() => window.__REMO_PRIVACY_RRWEB__?.stop() ?? []);
  const rrwebBytes = Buffer.from(JSON.stringify(events), "utf8");
  const screenshotBytes = await page.screenshot({ type: "png", mask: maskLocators, maskColor: policy.maskColor });
  const rrwebFindings = verifyRrwebPayload(events, policy);
  findings.push(...rrwebFindings);
  if (rrwebFindings.length > 0) failedComponents.add("rrweb");
  if (rrwebBytes.includes(Buffer.from(policy.canary, "utf8"))) {
    findings.push("privacy.canary-detected");
    failedComponents.add("rrweb");
  }
  const screenshotCanaryCovered = await page.evaluate(
    ({ canary, maskSelectors, blockSelectors }) => {
      const isProtected = (element: Element): boolean =>
        maskSelectors.some((selector) => element.matches(selector)) ||
        blockSelectors.some((selector) => element.matches(selector) || element.closest(selector) !== null);
      for (const element of document.querySelectorAll("input, textarea, select")) {
        const value = "value" in element ? String((element as HTMLInputElement).value) : "";
        if (value.includes(canary) && !isProtected(element)) return false;
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const textNode = walker.currentNode;
        const parent = textNode.parentElement;
        if (parent !== null && (textNode.textContent ?? "").includes(canary) && !isProtected(parent)) return false;
      }
      return true;
    },
    { canary: policy.canary, maskSelectors: policy.maskSelectors, blockSelectors: policy.blockSelectors },
  );
  if (!screenshotCanaryCovered) {
    findings.push("privacy.canary-detected");
    failedComponents.add("screenshot");
  }
  const viewport = page.viewportSize();
  if (viewport === null || !verifyScreenshotMaskRegions(screenshotBytes, maskRegions, viewport, policy.maskColor)) {
    findings.push("privacy.screenshot-mask-invalid");
    failedComponents.add("screenshot");
  }
  if (findings.length > 0) {
    rrwebBytes.fill(0);
    screenshotBytes.fill(0);
    return {
      status: "quarantined",
      receipt: createQuarantineReceipt({
        reasonCodes: findings,
        failedComponents: [...failedComponents],
        checkedAt: input.checkedAt,
      }),
    };
  }
  const receipt: PrivacyPassReceipt = {
    status: "passed",
    policyRevision: PRIVACY_POLICY_REVISION,
    rrwebDigest: digest(rrwebBytes),
    rrwebSize: rrwebBytes.byteLength,
    screenshotDigest: digest(screenshotBytes),
    screenshotSize: screenshotBytes.byteLength,
    checkedAt: input.checkedAt,
  };
  return { status: "passed", evidence: { rrwebBytes, screenshotBytes, receipt } };
}
