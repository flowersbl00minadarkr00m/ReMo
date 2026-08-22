import { describe, expect, it, vi } from "vitest";
import { createVerificationRunner } from "@remo/evidence-verification";
import type { ComponentType, EvidenceDescriptor, FinalizationInput } from "@remo/domain";
import { createInMemorySavePointStore } from "./save-point-service.js";
import { collectVerificationEvidence, createVerificationEvidenceService } from "./verification-evidence.js";

const correlation = {
  projectId: "remo",
  turnId: "01J000000000000000000000T6",
  captureWindowId: "window-1",
  boundaryRevision: "boundary-v1",
};

const SAVE_POINT_ID = "01J000000000000000000000S6";
const componentTypes: readonly ComponentType[] = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"];

function finalization(verificationAvailability: EvidenceDescriptor["availability"]): FinalizationInput {
  return {
    schemaVersion: "remo.bundle.v1",
    identityVersion: "ulid-v1",
    policyRevision: "verification-v1",
    savePointId: SAVE_POINT_ID,
    correlation,
    privacy: { status: "passed", reasonCodes: [] },
    evidence: componentTypes.map((componentType) => ({
      componentId: `${correlation.turnId}:${componentType}`,
      componentType,
      authority: componentType === "source" ? "git" : componentType === "trace" ? "langfuse" : componentType === "rrweb" ? "rrweb" : componentType === "verification" || componentType === "dependencies" ? "fixture" : "remo",
      correlation,
      capturedAt: "2026-08-16T10:00:00.000Z",
      digest: `sha256:${componentType}`,
      ...(componentType === "trace" ? { externalId: "0123456789abcdef0123456789abcdef" } : {}),
      availability: componentType === "verification" ? verificationAvailability : "available",
      provenance: componentType === "decision" ? "user-supplied" : "observed",
      policyRevision: "verification-v1",
      claims: { sourceState: "tree-1", fixtureId: "vs001-fixture-v1" },
    })),
  };
}

describe("verification evidence collection", () => {
  it("projects an allowlisted result without retaining command output", async () => {
    const run = vi.fn().mockResolvedValue({
      commandId: "fixture.pass",
      status: "passed",
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputLimited: false,
      stdoutDigest: "sha256:output",
      durationMs: 4,
      reasonCodes: [],
    });

    const descriptor = await collectVerificationEvidence({ run }, {
      commandId: "fixture.pass",
      fixtureId: "vs001-fixture-v1",
      correlation,
      capturedAt: "2026-08-16T10:00:00.000Z",
      policyRevision: "verification-v1",
    });

    expect(run).toHaveBeenCalledWith("fixture.pass");
    expect(descriptor).toMatchObject({ componentType: "verification", authority: "fixture", availability: "available", correlation });
    expect(JSON.stringify(descriptor)).not.toContain("stdout");
  });

  it("keeps the canonical evidence digest stable when only runtime telemetry changes", async () => {
    const result = {
      commandId: "fixture.pass",
      status: "passed" as const,
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputLimited: false,
      stdoutDigest: "sha256:output",
      reasonCodes: [] as readonly string[],
    };
    const first = await collectVerificationEvidence({ run: () => Promise.resolve({ ...result, durationMs: 4 }) }, { commandId: "fixture.pass", fixtureId: "vs001-fixture-v1", correlation, capturedAt: "2026-08-16T10:00:00.000Z", policyRevision: "verification-v1" });
    const retry = await collectVerificationEvidence({ run: () => Promise.resolve({ ...result, durationMs: 400 }) }, { commandId: "fixture.pass", fixtureId: "vs001-fixture-v1", correlation, capturedAt: "2026-08-16T10:00:00.000Z", policyRevision: "verification-v1" });
    expect(retry.digest).toBe(first.digest);
  });

  it("keeps a failed bounded execution inspectable but promotion-ineligible", async () => {
    const run = vi.fn().mockResolvedValue({
      commandId: "fixture.timeout",
      status: "failed",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      outputLimited: false,
      durationMs: 25,
      reasonCodes: ["verification.timeout"],
    });

    const descriptor = await collectVerificationEvidence({ run }, {
      commandId: "fixture.timeout",
      fixtureId: "vs001-fixture-v1",
      correlation,
      capturedAt: "2026-08-16T10:00:00.000Z",
      policyRevision: "verification-v1",
    });

    expect(descriptor.availability).toBe("rejected");
    expect(descriptor.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("joins the real allowlisted runner to same-identity bundle evaluation without retaining output", async () => {
    const store = createInMemorySavePointStore();
    store.put({
      finalization: finalization("rejected"),
      nominationReason: "Observed meaningful UI change.",
      retention: { promotedAt: "2026-08-16T10:05:00.000Z", expiresAt: "2026-09-15T10:05:00.000Z", pinned: false },
      policyRevisions: { capture: "capture-v1", privacy: "verification-v1", integrity: "verification-v1", fidelity: "verification-v1", retention: "retention-v1" },
    });
    const runner = createVerificationRunner([{ id: "fixture.pass", executable: process.execPath, args: ["-e", "process.stdout.write('private-output-must-not-persist')"], cwd: process.cwd(), timeoutMs: 2_000, maxOutputBytes: 1_024 }]);
    const service = createVerificationEvidenceService(store, runner);

    const result = await service.run(SAVE_POINT_ID, { commandId: "fixture.pass", fixtureId: "vs001-fixture-v1", capturedAt: "2026-08-16T10:06:00.000Z", policyRevision: "verification-v1" });

    expect(result).toMatchObject({ savePointId: SAVE_POINT_ID, turnId: correlation.turnId, revision: 2, integrity: { state: "complete" }, promotionAllowed: true });
    expect(store.count()).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-output-must-not-persist");
    await expect(service.run(SAVE_POINT_ID, { commandId: "fixture.pass;whoami", fixtureId: "vs001-fixture-v1", capturedAt: "2026-08-16T10:07:00.000Z", policyRevision: "verification-v1" })).rejects.toMatchObject({ reasonCode: "verification.command-not-allowlisted" });
    expect(store.count()).toBe(1);
  });
});
