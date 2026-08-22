import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentType, CorrelationTuple, EvidenceDescriptor } from "@remo/domain";
import { LocalSavePointRepository } from "@remo/storage-local";
import { confirmCandidateIntent, createCandidateReview } from "../candidates/candidate-service.js";
import { PromotionError, createPromotionService } from "./promotion-service.js";
import { createLocalPromotionRuntime } from "./promotion-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const turnId = "01J000000000000000000000T5";
const savePointId = "01J000000000000000000000S5";
const correlation: CorrelationTuple = { projectId: "remo", turnId, captureWindowId: "window-t5", boundaryRevision: "boundary-v1" };
const componentTypes: readonly ComponentType[] = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"];

function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function passingRecord(options: { readonly savePointId?: string; readonly sourceState?: string } = {}) {
  const rrwebBytes = Buffer.from("masked rrweb t5");
  const screenshotBytes = Buffer.from("masked screenshot t5");
  const evidence: EvidenceDescriptor[] = componentTypes.map((componentType) => ({
    componentId: `${turnId}:${componentType}`,
    componentType,
    authority: componentType === "source" ? "git" : componentType === "rrweb" ? "rrweb" : componentType === "trace" ? "langfuse" : "remo",
    correlation,
    capturedAt: "2026-08-16T07:30:00.000Z",
    digest: `sha256:${componentType}`,
    ...(componentType === "trace" ? { externalId: "0123456789abcdef0123456789abcdef" } : {}),
    availability: "available",
    provenance: componentType === "decision" ? "user-supplied" : "observed",
    policyRevision: "remo.privacy.v1",
    claims: { sourceState: options.sourceState ?? "tree-t5", fixtureId: "vs001-fixture" },
  }));
  return createCandidateReview({
    finalization: { schemaVersion: "remo.bundle.v1", identityVersion: "ulid-v1", policyRevision: "remo.privacy.v1", savePointId: options.savePointId ?? savePointId, correlation, evidence },
    nomination: { status: "candidate", categories: ["responsive"], boundaries: [{ kind: "verification", boundaryId: "fixture", occurredAt: "2026-08-16T07:30:00.000Z" }], reasonCodes: ["nomination.meaningful-change-with-boundary"] },
    privacyCapture: { status: "passed", evidence: { rrwebBytes, screenshotBytes, receipt: { status: "passed", policyRevision: "remo.privacy.v1", rrwebDigest: digest(rrwebBytes), rrwebSize: rrwebBytes.byteLength, screenshotDigest: digest(screenshotBytes), screenshotSize: screenshotBytes.byteLength, checkedAt: "2026-08-16T07:30:00.000Z" } } },
    createdAt: "2026-08-16T07:30:00.000Z",
  });
}

function confirmationBody(candidate = passingRecord()) {
  if (candidate.status !== "reviewable") throw new Error("fixture must be reviewable");
  return { confirm: true, savePointId: candidate.finalization.savePointId, candidateRevision: 1, candidateManifestDigest: candidate.manifestDigest } as const;
}

describe("promotion service", () => {
  it("assembles the real candidate lookup, explicit-confirmation handler, SQLite repository, CAS, and browser-safe response", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-promotion-runtime-t5-")); roots.push(root);
    const candidate = passingRecord();
    const runtime = createLocalPromotionRuntime({ projectRoot: root, allowedOrigin: "http://127.0.0.1:4174", now: () => new Date("2026-08-16T08:00:00.000Z"), findCandidate: (requestedTurn) => requestedTurn === turnId ? candidate : undefined });
    await expect(runtime.handle(turnId, { confirm: false })).resolves.toMatchObject({ status: 400, body: { status: "failed", code: "promotion.confirmation-required" } });
    const first = await runtime.handle(turnId, confirmationBody(candidate));
    const repeated = await runtime.handle(turnId, confirmationBody(candidate));
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ status: 200, body: { status: "durable", turnId, savePointId, pinned: false } });
    expect(runtime.repository.countDurable()).toBe(1);
    runtime.close();
  });

  it("exposes promotion only through exact loopback origin, JSON POST, and the process session token", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-promotion-api-t5-")); roots.push(root);
    const candidate = passingRecord();
    const allowedOrigin = "http://127.0.0.1:4174";
    const runtime = createLocalPromotionRuntime({ projectRoot: root, allowedOrigin, now: () => new Date("2026-08-16T08:00:00.000Z"), findCandidate: () => candidate });
    const server = createServer((request, response) => void runtime.api.handle(request, response));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing promotion address");
    const url = `http://127.0.0.1:${address.port}/api/candidates/${turnId}/promote`;
    try {
      const unauthorized = await fetch(url, { method: "POST", headers: { origin: allowedOrigin, "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      expect(unauthorized.status).toBe(401);
      const accepted = await fetch(url, { method: "POST", headers: { origin: allowedOrigin, "content-type": "application/json", "x-remo-session-token": runtime.api.sessionToken }, body: JSON.stringify(confirmationBody(candidate)) });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ status: "durable", turnId, savePointId });
      expect(accepted.headers.has("access-control-allow-origin")).toBe(false);
    } finally {
      server.close(); await once(server, "close"); runtime.close();
    }
  });

  it("joins canonical candidate intent to real SQLite/CAS and returns one browser-safe durable projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-promotion-t5-")); roots.push(root);
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z") });
    const service = createPromotionService(repository);
    const candidate = passingRecord();
    const intent = confirmCandidateIntent(candidate);
    const first = await service.promote(candidate, intent);
    const repeated = await service.promote(candidate, intent);
    expect(repeated).toEqual(first);
    expect(repository.countDurable()).toBe(1);
    expect(first).toMatchObject({ status: "durable", savePointId, turnId, pinned: false, promotedAt: "2026-08-16T08:00:00.000Z", expiresAt: "2026-09-15T08:00:00.000Z" });
    expect(JSON.stringify(first)).not.toContain("masked rrweb");
    repository.close();
  });

  it("rejects missing explicit intent and candidate/evaluator mismatch before writer access", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-promotion-t5-")); roots.push(root);
    const repository = new LocalSavePointRepository({ projectRoot: root });
    const service = createPromotionService(repository);
    const candidate = passingRecord();
    await expect(service.promote(candidate, { status: "blocked", reasonCodes: ["confirmation.required"] })).rejects.toBeInstanceOf(PromotionError);
    if (candidate.status !== "reviewable") throw new Error("fixture must be reviewable");
    const changed = { ...candidate, projection: { ...candidate.projection, canConfirm: false } };
    const ready = confirmCandidateIntent(candidate);
    await expect(service.promote(changed, ready)).rejects.toBeInstanceOf(PromotionError);
    expect(repository.countDurable()).toBe(0);
    repository.close();
  });

  it("rejects an A-rendered confirmation after same-turn candidate B replaces it without writer access", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-promotion-stale-t5-")); roots.push(root);
    const renderedA = passingRecord({ savePointId: "01J000000000000000000000A5", sourceState: "tree-a" });
    const currentB = passingRecord({ savePointId: "01J000000000000000000000B5", sourceState: "tree-b" });
    const runtime = createLocalPromotionRuntime({ projectRoot: root, allowedOrigin: "http://127.0.0.1:4174", findCandidate: () => currentB });
    const response = await runtime.handle(turnId, confirmationBody(renderedA));
    expect(response).toMatchObject({ status: 409, body: { code: "promotion.candidate-binding-stale", retryable: false } });
    expect(runtime.repository.countDurable()).toBe(0);
    runtime.close();
  });

  it("rejects any extra or missing confirmation JSON field", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-promotion-schema-t5-")); roots.push(root);
    const candidate = passingRecord();
    const runtime = createLocalPromotionRuntime({ projectRoot: root, allowedOrigin: "http://127.0.0.1:4174", findCandidate: () => candidate });
    await expect(runtime.handle(turnId, { ...confirmationBody(candidate), extra: true })).resolves.toMatchObject({ status: 400, body: { code: "promotion.invalid-confirmation-schema" } });
    await expect(runtime.handle(turnId, { confirm: true, savePointId, candidateRevision: 1 })).resolves.toMatchObject({ status: 400, body: { code: "promotion.invalid-confirmation-schema" } });
    expect(runtime.repository.countDurable()).toBe(0);
    runtime.close();
  });

  it("returns the same complete durable identity after restart with an empty candidate lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-promotion-restart-t5-")); roots.push(root);
    const candidate = passingRecord();
    const body = confirmationBody(candidate);
    const firstRuntime = createLocalPromotionRuntime({ projectRoot: root, allowedOrigin: "http://127.0.0.1:4174", findCandidate: () => candidate, crashPoint: "after-transaction-commit" });
    await expect(firstRuntime.handle(turnId, body)).resolves.toMatchObject({ status: 503 });
    firstRuntime.close();
    const restarted = createLocalPromotionRuntime({ projectRoot: root, allowedOrigin: "http://127.0.0.1:4174", findCandidate: () => undefined });
    const recovered = await restarted.handle(turnId, body);
    expect(recovered).toMatchObject({ status: 200, body: { status: "durable", turnId, savePointId, health: "complete" } });
    expect(restarted.repository.countDurable()).toBe(1);
    restarted.close();
  });

  it("rejects a mismatched binding on an existing durable retry without changing durable count", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-promotion-existing-binding-t5-")); roots.push(root);
    const candidate = passingRecord();
    const runtime = createLocalPromotionRuntime({ projectRoot: root, allowedOrigin: "http://127.0.0.1:4174", findCandidate: () => candidate });
    const body = confirmationBody(candidate);
    await expect(runtime.handle(turnId, body)).resolves.toMatchObject({ status: 200 });
    await expect(runtime.handle(turnId, { ...body, candidateManifestDigest: `sha256:${"f".repeat(64)}` })).resolves.toMatchObject({ status: 409, body: { code: "promotion.candidate-binding-stale", retryable: false } });
    expect(runtime.repository.countDurable()).toBe(1);
    runtime.close();
  });
});
