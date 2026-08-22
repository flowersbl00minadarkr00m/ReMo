import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { describe, expect, it } from "vitest";

import * as verifierContract from "./verify-t5-contract.mjs";

const {
  EXPECTED_CORRECTIVE_PREVIEW_ORIGIN,
  EXPECTED_PRODUCTION_ORIGIN,
  createResourceInventoryAudit,
  expectedResourceInventory,
} = verifierContract;

const repositoryRoot = resolve(import.meta.dirname, "../../../../../..");
const STALE_CORRECTIVE_PREVIEW_ORIGIN = "https://remo-demo-459v94uav-hflowers45-9370s-projects.vercel.app";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const VERCEL_SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'self'; img-src 'self' data: blob:; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
};

describe("REL-001 T5 exact deployed-resource inventory", () => {
  it("accepts only the exact production, accepted preview, and IPv4 loopback origins", () => {
    const previewInventory = expectedResourceInventory(EXPECTED_CORRECTIVE_PREVIEW_ORIGIN);
    const productionInventory = expectedResourceInventory(EXPECTED_PRODUCTION_ORIGIN);
    expect(EXPECTED_CORRECTIVE_PREVIEW_ORIGIN).toBe("https://remo-demo-8nk98t4pd-hflowers45-9370s-projects.vercel.app");
    expect(EXPECTED_PRODUCTION_ORIGIN).toBe("https://remo-demo.vercel.app");
    expect(productionInventory.size).toBe(18);
    expect([...productionInventory]).toEqual([...previewInventory]);

    const localInventory = expectedResourceInventory("http://127.0.0.1:4192");
    expect(localInventory.size).toBe(18);
    expect(localInventory.get("/assets/application-N2U_zzB7.js")?.contentType).toBe("text/javascript");

    for (const origin of [
      "https://unknown.example",
      STALE_CORRECTIVE_PREVIEW_ORIGIN,
      "https://remo-demo.vercel.app.evil.invalid",
      "https://sub.remo-demo.vercel.app",
      "http://localhost:4192",
      "http://[::1]:4192",
      "http://127.0.0.2:4192",
    ]) {
      expect(() => expectedResourceInventory(origin), origin).toThrow(/no exact REL-001 resource inventory is approved/iu);
    }
  });

  it("enforces identical strict security and cache headers on both exact Vercel origins", () => {
    const body = Buffer.from("bound");
    const inventory = new Map([
      ["/", { status: 200, contentType: "text/html", sha256: digest(body), navigationRole: "top-document" }],
      ["/assets/bound.js", { status: 200, contentType: "application/javascript", sha256: digest(body) }],
    ]);

    for (const origin of [EXPECTED_CORRECTIVE_PREVIEW_ORIGIN, EXPECTED_PRODUCTION_ORIGIN]) {
      const audit = createResourceInventoryAudit(origin, inventory);
      audit.record({
        method: "GET",
        url: `${origin}/`,
        status: 200,
        contentType: "text/html; charset=utf-8",
        body,
        headers: { ...VERCEL_SECURITY_HEADERS, "cache-control": "public, max-age=0, must-revalidate" },
        navigationRole: "top-document",
      });
      audit.record({
        method: "GET",
        url: `${origin}/assets/bound.js`,
        status: 200,
        contentType: "application/javascript",
        body,
        headers: { ...VERCEL_SECURITY_HEADERS, "cache-control": "public, max-age=31536000, immutable" },
      });
      expect(audit.complete()).toHaveLength(2);

      expect(() => createResourceInventoryAudit(origin, inventory).record({
        method: "GET",
        url: `${origin}/assets/bound.js`,
        status: 200,
        contentType: "application/javascript",
        body,
        headers: { ...VERCEL_SECURITY_HEADERS, "cache-control": "public, max-age=0, must-revalidate" },
      })).toThrow(/wrong cache-control header/iu);

      expect(() => createResourceInventoryAudit(origin, inventory).record({
        method: "GET",
        url: `${origin}/assets/bound.js`,
        status: 200,
        contentType: "application/javascript",
        body,
        headers: {
          ...VERCEL_SECURITY_HEADERS,
          "content-security-policy": undefined,
          "cache-control": "public, max-age=31536000, immutable",
        },
      })).toThrow(/wrong content-security-policy header/iu);
    }
  });

  it("binds every accepted deployable path to status, content type, and exact response bytes", () => {
    const inventory = expectedResourceInventory(EXPECTED_CORRECTIVE_PREVIEW_ORIGIN);
    expect([...inventory.keys()]).toEqual([
      "/",
      "/save-points",
      "/replay",
      "/replay/demo-save-04",
      "/replay/demo-save-99",
      "/replay/demo-save-04?compareLeft=demo-save-04&compareRight=demo-save-05",
      "/compare",
      "/demo-replay.html",
      "/assets/application-B12CgZRu.css",
      "/assets/application-N2U_zzB7.js",
      "/assets/demoReplay-2QmAT-p-.css",
      "/assets/demoReplay-CeUOB01f.js",
      "/assets/hosted-demo-media-D7hqcseS.js",
      "/hosted-demo/fixture-manifest.json",
      "/hosted-demo/fixture.json",
      "/hosted-demo/turn-4-rrweb.json",
      "/hosted-demo/turn-4-screenshot.png",
      "/hosted-demo/turn-5-screenshot.png",
    ]);
    for (const expected of inventory.values()) {
      expect(expected.status).toBe(200);
      expect(expected.contentType).toMatch(/^(?:application\/javascript|application\/json|image\/png|text\/css|text\/html)$/u);
      expect(expected.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("rejects the stale deployment inventory and accepts the new exact 18-resource authority", () => {
    const inventory = expectedResourceInventory(EXPECTED_PRODUCTION_ORIGIN);
    expect(inventory.size).toBe(18);
    expect([...inventory.keys()]).not.toContain("/assets/application-CqmioDjg.js");
    expect([...inventory.keys()]).not.toContain("/assets/demoReplay-CmxrC1ms.js");
    expect([...inventory.keys()]).not.toContain("/assets/hosted-demo-media-BJvlJa6V.js");
    expect(inventory.get("/")?.sha256).toBe("592dc9fef3db239294540f06c124affd0194f303103843f5952b7e2ccf4333d1");
    expect(inventory.get("/demo-replay.html")?.sha256).toBe("83f2124dd13ec469398b6737d69d79670a27eee5d375be6d72e190b5f7616297");
    expect(inventory.get("/assets/application-N2U_zzB7.js")?.sha256).toBe("ae45fe384cef2f165dd5fa3d50c9f006194d132b2217403590f584a68c43c378");
    expect(inventory.get("/assets/demoReplay-CeUOB01f.js")?.sha256).toBe("c975ebeddc131a9e930232ea8807f26c25a4c849def4ee8d6f1f1288a487c45c");
    expect(inventory.get("/assets/hosted-demo-media-D7hqcseS.js")?.sha256).toBe("b2ebafb008dfa1697ca3ef58fdd7105a8bf94c178dfc0aee6a1dbb8a8c286b7b");

    const audit = createResourceInventoryAudit(EXPECTED_PRODUCTION_ORIGIN, inventory);
    expect(() => audit.record({
      method: "GET",
      url: `${EXPECTED_PRODUCTION_ORIGIN}/assets/application-CqmioDjg.js`,
      status: 200,
      contentType: "application/javascript",
      body: Buffer.from("stale deployment asset"),
      headers: { ...VERCEL_SECURITY_HEADERS, "cache-control": "public, max-age=31536000, immutable" },
    })).toThrow(/unmanifested deployable resource/iu);
  });

  it("binds every HTML response to candidate bytes and rejects synthetic HTML fetch context", () => {
    const inventory = expectedResourceInventory(EXPECTED_CORRECTIVE_PREVIEW_ORIGIN);
    const html = [...inventory.entries()].filter(([, expected]) => expected.contentType === "text/html");
    expect(html.map(([path]) => path)).toEqual([
      "/",
      "/save-points",
      "/replay",
      "/replay/demo-save-04",
      "/replay/demo-save-99",
      "/replay/demo-save-04?compareLeft=demo-save-04&compareRight=demo-save-05",
      "/compare",
      "/demo-replay.html",
    ]);
    expect(html.slice(0, -1).every(([, expected]) => expected.sha256 === "592dc9fef3db239294540f06c124affd0194f303103843f5952b7e2ccf4333d1")).toBe(true);
    expect(html.at(-1)?.[1].sha256).toBe("83f2124dd13ec469398b6737d69d79670a27eee5d375be6d72e190b5f7616297");

    const audit = createResourceInventoryAudit(EXPECTED_CORRECTIVE_PREVIEW_ORIGIN, new Map([["/", html[0][1]]]));
    expect(() => audit.record({
      method: "GET",
      url: `${EXPECTED_CORRECTIVE_PREVIEW_ORIGIN}/`,
      status: 200,
      contentType: "text/html",
      body: Buffer.from("candidate"),
      navigationRole: undefined,
    })).toThrow(/natural top-document navigation/iu);

    const coverageInventory = new Map([
      ["/", { status: 200, contentType: "text/html", sha256: digest("index"), navigationRole: "top-document" }],
      ["/save-points", { status: 200, contentType: "text/html", sha256: digest("index"), navigationRole: "top-document" }],
    ]);
    const coverageAudit = createResourceInventoryAudit("http://127.0.0.1:4192", coverageInventory);
    coverageAudit.record({ method: "GET", url: "http://127.0.0.1:4192/", status: 200, contentType: "text/html", body: Buffer.from("index"), navigationRole: "top-document" });
    expect(coverageAudit.complete).toThrow(/save-points/iu);
  });

  it("fails unmanifested, wrong-status, wrong-content-type, mismatched, duplicate-conflicting, and missing resources", () => {
    const origin = "http://127.0.0.1:4192";
    const inventory = new Map([["/bound.js", { status: 200, contentType: "application/javascript", sha256: digest("expected") }]]);
    const audit = createResourceInventoryAudit(origin, inventory);

    expect(() => audit.record({ method: "GET", url: `${origin}/other.js`, status: 200, contentType: "application/javascript", body: Buffer.from("expected") })).toThrow(/unmanifested/iu);
    expect(() => audit.record({ method: "GET", url: `${origin}/bound.js`, status: 404, contentType: "application/javascript", body: Buffer.from("expected") })).toThrow(/wrong status/iu);
    expect(() => audit.record({ method: "GET", url: `${origin}/bound.js`, status: 200, contentType: "text/plain", body: Buffer.from("expected") })).toThrow(/wrong content type/iu);
    expect(() => audit.record({ method: "GET", url: `${origin}/bound.js`, status: 200, contentType: "application/javascript", body: Buffer.from("wrong") })).toThrow(/digest mismatch/iu);

    audit.record({ method: "GET", url: `${origin}/bound.js`, status: 200, contentType: "application/javascript; charset=utf-8", body: Buffer.from("expected") });
    expect(audit.record({ method: "GET", url: `${origin}/bound.js`, status: 304, contentType: "", body: Buffer.alloc(0) })).toMatchObject({ kind: "revalidation", revalidatedSha256: digest("expected") });
    expect(() => audit.record({ method: "GET", url: `${origin}/bound.js`, status: 200, contentType: "application/javascript", body: Buffer.from("different") })).toThrow(/duplicate-conflicting/iu);
    expect(createResourceInventoryAudit(origin, inventory).complete).toThrow(/missing/iu);
    expect(() => createResourceInventoryAudit(origin, inventory).record({ method: "GET", url: `${origin}/bound.js`, status: 304, contentType: "", body: Buffer.alloc(0) })).toThrow(/unbound 304/iu);
  });

  it("allows only origin-bound blob responses outside the deployable inventory", () => {
    const origin = "http://127.0.0.1:4192";
    const audit = createResourceInventoryAudit(origin, new Map());
    expect(audit.record({ method: "GET", url: `blob:${origin}/1234`, status: 200, contentType: "image/png", body: Buffer.from("blob") }).kind).toBe("blob");
    expect(() => audit.record({ method: "GET", url: "blob:https://other.invalid/1234", status: 200, contentType: "image/png", body: Buffer.from("blob") })).toThrow(/unexpected blob origin/iu);
    expect(() => audit.record({ method: "GET", url: "data:text/plain,hello", status: 200, contentType: "text/plain", body: Buffer.from("hello") })).toThrow(/unexpected protocol/iu);
  });
});

describe("REL-001 T5 initial replay settlement ordering", () => {
  it("does not let a never-settling generic parent networkidle signal block an explicitly settled request ledger", async () => {
    const order = [];
    const neverSettles = (label) => new Promise(() => { order.push(label); });
    const page = {
      getByTitle: () => ({ waitFor: async () => { order.push("iframe-visible"); } }),
      waitForFunction: async () => { order.push("exact-same-origin-path"); },
      locator: () => ({
        getByText: () => ({ waitFor: async () => { order.push("replay-paused"); } }),
      }),
      getByRole: () => ({
        waitFor: async () => { order.push("start-visible"); },
        isDisabled: async () => false,
      }),
      waitForLoadState: async () => neverSettles("initial-parent-networkidle"),
    };
    let timeout;

    try {
      await expect(Promise.race([
        verifierContract.waitForStableRequestQuiescence({
          waitForSelectedEvidence: async () => { order.push("selected-evidence"); },
          replayIsPresent: async () => true,
          waitForReplayReady: async () => verifierContract.waitForInitialReplaySettlement(page),
          drainResponses: async () => { order.push("response-drain"); },
          observeBoundary: async () => { order.push("quiescence-boundary"); },
          activityVersion: () => 0,
          pendingCount: () => 0,
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("stale generic parent networkidle blocked explicit settlement")), 50);
        }),
      ])).resolves.toBeUndefined();
    } finally {
      clearTimeout(timeout);
    }

    expect(order).toEqual([
      "selected-evidence",
      "iframe-visible",
      "exact-same-origin-path",
      "replay-paused",
      "start-visible",
      "response-drain",
      "quiescence-boundary",
    ]);
  });

  it("settles the ready replay and its response bodies before the first verifier-driven selection", async () => {
    const verifier = await readFile(resolve(repositoryRoot, "apps/web/src/features/hosted-demo/verification/verify-t5.mjs"), "utf8");
    const ready = verifier.indexOf("await waitForInitialReplaySettlement(page);");
    const responses = verifier.indexOf("await settleRequestLifecycle();", ready);
    const selection = verifier.indexOf('await page.keyboard.press("End");');
    const endSettlement = verifier.indexOf("await settleCurrentRoute();", selection);
    const home = verifier.indexOf('await page.keyboard.press("Home");');
    const homeSettlement = verifier.indexOf("await settleCurrentRoute();", home);
    expect(ready).toBeGreaterThan(-1);
    expect(responses).toBeGreaterThan(ready);
    expect(selection).toBeGreaterThan(responses);
    expect(endSettlement).toBeGreaterThan(selection);
    expect(endSettlement).toBeLessThan(home);
    expect(homeSettlement).toBeGreaterThan(home);
    expect(verifier).not.toContain('url.pathname.startsWith("/assets/")');
    expect(verifier).not.toContain('url.pathname.startsWith("/hosted-demo/")');
  });

  it("uses natural navigation for every HTML route and probes only missing non-HTML resources", async () => {
    const verifier = await readFile(resolve(repositoryRoot, "apps/web/src/features/hosted-demo/verification/verify-t5.mjs"), "utf8");
    const contract = await readFile(resolve(repositoryRoot, "apps/web/src/features/hosted-demo/verification/verify-t5-contract.mjs"), "utf8");
    expect(contract).not.toContain("a45698c749eeefbf23462cdc0c560808140c34a15453db96a1decbacb3d61a7d");
    expect(contract).not.toContain("6ec216bb9763b9514caac97453c0848e250ff228f03fe98f10d08b3187af5052");
    expect(verifier).toContain('const directHtmlRoutes = ["/", "/save-points", "/replay"];');
    expect(verifier).toContain('expected.contentType !== "text/html" && !resourceAudit.seen.has(path)');
    expect(verifier).not.toContain("[...expectedInventory.keys()]");
    expect(verifier).not.toMatch(/fetch\([^)]*(?:demo-replay\.html|save-points|\/replay|\/compare)/u);
  });

  it("guards every top-document navigation until replay, response bodies, and network lifecycle settle", async () => {
    const verifier = await readFile(resolve(repositoryRoot, "apps/web/src/features/hosted-demo/verification/verify-t5.mjs"), "utf8");
    const helperStart = verifier.indexOf("async function navigateToHtmlRoute(path, ready)");
    const helperEnd = verifier.indexOf("async function followClientRoute", helperStart);
    const helper = verifier.slice(helperStart, helperEnd);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain("assert(activeRouteSettled, `Navigation left an unsettled route before ${path}.`);");
    expect(helper.indexOf("await settleCurrentRoute();")).toBeGreaterThan(helper.indexOf("await page.goto"));
    expect(verifier).toContain("await waitForInitialReplaySettlement(page);");
    expect(verifier).toContain("await settleRequestLifecycle();");
    expect(verifier).toContain("activeRouteSettled = true;");
    expect(verifier.match(/page\.goto\(/gu)).toHaveLength(1);
    expect(verifier).not.toContain('page.waitForLoadState("networkidle")');
  });

  it("keeps strict zero-pending ownership outside the route-quiescence drain callback", async () => {
    const verifier = await readFile(resolve(repositoryRoot, "apps/web/src/features/hosted-demo/verification/verify-t5.mjs"), "utf8");
    const drainStart = verifier.indexOf("async function drainRequestLifecycle()");
    const strictStart = verifier.indexOf("async function settleRequestLifecycle()");
    const routeStart = verifier.indexOf("async function settleCurrentRoute()");
    const routeEnd = verifier.indexOf("async function navigateToHtmlRoute", routeStart);
    const drain = verifier.slice(drainStart, strictStart);
    const strict = verifier.slice(strictStart, routeStart);
    const route = verifier.slice(routeStart, routeEnd);

    expect(drainStart).toBeGreaterThan(-1);
    expect(strictStart).toBeGreaterThan(drainStart);
    expect(routeStart).toBeGreaterThan(strictStart);
    expect(drain).toContain("await drainResponseSettlements();");
    expect(drain).toContain("integrityFailures.length === 0");
    expect(drain).not.toContain("requests.size === 0");
    expect(strict).toContain("await drainRequestLifecycle();");
    expect(strict).toContain("requests.size === 0");
    expect(route).toContain("drainResponses: async () => { await drainRequestLifecycle(); },");
    expect(route).not.toContain("settleRequestLifecycle");
  });
});

describe("REL-001 T5 same-document request quiescence", () => {
  it("cannot accept prior document networkidle before late Turn 4 media settles", async () => {
    expect(verifierContract.waitForStableRequestQuiescence).toBeTypeOf("function");
    if (typeof verifierContract.waitForStableRequestQuiescence !== "function") return;
    let activity = 0;
    let pending = 0;
    const order = ["prior-document-networkidle"];

    await verifierContract.waitForStableRequestQuiescence({
      waitForSelectedEvidence: async () => {
        order.push("selected-evidence");
        activity += 2;
        pending += 2;
      },
      replayIsPresent: async () => true,
      waitForReplayReady: async () => {
        order.push("replay-ready");
        activity += 2;
        pending -= 2;
      },
      drainResponses: async () => { order.push("drain"); },
      observeBoundary: async () => { order.push("observe"); },
      activityVersion: () => activity,
      pendingCount: () => pending,
    });

    expect(order.indexOf("selected-evidence")).toBeGreaterThan(order.indexOf("prior-document-networkidle"));
    expect(order.indexOf("replay-ready")).toBeGreaterThan(order.indexOf("selected-evidence"));
    expect(order.at(-1)).toBe("observe");
    expect(pending).toBe(0);
  });

  it("does not skip exact replay readiness when selected evidence mounts a replay", async () => {
    expect(verifierContract.waitForStableRequestQuiescence).toBeTypeOf("function");
    if (typeof verifierContract.waitForStableRequestQuiescence !== "function") return;
    let replayReady = false;

    await verifierContract.waitForStableRequestQuiescence({
      waitForSelectedEvidence: async () => undefined,
      replayIsPresent: async () => true,
      waitForReplayReady: async () => { replayReady = true; },
      drainResponses: async () => undefined,
      observeBoundary: async () => undefined,
      activityVersion: () => 0,
      pendingCount: () => 0,
    });

    expect(replayReady).toBe(true);
  });

  it("allows an initially pending request to settle on a later bounded pass", async () => {
    let activity = 4;
    let pending = 1;
    let drains = 0;
    let observations = 0;

    await verifierContract.waitForStableRequestQuiescence({
      waitForSelectedEvidence: async () => undefined,
      replayIsPresent: async () => false,
      waitForReplayReady: async () => { throw new Error("Replay readiness must not run without a replay."); },
      drainResponses: async () => { drains += 1; },
      observeBoundary: async () => {
        observations += 1;
        if (observations === 1) {
          activity += 1;
          pending = 0;
        }
      },
      activityVersion: () => activity,
      pendingCount: () => pending,
    });

    expect(drains).toBe(2);
    expect(observations).toBe(2);
    expect(pending).toBe(0);
  });

  it("observes and drains requests that begin during or after an apparent final drain", async () => {
    expect(verifierContract.waitForStableRequestQuiescence).toBeTypeOf("function");
    if (typeof verifierContract.waitForStableRequestQuiescence !== "function") return;
    let activity = 0;
    let pending = 0;
    let drains = 0;
    let observations = 0;

    await verifierContract.waitForStableRequestQuiescence({
      waitForSelectedEvidence: async () => undefined,
      replayIsPresent: async () => false,
      waitForReplayReady: async () => { throw new Error("Replay readiness must not run without a replay."); },
      drainResponses: async () => {
        drains += 1;
        if (drains === 1) {
          activity += 1;
          pending += 1;
        }
      },
      observeBoundary: async () => {
        observations += 1;
        if (observations === 1) {
          activity += 1;
          pending -= 1;
        }
      },
      activityVersion: () => activity,
      pendingCount: () => pending,
    });

    expect(drains).toBeGreaterThanOrEqual(2);
    expect(observations).toBeGreaterThanOrEqual(2);
    expect(pending).toBe(0);
  });

  it("fails closed with activity diagnostics when stable quiescence exhausts its pass budget", async () => {
    let activity = 7;
    let pending = 1;
    let observations = 0;

    await expect(verifierContract.waitForStableRequestQuiescence({
      waitForSelectedEvidence: async () => undefined,
      replayIsPresent: async () => false,
      waitForReplayReady: async () => { throw new Error("Replay readiness must not run without a replay."); },
      drainResponses: async () => undefined,
      observeBoundary: async () => {
        observations += 1;
        activity += 1;
        if (observations > 2) throw new Error("Unbounded quiescence test guard.");
      },
      activityVersion: () => activity,
      pendingCount: () => pending,
      maxPasses: 2,
    })).rejects.toThrow(/exhausted after 2 passes.*activity version 9.*pending count 1/iu);
    expect(observations).toBe(2);
    expect(pending).toBe(1);
  });

  it("fails closed when pending requests remain without new activity", async () => {
    await expect(verifierContract.waitForStableRequestQuiescence({
      waitForSelectedEvidence: async () => undefined,
      replayIsPresent: async () => false,
      waitForReplayReady: async () => { throw new Error("Replay readiness must not run without a replay."); },
      drainResponses: async () => undefined,
      observeBoundary: async () => undefined,
      activityVersion: () => 4,
      pendingCount: () => 1,
      maxPasses: 2,
    })).rejects.toThrow(/exhausted after 2 passes.*activity version 4.*pending count 1/iu);
  });

  it("fails closed when request activity never stabilizes despite zero pending requests", async () => {
    let activity = 0;

    await expect(verifierContract.waitForStableRequestQuiescence({
      waitForSelectedEvidence: async () => undefined,
      replayIsPresent: async () => false,
      waitForReplayReady: async () => { throw new Error("Replay readiness must not run without a replay."); },
      drainResponses: async () => undefined,
      observeBoundary: async () => { activity += 1; },
      activityVersion: () => activity,
      pendingCount: () => 0,
      maxPasses: 2,
    })).rejects.toThrow(/exhausted after 2 passes.*activity version 2.*pending count 0/iu);
  });

  it("propagates response-body drainage and integrity failures before accepting quiescence", async () => {
    for (const failure of [new Error("response body drainage failed"), new Error("resource integrity failed")]) {
      await expect(verifierContract.waitForStableRequestQuiescence({
        waitForSelectedEvidence: async () => undefined,
        replayIsPresent: async () => false,
        waitForReplayReady: async () => { throw new Error("Replay readiness must not run without a replay."); },
        drainResponses: async () => { throw failure; },
        observeBoundary: async () => undefined,
        activityVersion: () => 0,
        pendingCount: () => 0,
      })).rejects.toBe(failure);
    }
  });
});

describe("REL-001 T5 final request lifecycle", () => {
  it("recomputes teardown-boundary failures after close events and preserves primary-error precedence", async () => {
    expect(verifierContract.completeRequestLifecycle).toBeTypeOf("function");
    expect(verifierContract.deriveFinalRequestChannels).toBeTypeOf("function");
    expect(verifierContract.selectFinalVerificationError).toBeTypeOf("function");

    const requestLedger = [];
    const integrityFailures = [];
    const pendingRequests = [];
    let drains = 0;
    const result = await verifierContract.completeRequestLifecycle({
      drainResponses: async () => { drains += 1; },
      closePage: async () => {
        requestLedger.push({
          url: "http://127.0.0.1:4192/hosted-demo/turn-4-rrweb.json",
          method: "GET",
          status: undefined,
          failure: "net::ERR_FAILED",
        });
      },
      closeContext: async () => undefined,
      closeBrowser: async () => undefined,
      snapshotChannels: () => verifierContract.deriveFinalRequestChannels({
        expectedOrigin: "http://127.0.0.1:4192",
        requestLedger,
        integrityFailures,
        pendingRequests,
      }),
    });

    expect(drains).toBe(2);
    expect(result.channels.failedRequests).toHaveLength(1);
    expect(result.channels.unexpectedRequests).toHaveLength(0);
    expect(result.channels.integrityFailures).toHaveLength(0);
    expect(result.channels.pendingRequests).toHaveLength(0);
    expect(verifierContract.selectFinalVerificationError({
      primaryError: undefined,
      teardownError: result.teardownError,
      channels: result.channels,
    })).toMatchObject({ message: expect.stringMatching(/failed requests.*ERR_FAILED/iu) });

    const primaryError = new Error("primary journey failure");
    expect(verifierContract.selectFinalVerificationError({
      primaryError,
      teardownError: new Error("teardown failure"),
      channels: result.channels,
    })).toBe(primaryError);
  });

  it("includes unexpected, integrity, and pending channels in the final failure", () => {
    const channels = verifierContract.deriveFinalRequestChannels({
      expectedOrigin: "http://127.0.0.1:4192",
      requestLedger: [{ url: "https://unexpected.invalid/tracker.js", method: "GET", status: 200 }],
      integrityFailures: [{ url: "http://127.0.0.1:4192/bad.js", error: "digest mismatch" }],
      pendingRequests: [{ url: "http://127.0.0.1:4192/pending.js", method: "GET" }],
    });
    const error = verifierContract.selectFinalVerificationError({
      primaryError: undefined,
      teardownError: undefined,
      channels,
    });

    expect(channels.failedRequests).toHaveLength(0);
    expect(channels.unexpectedRequests).toHaveLength(1);
    expect(channels.integrityFailures).toHaveLength(1);
    expect(channels.pendingRequests).toHaveLength(1);
    expect(error).toMatchObject({
      message: expect.stringMatching(/unexpected request channels.*tracker\.js.*resource integrity failures.*digest mismatch.*pending requests.*pending\.js/iu),
    });
  });
});
