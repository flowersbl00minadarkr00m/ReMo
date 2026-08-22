/* global document */

import { createHash } from "node:crypto";
import { URL } from "node:url";

export const EXPECTED_CORRECTIVE_PREVIEW_ORIGIN = "https://remo-demo-8nk98t4pd-hflowers45-9370s-projects.vercel.app";
export const EXPECTED_PRODUCTION_ORIGIN = "https://remo-demo.vercel.app";

const INDEX_SHA256 = "592dc9fef3db239294540f06c124affd0194f303103843f5952b7e2ccf4333d1";
const LOCAL_DEMO_REPLAY_SHA256 = "83f2124dd13ec469398b6737d69d79670a27eee5d375be6d72e190b5f7616297";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const VERCEL_SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'self'; img-src 'self' data: blob:; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
});

const INVENTORY_TEMPLATE = Object.freeze([
  ["/", "text/html", INDEX_SHA256],
  ["/save-points", "text/html", INDEX_SHA256],
  ["/replay", "text/html", INDEX_SHA256],
  ["/replay/demo-save-04", "text/html", INDEX_SHA256],
  ["/replay/demo-save-99", "text/html", INDEX_SHA256],
  ["/replay/demo-save-04?compareLeft=demo-save-04&compareRight=demo-save-05", "text/html", INDEX_SHA256],
  ["/compare", "text/html", INDEX_SHA256],
  ["/demo-replay.html", "text/html", LOCAL_DEMO_REPLAY_SHA256],
  ["/assets/application-B12CgZRu.css", "text/css", "5b2785f871d93ef108e4f0a5d4065affeaa76cc84a09f23315b083b6be9ba335"],
  ["/assets/application-N2U_zzB7.js", "application/javascript", "ae45fe384cef2f165dd5fa3d50c9f006194d132b2217403590f584a68c43c378"],
  ["/assets/demoReplay-2QmAT-p-.css", "text/css", "192d267581d7ac26adae6729badc07aa57161d541eae116be89c49afa1be3e3e"],
  ["/assets/demoReplay-CeUOB01f.js", "application/javascript", "c975ebeddc131a9e930232ea8807f26c25a4c849def4ee8d6f1f1288a487c45c"],
  ["/assets/hosted-demo-media-D7hqcseS.js", "application/javascript", "b2ebafb008dfa1697ca3ef58fdd7105a8bf94c178dfc0aee6a1dbb8a8c286b7b"],
  ["/hosted-demo/fixture-manifest.json", "application/json", "356dc951e99d6bcf98428d321ec7e517ba4bd53ed8aee25bf8713f7429614599"],
  ["/hosted-demo/fixture.json", "application/json", "ef63fef972b03da594ba87e54ecf415c560b20264adf726330e8f431cbe58c3d"],
  ["/hosted-demo/turn-4-rrweb.json", "application/json", "735d63d268b1c35c0c698b430d7ae94dbe1a91bc19d00df67aa5e452a4453487"],
  ["/hosted-demo/turn-4-screenshot.png", "image/png", "c253b4ce698d68b277d7e5019f007cb834e9f3de433132d1678c04914d82880a"],
  ["/hosted-demo/turn-5-screenshot.png", "image/png", "5a01bad950efb54e6c91c5c27c350cc82d1a31e977c032013fc090ec6cf869ae"],
]);

function isLocalVerificationOrigin(origin) {
  const url = new URL(origin);
  return url.protocol === "http:" && url.hostname === "127.0.0.1";
}

function isVercelVerificationOrigin(origin) {
  return origin === EXPECTED_CORRECTIVE_PREVIEW_ORIGIN || origin === EXPECTED_PRODUCTION_ORIGIN;
}

export function expectedResourceInventory(origin) {
  if (!isVercelVerificationOrigin(origin) && !isLocalVerificationOrigin(origin)) {
    throw new Error(`No exact REL-001 resource inventory is approved for origin ${origin}.`);
  }
  const inventory = new Map(INVENTORY_TEMPLATE.map(([path, contentType, sha256]) => [path, {
    status: 200,
    contentType,
    sha256,
    ...(contentType === "text/html" ? { navigationRole: path === "/demo-replay.html" ? "iframe" : "top-document" } : {}),
  }]));
  if (!isVercelVerificationOrigin(origin)) {
    for (const path of ["/assets/application-N2U_zzB7.js", "/assets/demoReplay-CeUOB01f.js", "/assets/hosted-demo-media-D7hqcseS.js"]) {
      inventory.set(path, { ...inventory.get(path), contentType: "text/javascript" });
    }
  }
  return inventory;
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function normalizedContentType(value) {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function createResourceInventoryAudit(expectedOrigin, inventory = expectedResourceInventory(expectedOrigin)) {
  const seen = new Map();
  const records = [];

  function record({ method, url: rawUrl, status, contentType, body, headers = {}, navigationRole }) {
    const url = new URL(rawUrl);
    const actualDigest = sha256(body);
    if (url.protocol === "blob:") {
      if (url.origin !== expectedOrigin) throw new Error(`Unexpected blob origin: ${url.origin}.`);
      const entry = { kind: "blob", url: rawUrl, method, status, contentType: normalizedContentType(contentType), bytes: body.byteLength, sha256: actualDigest };
      records.push(entry);
      return entry;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unexpected protocol: ${url.protocol}.`);
    if (url.origin !== expectedOrigin) throw new Error(`Unexpected request origin: ${url.origin}.`);
    if (method !== "GET") throw new Error(`Unexpected request method for ${rawUrl}: ${method}.`);
    const path = `${url.pathname}${url.search}`;
    const expected = inventory.get(path);
    if (expected === undefined) throw new Error(`Unmanifested deployable resource: ${path}.`);
    if (expected.contentType === "text/html" && navigationRole !== expected.navigationRole) {
      throw new Error(`HTML resource ${path} requires natural ${expected.navigationRole} navigation; received ${navigationRole ?? "synthetic fetch"}.`);
    }
    let verifiedHeaders;
    if (isVercelVerificationOrigin(expectedOrigin)) {
      const expectedHeaders = {
        ...VERCEL_SECURITY_HEADERS,
        "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
      };
      verifiedHeaders = {};
      for (const [name, value] of Object.entries(expectedHeaders)) {
        const actual = headers[name];
        if (actual !== value) throw new Error(`Wrong ${name} header for ${path}: expected ${value}, received ${actual ?? "missing"}.`);
        verifiedHeaders[name] = actual;
      }
    }
    const prior = seen.get(path);
    if (status === 304) {
      if (prior === undefined) throw new Error(`Unbound 304 revalidation for ${path}: no prior exact 200 body.`);
      if (actualDigest !== EMPTY_SHA256) throw new Error(`Non-empty 304 response body for ${path}: ${actualDigest}.`);
      const next = { kind: "revalidation", path, url: rawUrl, method, status, contentType: normalizedContentType(contentType), bytes: body.byteLength, sha256: actualDigest, revalidatedSha256: prior.sha256, count: prior.count + 1, ...(navigationRole === undefined ? {} : { navigationRole }), ...(verifiedHeaders === undefined ? {} : { verifiedHeaders }) };
      seen.set(path, { ...prior, count: next.count });
      records.push(next);
      return next;
    }
    if (status !== expected.status) throw new Error(`Wrong status for ${path}: expected ${expected.status}, received ${status}.`);
    const actualContentType = normalizedContentType(contentType);
    if (actualContentType !== expected.contentType) throw new Error(`Wrong content type for ${path}: expected ${expected.contentType}, received ${actualContentType || "missing"}.`);
    if (prior !== undefined && prior.sha256 !== actualDigest) throw new Error(`Duplicate-conflicting response body for ${path}: ${prior.sha256} then ${actualDigest}.`);
    if (actualDigest !== expected.sha256) throw new Error(`Digest mismatch for ${path}: expected ${expected.sha256}, received ${actualDigest}.`);
    const next = { kind: "deployable", path, url: rawUrl, method, status, contentType: actualContentType, bytes: body.byteLength, sha256: actualDigest, expectedSha256: expected.sha256, count: (prior?.count ?? 0) + 1, ...(navigationRole === undefined ? {} : { navigationRole }), ...(verifiedHeaders === undefined ? {} : { verifiedHeaders }) };
    seen.set(path, next);
    records.push(next);
    return next;
  }

  function complete() {
    const missing = [...inventory.keys()].filter((path) => !seen.has(path));
    if (missing.length > 0) throw new Error(`Missing expected deployable resources: ${JSON.stringify(missing)}.`);
    return [...seen.values()];
  }

  return { record, complete, inventory, records, seen };
}

function isExpectedRequestChannel(rawUrl, expectedOrigin) {
  if (typeof rawUrl !== "string") return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "blob:") return url.origin === expectedOrigin;
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function deriveFinalRequestChannels({
  expectedOrigin,
  requestLedger,
  integrityFailures,
  pendingRequests,
}) {
  return {
    failedRequests: requestLedger.filter(({ status, failure }) => failure !== undefined || status === undefined || status >= 400),
    unexpectedRequests: requestLedger.filter(({ url }) => !isExpectedRequestChannel(url, expectedOrigin)),
    integrityFailures: [...integrityFailures],
    pendingRequests: [...pendingRequests],
  };
}

export async function completeRequestLifecycle({
  drainResponses,
  closePage,
  closeContext,
  closeBrowser,
  snapshotChannels,
}) {
  let teardownError;
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      teardownError ??= error;
    }
  };

  await attempt(drainResponses);
  await attempt(closePage);
  await attempt(closeContext);
  await attempt(closeBrowser);
  await attempt(drainResponses);
  return { teardownError, channels: snapshotChannels() };
}

export function selectFinalVerificationError({ primaryError, teardownError, channels, verificationLabel = "T5" }) {
  if (primaryError !== undefined) return primaryError;
  const failures = [
    ...(teardownError === undefined ? [] : [`Teardown error: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}.`]),
    ...(channels.failedRequests.length === 0 ? [] : [`Failed requests: ${JSON.stringify(channels.failedRequests)}.`]),
    ...(channels.unexpectedRequests.length === 0 ? [] : [`Unexpected request channels: ${JSON.stringify(channels.unexpectedRequests)}.`]),
    ...(channels.integrityFailures.length === 0 ? [] : [`Resource integrity failures: ${JSON.stringify(channels.integrityFailures)}.`]),
    ...(channels.pendingRequests.length === 0 ? [] : [`Pending requests: ${JSON.stringify(channels.pendingRequests)}.`]),
  ];
  return failures.length === 0 ? undefined : new Error(`Final ${verificationLabel} verification failed. ${failures.join(" ")}`);
}

export async function waitForInitialReplaySettlement(page) {
  const iframe = page.getByTitle("Isolated same-origin synthetic replay");
  await iframe.waitFor();
  await page.waitForFunction(() => document.querySelector('iframe[title="Isolated same-origin synthetic replay"]')?.contentWindow?.location.pathname === "/demo-replay.html");
  await page.locator(".hosted-demo-replay .replay-state").getByText("Replay paused", { exact: true }).waitFor();
  const start = page.getByRole("button", { name: "Start replay" });
  await start.waitFor();
  if (await start.isDisabled()) throw new Error("Initial hosted replay controls remained disabled after runtime readiness.");
}

export async function waitForStableRequestQuiescence({
  waitForSelectedEvidence,
  replayIsPresent,
  waitForReplayReady,
  drainResponses,
  observeBoundary,
  activityVersion,
  pendingCount,
  maxPasses = 8,
}) {
  if (!Number.isInteger(maxPasses) || maxPasses < 1) throw new Error(`Invalid request-quiescence pass budget: ${maxPasses}.`);
  let finalActivityVersion = activityVersion();
  let finalPendingCount = pendingCount();
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    await waitForSelectedEvidence();
    if (await replayIsPresent()) await waitForReplayReady();
    const before = activityVersion();
    await drainResponses();
    await observeBoundary();
    finalActivityVersion = activityVersion();
    finalPendingCount = pendingCount();
    if (finalActivityVersion === before && finalPendingCount === 0) return;
  }
  throw new Error(`Request quiescence exhausted after ${maxPasses} passes: activity version ${finalActivityVersion}; pending count ${finalPendingCount}.`);
}
