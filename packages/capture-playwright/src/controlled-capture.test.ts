import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startControlledCapture, type ControlledCaptureSession } from "./index.js";

const EXACT_PATH = "/fixture/save-point";
const ROOT = "[data-remo-fixture-root]";
let server: Server;
let origin: string;
let session: ControlledCaptureSession | undefined;

beforeEach(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === EXACT_PATH || request.url === "/fixture/ambiguous") {
      const extraRoot = request.url === "/fixture/ambiguous" ? "<main data-remo-fixture-root></main>" : "";
      response.end(`<!doctype html><html><head><script>
        document.documentElement.dataset.recorderWasReady = String(Boolean(window.__REMO_BOUNDED_RECORDER__));
        document.documentElement.dataset.captureViewport = innerWidth + "x" + innerHeight;
      </script></head><body><main data-remo-fixture-root>
        <button id="navigate" onclick="location.href='/outside'">Navigate</button>
        <button id="popup" onclick="window.open('/popup')">Popup</button>
        <button id="frame" onclick="document.body.append(document.createElement('iframe'))">Frame</button>
      </main>${extraRoot}</body></html>`);
      return;
    }
    response.end("<!doctype html><title>outside</title><p>outside</p>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await session?.stop("test-cleanup");
  session = undefined;
  server.close();
  await once(server, "close");
});

function config() {
  return { origin, path: EXACT_PATH, captureRoot: ROOT, launchOptions: { headless: true } } as const;
}

describe("controlled Playwright capture", () => {
  it("uses a fresh context and installs the bounded recorder before page scripts", async () => {
    session = await startControlledCapture(config());
    expect(session.state()).toMatchObject({ status: "recording", url: `${origin}${EXACT_PATH}` });
    expect(await session.readPageMarker("recorderWasReady")).toBe("true");
    expect(await session.captureRootCount()).toBe(1);
  });

  it("uses the requested capture viewport in the same controlled context", async () => {
    session = await startControlledCapture({ ...config(), viewport: { width: 390, height: 844 } });
    expect(await session.readPageMarker("captureViewport")).toBe("390x844");
  });

  it.each([
    ["navigation", "#navigate", "browser.navigation"],
    ["popup", "#popup", "browser.popup"],
    ["frame", "#frame", "browser.frame"],
  ])("fails closed and stops on %s", async (_name, selector, reasonCode) => {
    session = await startControlledCapture(config());
    await session.clickWithinRoot(selector);
    const violation = await session.waitForViolation();
    expect(violation.reasonCode).toBe(reasonCode);
    expect(session.state().status).toBe("failed");
  });

  it("rejects a missing or ambiguous exact root", async () => {
    await expect(startControlledCapture({ ...config(), captureRoot: "#missing" })).rejects.toMatchObject({
      reasonCode: "browser.root-missing",
    });
    await expect(startControlledCapture({ ...config(), path: "/fixture/ambiguous" })).rejects.toMatchObject({
      reasonCode: "browser.root-ambiguous",
    });
  });

  it("rejects non-exact loopback origins and widened paths before launch", async () => {
    await expect(startControlledCapture({ ...config(), origin: origin.replace("127.0.0.1", "localhost") })).rejects.toMatchObject({
      reasonCode: "browser.origin-mismatch",
    });
    await expect(startControlledCapture({ ...config(), path: `${EXACT_PATH}?widened=true` })).rejects.toMatchObject({
      reasonCode: "browser.path-mismatch",
    });
  });

  it("stops immediately and idempotently", async () => {
    session = await startControlledCapture(config());
    await session.stop("user");
    await session.stop("user");
    expect(session.state()).toMatchObject({ status: "stopped", stopReason: "user" });
  });
});
