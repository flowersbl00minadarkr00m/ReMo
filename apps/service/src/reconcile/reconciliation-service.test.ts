import { describe, expect, it, vi } from "vitest";
import type { ComponentType, CorrelationTuple, EvidenceDescriptor, FinalizationInput } from "@remo/domain";
import { createInMemorySavePointStore } from "../save-points/save-point-service.js";
import { createReconciliationService, type TraceLookupResult } from "./reconciliation-service.js";

const TURN_ID = "01J000000000000000000000T6";
const SAVE_POINT_ID = "01J000000000000000000000S6";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const correlation: CorrelationTuple = { projectId: "remo", turnId: TURN_ID, captureWindowId: "window-t6", boundaryRevision: "boundary-v1" };
const types: readonly ComponentType[] = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"];

function input(traceAvailability: EvidenceDescriptor["availability"] = "unreachable", turnId = TURN_ID, savePointId = SAVE_POINT_ID): FinalizationInput {
  const identity = { ...correlation, turnId };
  return { schemaVersion: "remo.bundle.v1", identityVersion: "ulid-v1", policyRevision: "integrity-v3", savePointId, correlation: identity, privacy: { status: "passed", reasonCodes: [] }, evidence: types.map((componentType) => ({ componentId: `${turnId}:${componentType}`, componentType, authority: componentType === "source" ? "git" : componentType === "trace" ? "langfuse" : componentType === "rrweb" ? "rrweb" : componentType === "verification" || componentType === "dependencies" ? "fixture" : "remo", correlation: identity, capturedAt: "2026-08-16T10:00:00.000Z", digest: `sha256:${componentType}`, ...(componentType === "trace" ? { externalId: TRACE_ID, externalUrl: `https://traces.example.test/project/remo/traces/${TRACE_ID}`, availability: traceAvailability } : { availability: "available" as const }), provenance: componentType === "decision" ? "user-supplied" : "observed", policyRevision: "integrity-v3", claims: { sourceState: "tree-1", fixtureId: "vs001-fixture-v1" } })) };
}

function seed(finalization = input()) {
  return { finalization, nominationReason: "Responsive and accessibility verification passed.", retention: { promotedAt: "2026-08-16T10:05:00.000Z", expiresAt: "2026-09-15T10:05:00.000Z", pinned: false }, policyRevisions: { capture: "capture-v2", privacy: "privacy-v4", integrity: "integrity-v3", fidelity: "fidelity-v2", retention: "retention-v1" } } as const;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function setup(result: TraceLookupResult) {
  const store = createInMemorySavePointStore();
  store.put(seed());
  const requests: unknown[] = [];
  const service = createReconciliationService(store, { lookup: (request) => { requests.push(structuredClone(request)); return Promise.resolve(result); } });
  return { store, service, requests };
}

describe("same-identity trace reconciliation", () => {
  it.each([
    ["matching", { status: "matching", metadataTurnId: TURN_ID, validatedAt: "2026-08-16T10:06:00.000Z" }, "complete", "editable-eligible", true, 2],
    ["missing", { status: "missing", validatedAt: "2026-08-16T10:06:00.000Z" }, "incomplete", "degraded", false, 2],
    ["unreachable", { status: "unreachable", reasonCode: "trace.authority-unreachable", validatedAt: "2026-08-16T10:06:00.000Z" }, "incomplete", "degraded", false, 2],
    ["conflicting", { status: "conflicting", metadataTurnId: "01J000000000000000000000XX", validatedAt: "2026-08-16T10:06:00.000Z" }, "inconsistent", "historical-only", false, 2],
  ] as const)("handles %s authority without replacing local evidence or identity", async (_name, lookupResult, integrity, fidelity, promotionAllowed, revision) => {
    const { store, service, requests } = setup(lookupResult);
    const before = store.get(SAVE_POINT_ID)!;
    const localRefs = before.finalization.evidence.filter(({ componentType }) => componentType !== "trace");
    const decisionBefore = before.finalization.evidence.find(({ componentType }) => componentType === "decision");
    const result = await service.reconcile(SAVE_POINT_ID);
    expect(result.savePointId).toBe(SAVE_POINT_ID);
    expect(result.turnId).toBe(TURN_ID);
    expect(result.revision).toBe(revision);
    expect(result.integrity.state).toBe(integrity);
    expect(result.fidelity.state).toBe(fidelity);
    expect(result.promotionAllowed).toBe(promotionAllowed);
    expect(result.finalization.evidence.filter(({ componentType }) => componentType !== "trace")).toEqual(localRefs);
    expect(result.finalization.evidence.find(({ componentType }) => componentType === "decision")).toEqual(decisionBefore);
    expect(requests).toEqual([{ traceId: TRACE_ID, expectedTurnId: TURN_ID }]);
    expect(JSON.stringify(requests)).not.toMatch(/blobRef|decision|rrweb|screenshot/u);
  });

  it("is idempotent for an unchanged reconciliation result and never creates another save identity", async () => {
    const { store, service } = setup({ status: "matching", metadataTurnId: TURN_ID, validatedAt: "2026-08-16T10:06:00.000Z" });
    const first = await service.reconcile(SAVE_POINT_ID);
    const second = await service.reconcile(SAVE_POINT_ID);
    expect(second.savePointId).toBe(first.savePointId);
    expect(second.turnId).toBe(first.turnId);
    expect(store.count()).toBe(1);
  });

  it("coalesces an identical pending idempotency key", async () => {
    const store = createInMemorySavePointStore();
    store.put(seed());
    let release!: (value: TraceLookupResult) => void;
    const lookup = vi.fn(() => new Promise<TraceLookupResult>((resolve) => { release = resolve; }));
    const service = createReconciliationService(store, { lookup });
    const first = service.reconcile(SAVE_POINT_ID, "same-key");
    const duplicate = service.reconcile(SAVE_POINT_ID, "same-key");
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    release({ status: "matching", metadataTurnId: TURN_ID, validatedAt: "2026-08-16T10:08:00.000Z" });
    await expect(first).resolves.toMatchObject({ integrity: { state: "complete" }, traceValidatedAt: "2026-08-16T10:08:00.000Z" });
  });

  it.each([
    ["equal timestamps, first lookup settles first", "2026-08-16T10:09:00.000Z", false],
    ["equal timestamps, second lookup is already settled", "2026-08-16T10:09:00.000Z", true],
    ["missing timestamps, first lookup settles first", undefined, false],
    ["missing timestamps, second lookup is already settled", undefined, true],
  ] as const)("uses request order for %s", async (_label, validatedAt, settleSecondFirst) => {
    const store = createInMemorySavePointStore();
    store.put(seed());
    const results = [deferred<TraceLookupResult>(), deferred<TraceLookupResult>()];
    let lookupIndex = 0;
    const lookup = vi.fn(() => results[lookupIndex++]!.promise);
    const service = createReconciliationService(store, { lookup });
    const first = service.reconcile(SAVE_POINT_ID, "first");
    const second = service.reconcile(SAVE_POINT_ID, "second");
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    const secondResult = { status: "matching", metadataTurnId: TURN_ID, ...(validatedAt === undefined ? {} : { validatedAt }) } as const;
    if (settleSecondFirst) results[1]!.resolve(secondResult);
    results[0]!.resolve({ status: "unreachable", reasonCode: "trace.authority-unreachable", ...(validatedAt === undefined ? {} : { validatedAt }) });
    await first;
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    if (!settleSecondFirst) results[1]!.resolve(secondResult);
    const expectedRevision = validatedAt === undefined ? 2 : 3;
    await expect(second).resolves.toMatchObject({ integrity: { state: "complete" }, revision: expectedRevision });
    expect(store.get(SAVE_POINT_ID)).toMatchObject({ integrity: { state: "complete" }, revision: expectedRevision });
  });

  it("does not let an older validated result regress the latest save revision", async () => {
    const store = createInMemorySavePointStore();
    store.put(seed());
    const results: TraceLookupResult[] = [
      { status: "matching", metadataTurnId: TURN_ID, validatedAt: "2026-08-16T10:09:00.000Z" },
      { status: "unreachable", reasonCode: "trace.authority-unreachable", validatedAt: "2026-08-16T10:08:00.000Z" },
    ];
    const service = createReconciliationService(store, { lookup: () => Promise.resolve(results.shift()!) });
    await service.reconcile(SAVE_POINT_ID, "newer-authority");
    await expect(service.reconcile(SAVE_POINT_ID, "older-authority")).resolves.toMatchObject({ integrity: { state: "complete" }, revision: 2, traceValidatedAt: "2026-08-16T10:09:00.000Z" });
  });

  it("allows different saves to reconcile independently", async () => {
    const store = createInMemorySavePointStore();
    const otherTurn = "01J000000000000000000000T7";
    const otherSave = "01J000000000000000000000S7";
    store.put(seed());
    store.put(seed(input("unreachable", otherTurn, otherSave)));
    const pending = [deferred<TraceLookupResult>(), deferred<TraceLookupResult>()];
    let index = 0;
    const lookup = vi.fn(() => pending[index++]!.promise);
    const service = createReconciliationService(store, { lookup });
    const first = service.reconcile(SAVE_POINT_ID, "save-one");
    const second = service.reconcile(otherSave, "save-two");
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    pending[1]!.resolve({ status: "matching", metadataTurnId: otherTurn });
    await expect(second).resolves.toMatchObject({ savePointId: otherSave, integrity: { state: "complete" } });
    pending[0]!.resolve({ status: "matching", metadataTurnId: TURN_ID });
    await expect(first).resolves.toMatchObject({ savePointId: SAVE_POINT_ID, integrity: { state: "complete" } });
  });

  it("cleans failed in-flight and queue state so the same key can retry", async () => {
    const store = createInMemorySavePointStore();
    store.put(seed());
    const lookup = vi.fn()
      .mockRejectedValueOnce(new Error("authority failed"))
      .mockResolvedValueOnce({ status: "matching", metadataTurnId: TURN_ID });
    const service = createReconciliationService(store, { lookup });
    await expect(service.reconcile(SAVE_POINT_ID, "retry-key")).rejects.toThrow("authority failed");
    await expect(service.reconcile(SAVE_POINT_ID, "retry-key")).resolves.toMatchObject({ integrity: { state: "complete" } });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
