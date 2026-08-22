import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRIVACY_CANARY,
  collectPrivacyClearedEvidence,
  createRrwebPrivacyOptions,
  preparePrivacyRecorder,
  startPrivacyRecording,
  verifyRrwebPayload,
  verifyScreenshotMaskRegions,
  type PrivacyCapturePolicy,
} from "./privacy-capture.js";

const PATH = "/fixture/save-point";
let server: Server;
let origin: string;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

function html({ frame = false, leak = false }: { frame?: boolean; leak?: boolean } = {}): string {
  return `<!doctype html><html><head><script>document.documentElement.dataset.privacyRecorderReady=String(Boolean(window.__REMO_PRIVACY_RRWEB_READY__))</script></head><body>
    <main data-remo-fixture-root><h1>Candidate fixture</h1><p class="mask">${leak ? "safe" : PRIVACY_CANARY}</p>${leak ? `<p class="leak">${PRIVACY_CANARY}</p>` : ""}<input aria-label="secret" value="${PRIVACY_CANARY}"><button>Settle</button></main>
    <aside data-remo-block>${leak ? PRIVACY_CANARY : "blocked content"}</aside>${frame ? "<iframe srcdoc='<p>frame</p>'></iframe>" : ""}
  </body></html>`;
}

function policy(overrides: Partial<PrivacyCapturePolicy> = {}): PrivacyCapturePolicy {
  return {
    allowedOrigin: origin,
    allowedPath: PATH,
    captureRoot: "[data-remo-fixture-root]",
    maskSelectors: [".mask", "input"],
    blockSelectors: ["[data-remo-block]"],
    forbiddenFields: ["clipboardData", "dataTransfer", "files", "rawKey"],
    canary: PRIVACY_CANARY,
    maskColor: "#7138d8",
    ...overrides,
  };
}

async function open(content: string, configuredPolicy = policy()): Promise<Page> {
  server.removeAllListeners("request");
  server.on("request", (_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(content); });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 640, height: 480 } });
  await preparePrivacyRecorder(context, configuredPolicy);
  page = await context.newPage();
  await page.goto(`${origin}${PATH}`, { waitUntil: "domcontentloaded" });
  return page;
}

beforeEach(async () => {
  server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server missing address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await context?.close();
  await browser?.close();
  context = undefined;
  browser = undefined;
  page = undefined;
  server.close();
  await once(server, "close");
});

describe("buffer-only privacy capture", () => {
  it("injects rrweb before page scripts and configures mask/block behavior without upload or canvas/frame capture", async () => {
    const configured = policy();
    const target = await open(html(), configured);
    expect(await target.evaluate(() => document.documentElement.dataset.privacyRecorderReady)).toBe("true");
    expect(createRrwebPrivacyOptions(configured)).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: ".mask, input",
      recordCanvas: false,
      recordCrossOriginIframes: false,
      inlineImages: false,
      slimDOMOptions: "all",
    });
  });

  it("masks the seeded canary in rrweb and screenshot bytes before hashing safe buffers", async () => {
    const configured = policy();
    const target = await open(html(), configured);
    await startPrivacyRecording(target, configured);
    await target.getByRole("button", { name: "Settle" }).click();
    const result = await collectPrivacyClearedEvidence({ page: target, policy: configured, checkedAt: "2026-08-16T07:30:00.000Z" });
    expect(result.status).toBe("passed");
    if (result.status !== "passed") throw new Error("expected passing privacy fixture");
    expect(result.evidence.rrwebBytes.toString("utf8")).not.toContain(PRIVACY_CANARY);
    expect(result.evidence.screenshotBytes.includes(Buffer.from(PRIVACY_CANARY))).toBe(false);
    expect(result.evidence.receipt.rrwebDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.evidence.receipt.screenshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("quarantines a canary leak with metadata only", async () => {
    const configured = policy({ maskSelectors: ["input"] });
    const target = await open(html({ leak: true }), configured);
    await startPrivacyRecording(target, configured);
    const result = await collectPrivacyClearedEvidence({ page: target, policy: configured, checkedAt: "2026-08-16T07:31:00.000Z" });
    expect(result).toEqual({
      status: "quarantined",
      receipt: {
        status: "quarantined",
        policyRevision: "remo.privacy.v1",
        reasonCodes: ["privacy.canary-detected"],
        failedComponents: ["rrweb", "screenshot"],
        checkedAt: "2026-08-16T07:31:00.000Z",
      },
    });
    expect(JSON.stringify(result)).not.toContain(PRIVACY_CANARY);
    expect(JSON.stringify(result)).not.toContain("rrwebBytes");
    expect(JSON.stringify(result)).not.toContain("screenshotBytes");
  });

  it("rejects forbidden rrweb fields deterministically", () => {
    expect(verifyRrwebPayload([{ type: 3, data: { clipboardData: "not retained" } }], policy())).toEqual(["privacy.forbidden-field"]);
  });

  it("rejects unexpected rrweb origin and frame evidence before hashing", () => {
    expect(verifyRrwebPayload([{ type: 4, data: { href: "https://outside.invalid/" } }], policy())).toEqual(["privacy.origin-mismatch"]);
    expect(verifyRrwebPayload([{ type: 2, data: { node: { tagName: "iframe" } } }], policy())).toEqual(["privacy.frame-scope"]);
  });

  it("fails selector, origin, and frame preflight before recording starts", async () => {
    const configured = policy();
    const target = await open(html({ frame: true }), configured);
    await expect(startPrivacyRecording(target, configured)).rejects.toMatchObject({ reasonCode: "privacy.frame-scope" });
    await target.locator("iframe").evaluate((frame) => frame.remove());
    await expect(startPrivacyRecording(target, { ...configured, allowedOrigin: "http://127.0.0.1:9" })).rejects.toMatchObject({ reasonCode: "privacy.origin-mismatch" });
    await expect(startPrivacyRecording(target, { ...configured, maskSelectors: [".missing"] })).rejects.toMatchObject({ reasonCode: "privacy.selector-missing" });
  });

  it("verifies actual mask-color pixels for every required screenshot region", () => {
    const png = new PNG({ width: 4, height: 4, colorType: 6 });
    png.data.fill(255);
    for (let y = 1; y < 3; y += 1) for (let x = 1; x < 3; x += 1) {
      const offset = (4 * y + x) * 4;
      png.data[offset] = 0x71; png.data[offset + 1] = 0x38; png.data[offset + 2] = 0xd8; png.data[offset + 3] = 255;
    }
    const bytes = PNG.sync.write(png);
    expect(verifyScreenshotMaskRegions(bytes, [{ selector: ".mask", x: 0, y: 0, width: 4, height: 4 }], { width: 4, height: 4 }, "#7138d8")).toBe(true);
    expect(verifyScreenshotMaskRegions(bytes, [{ selector: ".mask", x: 0, y: 0, width: 4, height: 4 }], { width: 4, height: 4 }, "#000000")).toBe(false);
  });
});
