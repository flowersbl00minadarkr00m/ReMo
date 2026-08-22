import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import type { ComponentType, CorrelationTuple, EvidenceDescriptor, FinalizationInput } from "@remo/domain";
import { createContractLangfuseFake } from "@remo/evidence-langfuse";
import { createReconciliationService } from "../reconcile/reconciliation-service.js";
import { createSavePointApi, safeProjection } from "./save-point-api.js";
import { createInMemorySavePointStore } from "./save-point-service.js";

const TURN_ID = "01J000000000000000000000T6";
const SAVE_POINT_ID = "01J000000000000000000000S6";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "test-session-token-at-least-32-characters";
const SOURCE_COMMIT = "54474fd8d763cb9acaaa2e83b6df44df36fe7d92";
const authorityRoots = { source: { baseUrl: "https://github.com/example/remo", approvedHosts: ["github.com"] }, trace: { baseUrl: "https://traces.example.test", approvedHosts: ["traces.example.test"], projectId: "remo" } } as const;
const correlation: CorrelationTuple = { projectId: "remo", turnId: TURN_ID, captureWindowId: "window-t6", boundaryRevision: "boundary-v1" };
const componentTypes: readonly ComponentType[] = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"];

function finalization(): FinalizationInput {
  const evidence: EvidenceDescriptor[] = componentTypes.map((componentType) => ({
    componentId: `${TURN_ID}:${componentType}`,
    componentType,
    authority: componentType === "source" ? "git" : componentType === "trace" ? "langfuse" : componentType === "rrweb" ? "rrweb" : componentType === "verification" || componentType === "dependencies" ? "fixture" : "remo",
    correlation,
    capturedAt: "2026-08-16T10:00:00.000Z",
    digest: `sha256:${componentType}`,
    ...(componentType === "trace" ? { externalId: TRACE_ID, externalUrl: "javascript:must-not-cross", availability: "unreachable" as const } : { availability: "available" as const }),
    ...(componentType === "rrweb" || componentType === "screenshot" ? { blobRef: `blobs/sha256/safe-${componentType}` } : {}),
    provenance: componentType === "decision" ? "user-supplied" : "observed",
    policyRevision: "integrity-v3",
    claims: { sourceState: SOURCE_COMMIT, fixtureId: "vs001-fixture-v1" },
  }));
  return { schemaVersion: "remo.bundle.v1", identityVersion: "ulid-v1", policyRevision: "integrity-v3", savePointId: SAVE_POINT_ID, correlation, privacy: { status: "passed", reasonCodes: [] }, evidence };
}

async function fixtureServer() {
  const store = createInMemorySavePointStore();
  store.put({ finalization: finalization(), nominationReason: "Observed meaningful UI change.", retention: { promotedAt: "2026-08-16T10:05:00.000Z", expiresAt: "2026-09-15T10:05:00.000Z", pinned: false }, policyRevisions: { capture: "capture-v2", privacy: "privacy-v4", integrity: "integrity-v3", fidelity: "fidelity-v2", retention: "retention-v1" } });
  const lookup = createContractLangfuseFake({ [TRACE_ID]: { status: "matching", metadataTurnId: TURN_ID } });
  const reconciliation = createReconciliationService(store, lookup);
  let reconcileCalls = 0;
  const apiRef: { current?: ReturnType<typeof createSavePointApi> } = {};
  const server = createServer((request, response) => {
    if (apiRef.current === undefined) throw new Error("Save-point API fixture is not ready.");
    void apiRef.current.handle(request, response);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture server did not expose a port.");
  const origin = `http://127.0.0.1:${address.port}`;
  apiRef.current = createSavePointApi({ allowedOrigin: origin, store, reconcile: (savePointId, idempotencyKey) => { reconcileCalls += 1; return reconciliation.reconcile(savePointId, idempotencyKey); }, authorityRoots, sessionToken: TOKEN });
  return { origin, store, reconcileCalls: () => reconcileCalls, close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))) };
}

describe("stable save-point HTTP projection", () => {
  it("keeps local evidence inspectable during outage, then reconciles the same identity without exposing payloads", async () => {
    const fixture = await fixtureServer();
    try {
      const headers = { origin: fixture.origin, "x-remo-session-token": TOKEN };
      const beforeResponse = await fetch(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}`, { headers });
      const before = await beforeResponse.json() as Record<string, unknown>;
      expect(beforeResponse.status).toBe(200);
      expect(before).toMatchObject({ savePointId: SAVE_POINT_ID, turnId: TURN_ID, revision: 1, stablePath: `/save-points/${SAVE_POINT_ID}`, integrity: { state: "Incomplete" }, fidelity: { state: "Degraded" }, promotionAllowed: false });
      expect(JSON.stringify(before)).not.toMatch(/javascript:|credential|fullTracePayload|blobRef/u);
      expect((before.components as Array<{ type: string; externalUrl?: string; authorityMode?: string; policyCategory?: unknown }>).find(({ type }) => type === "source")).toMatchObject({ externalUrl: `https://github.com/example/remo/commit/${SOURCE_COMMIT}`, authorityMode: "fixture", policyCategory: { status: "available", category: "Integrity", revision: "integrity-v3" } });

      const reconciledResponse = await fetch(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}/reconcile`, { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "reconcile-t6-1" }, body: "{}" });
      const reconciled = await reconciledResponse.json() as Record<string, unknown>;
      expect(reconciled).toMatchObject({ savePointId: SAVE_POINT_ID, turnId: TURN_ID, revision: 2, integrity: { state: "Complete" }, fidelity: { state: "Editable eligible" }, promotionAllowed: true });
      expect((reconciled.components as Array<{ type: string; externalUrl?: string }>).find(({ type }) => type === "trace")?.externalUrl).toBe(`https://traces.example.test/project/remo/traces/${TRACE_ID}`);
      expect(fixture.store.count()).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("labels synthetic external authorities and exposes unknown policy categories as unavailable", async () => {
    const fixture = await fixtureServer();
    try {
      const initial = fixture.store.get(SAVE_POINT_ID);
      if (initial === undefined) throw new Error("fixture save point is missing");
      const source = initial.finalization.evidence.find(({ componentType }) => componentType === "source");
      const trace = initial.finalization.evidence.find(({ componentType }) => componentType === "trace");
      const projection = safeProjection(initial, authorityRoots);
      expect(projection.components.find(({ type }) => type === "source")).toMatchObject({ authorityMode: "fixture", externalUrl: `https://github.com/example/remo/commit/${SOURCE_COMMIT}` });
      expect(projection.components.find(({ type }) => type === "trace")).toMatchObject({ authorityMode: "fixture" });
      if (source === undefined || trace === undefined) throw new Error("fixture authorities are missing");
      const unknown = fixture.store.put({
        finalization: { ...initial.finalization, evidence: initial.finalization.evidence.map((descriptor) => descriptor.componentType === "source" ? { ...descriptor, policyRevision: "unknown.policy.v9" } : descriptor) },
        nominationReason: initial.nominationReason,
        retention: initial.retention,
        policyRevisions: initial.policyRevisions,
      });
      expect(safeProjection(unknown, authorityRoots).components.find(({ type }) => type === "source")?.policyCategory).toEqual({ status: "unavailable", category: "Unavailable", revision: "unknown.policy.v9" });

      const anomaly = fixture.store.put({
        finalization: initial.finalization,
        nominationReason: initial.nominationReason,
        retention: initial.retention,
        policyRevisions: { ...initial.policyRevisions, integrity: "remo.privacy.v1" },
      });
      expect(safeProjection(anomaly, authorityRoots).policyRevisions.Integrity).toEqual({ status: "unavailable", expectedCategory: "Integrity", reason: "category-mismatch", observedRevision: "remo.privacy.v1", actualCategory: "Privacy" });
    } finally {
      await fixture.close();
    }
  });

  it("rejects missing session authority and malformed reconcile keys", async () => {
    const fixture = await fixtureServer();
    try {
      expect((await fetch(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}`)).status).toBe(200);
      expect((await fetch(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}/reconcile`, { method: "POST", headers: { origin: fixture.origin, "content-type": "application/json", "idempotency-key": "missing-token" }, body: "{}" })).status).toBe(401);
      expect((await fetch(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}/reconcile`, { method: "POST", headers: { origin: fixture.origin, "x-remo-session-token": TOKEN, "content-type": "application/json", "idempotency-key": "bad;whoami" }, body: "{}" })).status).toBe(400);
      expect((await fetch(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}/reconcile`, { method: "POST", headers: { origin: fixture.origin, "x-remo-session-token": TOKEN, "content-type": "application/jsonp", "idempotency-key": "wrong-media-type" }, body: "{}" })).status).toBe(415);
      expect(fixture.reconcileCalls()).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["malformed JSON", "not-json", 400],
    ["an extra property", '{"unexpected":true}', 400],
    ["a non-object JSON value", "[]", 400],
    ["an oversized body", JSON.stringify({ padding: "x".repeat(2048) }), 413],
  ] as const)("rejects %s without invoking reconciliation", async (_label, body, status) => {
    const fixture = await fixtureServer();
    try {
      const response = await fetch(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}/reconcile`, {
        method: "POST",
        headers: { origin: fixture.origin, "x-remo-session-token": TOKEN, "content-type": "application/json", "idempotency-key": `body-${status}` },
        body,
      });
      expect(response.status).toBe(status);
      expect(fixture.reconcileCalls()).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("does not reconcile an aborted fixed-length body and remains available for a later valid request", async () => {
    const fixture = await fixtureServer();
    try {
      const url = new URL(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}/reconcile`);
      await new Promise<void>((resolve) => {
        const request = httpRequest({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { origin: fixture.origin, "x-remo-session-token": TOKEN, "content-type": "application/json", "idempotency-key": "aborted-body", "content-length": "20" },
        });
        request.on("error", () => resolve());
        request.on("close", () => resolve());
        request.write('{"partial":');
        setImmediate(() => request.destroy());
      });
      expect(fixture.reconcileCalls()).toBe(0);
      const valid = await fetch(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}/reconcile`, {
        method: "POST",
        headers: { origin: fixture.origin, "x-remo-session-token": TOKEN, "content-type": "application/json", "idempotency-key": "after-abort" },
        body: "{}",
      });
      expect(valid.status).toBe(200);
      expect(fixture.reconcileCalls()).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["case-normalized", { "TrAnSfEr-EnCoDiNg": "chunked" }],
    ["combined multi-value", { "Transfer-Encoding": "gzip, chunked" }],
  ] as const)("rejects a complete %s Transfer-Encoding body before reconciliation", async (_label, framingHeaders) => {
    const fixture = await fixtureServer();
    try {
      const url = new URL(`${fixture.origin}/api/save-points/${SAVE_POINT_ID}/reconcile`);
      const result = await new Promise<{ readonly status: number | undefined; readonly body: string }>((resolve, reject) => {
        const request = httpRequest({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { origin: fixture.origin, "x-remo-session-token": TOKEN, "content-type": "application/json", "idempotency-key": "complete-chunked", ...framingHeaders },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        });
        request.on("error", reject);
        request.end("{}");
      });
      expect(result).toEqual({ status: 400, body: '{"error":"save-point.transfer-encoding-rejected"}' });
      expect(fixture.reconcileCalls()).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("leaves conflicting Content-Length plus Transfer-Encoding rejection to Node before the API callback", async () => {
    const fixture = await fixtureServer();
    try {
      const url = new URL(fixture.origin);
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(url.port), url.hostname);
        const chunks: Buffer[] = [];
        socket.on("connect", () => socket.end([
          `POST /api/save-points/${SAVE_POINT_ID}/reconcile HTTP/1.1`,
          `Host: ${url.host}`,
          `Origin: ${fixture.origin}`,
          `X-ReMo-Session-Token: ${TOKEN}`,
          "Content-Type: application/json",
          "Idempotency-Key: conflicting-framing",
          "Content-Length: 2",
          "Transfer-Encoding: chunked",
          "Connection: close",
          "",
          "2",
          "{}",
          "0",
          "",
          "",
        ].join("\r\n")));
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.on("error", reject);
      });
      expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/u);
      expect(fixture.reconcileCalls()).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { source: { baseUrl: "https://user:secret@github.com/example/remo", approvedHosts: ["github.com"] }, trace: authorityRoots.trace },
    { source: { baseUrl: "javascript://github.com/example/remo", approvedHosts: ["github.com"] }, trace: authorityRoots.trace },
    { source: { baseUrl: "https://github.com.evil.test/example/remo", approvedHosts: ["github.com"] }, trace: authorityRoots.trace },
    { source: { baseUrl: "https://evil.test/example/remo", approvedHosts: ["github.com"] }, trace: authorityRoots.trace },
  ])("rejects unsafe or unapproved configured source authority roots", (roots) => {
    const store = createInMemorySavePointStore();
    const saved = store.put({ finalization: finalization(), nominationReason: "Observed meaningful UI change.", retention: { promotedAt: "2026-08-16T10:05:00.000Z", expiresAt: "2026-09-15T10:05:00.000Z", pinned: false }, policyRevisions: { capture: "capture-v2", privacy: "privacy-v4", integrity: "integrity-v3", fidelity: "fidelity-v2", retention: "retention-v1" } });
    expect(() => safeProjection(saved, roots)).toThrow(/credentials|HTTPS|approved/u);
  });
});
