import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { evaluateBranchPreflight, deriveBranchPreflightIdentity, type BranchPreflightInput } from "@remo/domain";
import { createBranchPreflightApi } from "./branch-preflight-api.js";

const ID = "01J000000000000000000000S5";
const DIGEST = `sha256:${"b".repeat(64)}`;
function receipt() {
  const derived = deriveBranchPreflightIdentity(ID, 1);
  const available = { state: "available" as const };
  const input: BranchPreflightInput = { savePointId: ID, requestedSavePointId: ID, savePointRevision: 1, requestedSavePointRevision: 1, lifecycleState: "active", integrityState: "complete", fidelityState: "editable-eligible", privacyPassed: true, evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: DIGEST, evidenceDigest: DIGEST })), sourceCommit: "a".repeat(40), sourceCommitExists: true, repository: { gitAvailable: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true }, reproducibility: { route: "/fixture/save-point", expectedRoute: "/fixture/save-point", fixture: "fixture", expectedFixture: "fixture", viewport: "1440x900", expectedViewport: "1440x900", dependencyDigest: DIGEST, expectedDependencyDigest: DIGEST, policyDigest: DIGEST, expectedPolicyDigest: DIGEST }, target: { ...derived, refAbsent: true, pathAbsent: true }, operationActive: false, checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false }, originalLineageId: "lineage:original", originalFuture: { branchRef: "refs/heads/main", head: "a".repeat(40), statusDigest: DIGEST, indexDigest: DIGEST, approvedSourceDigest: DIGEST, availability: { status: available, index: available, approvedSource: available, capture: available } }, inspectorReasonCodes: [] };
  return evaluateBranchPreflight(input, new Date("2026-08-19T17:30:00.000Z"));
}

async function withApi(run: (origin: string) => Promise<void>): Promise<void> {
  const evaluate = vi.fn(() => Promise.resolve(receipt()));
  const api = createBranchPreflightApi({ allowedOrigin: "http://127.0.0.1", sessionToken: "session-token", evaluate });
  const server = createServer((request, response) => { if (!api.matches(request.url)) response.writeHead(404).end(); else void api.handle(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("listener unavailable");
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
}

describe("branch preflight API", () => {
  it("accepts only authenticated exact-origin POST and returns a no-store receipt", async () => withApi(async (origin) => {
    const response = await fetch(`${origin}/api/save-points/${ID}/branch-preflight`, { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": "session-token", "content-type": "application/json" }, body: JSON.stringify({ savePointRevision: 1 }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { readonly checks: readonly unknown[] };
    expect(body.checks).toHaveLength(10);
  }));

  it.each([
    ["wrong method", { method: "GET", headers: { origin: "http://127.0.0.1", "x-remo-session-token": "session-token" } }, 405],
    ["wrong origin", { method: "POST", headers: { origin: "http://localhost", "x-remo-session-token": "session-token", "content-type": "application/json" }, body: "{\"savePointRevision\":1}" }, 403],
    ["wrong token", { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": "wrong", "content-type": "application/json" }, body: "{\"savePointRevision\":1}" }, 403],
    ["wrong content", { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": "session-token", "content-type": "text/plain" }, body: "{}" }, 415],
    ["malformed binding", { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": "session-token", "content-type": "application/json" }, body: "{}" }, 400],
  ] as const)("fails closed for %s", async (_name, init, status) => withApi(async (origin) => expect((await fetch(`${origin}/api/save-points/${ID}/branch-preflight`, init)).status).toBe(status)));
});
