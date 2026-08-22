import { describe, expect, it } from "vitest";
import type {
  ComponentType,
  CorrelationTuple,
  EvidenceDescriptor,
  FinalizationInput,
} from "@remo/domain";
import {
  createCaptureFinalizationService,
  createInMemoryCaptureRepository,
} from "./index.js";

const componentTypes: readonly ComponentType[] = [
  "source",
  "rrweb",
  "screenshot",
  "trace",
  "decision",
  "verification",
  "dependencies",
  "lineage",
];

function evidenceFor(
  correlation: CorrelationTuple,
  traceCorrelation: CorrelationTuple = correlation,
): EvidenceDescriptor[] {
  return componentTypes.map((componentType) => {
    const traceFields =
      componentType === "trace"
        ? { externalId: "0123456789abcdef0123456789abcdef" }
        : {};
    return {
      componentId: `${correlation.turnId}:${componentType}`,
      componentType,
      authority:
        componentType === "source"
          ? "git"
          : componentType === "rrweb"
            ? "rrweb"
            : componentType === "trace"
              ? "langfuse"
              : "remo",
      correlation: componentType === "trace" ? traceCorrelation : correlation,
      capturedAt: "2026-08-15T20:00:00.000Z",
      digest: `sha256:${componentType}`,
      ...traceFields,
      availability: "available",
      provenance: componentType === "decision" ? "user-supplied" : "observed",
      policyRevision: "policy-v1",
    };
  });
}

function completeInput(
  correlation: CorrelationTuple,
  savePointId: string,
  traceCorrelation: CorrelationTuple = correlation,
): FinalizationInput {
  return {
    schemaVersion: "remo.bundle.v1",
    identityVersion: "ulid-v1",
    policyRevision: "policy-v1",
    savePointId,
    correlation,
    privacy: { status: "passed", reasonCodes: [] },
    evidence: evidenceFor(correlation, traceCorrelation),
  };
}

describe("capture finalization", () => {
  it("rejects turn B carrying turn A trace metadata without changing A", () => {
    const repository = createInMemoryCaptureRepository();
    const service = createCaptureFinalizationService(repository);
    const turnA: CorrelationTuple = {
      projectId: "project-1",
      turnId: "01J0000000000000000000000A",
      captureWindowId: "window-a",
      boundaryRevision: "boundary-v1",
    };
    const turnB: CorrelationTuple = {
      ...turnA,
      turnId: "01J0000000000000000000000B",
      captureWindowId: "window-b",
    };

    const candidateA = service.finalize(
      completeInput(turnA, "01J0000000000000000000001A"),
    );
    const durableA = service.promote(turnA.turnId);
    const digestBeforeMismatch = repository.getByTurn(turnA.turnId)?.manifestDigest;

    const candidateB = service.finalize(
      completeInput(turnB, "01J0000000000000000000001B", turnA),
    );

    if (durableA.status === "blocked") {
      throw new Error("turn A should promote in the complete fixture");
    }

    expect(candidateA.integrity.state).toBe("complete");
    expect(durableA.status).toBe("promoted");
    expect(candidateB.integrity.state).toBe("inconsistent");
    expect(candidateB.promotionAllowed).toBe(false);
    expect(candidateB.integrity.reasonCodes).toContain("correlation.turn-mismatch");
    expect(repository.getByTurn(turnA.turnId)?.manifestDigest).toBe(
      digestBeforeMismatch,
    );
    expect(repository.getByTurn(turnA.turnId)?.durableManifestDigest).toBe(
      durableA.manifestDigest,
    );
  });

  it("reconciles retries to one turn/save identity and one durable digest", () => {
    const repository = createInMemoryCaptureRepository();
    const service = createCaptureFinalizationService(repository);
    const turn: CorrelationTuple = {
      projectId: "project-1",
      turnId: "01J0000000000000000000000C",
      captureWindowId: "window-c",
      boundaryRevision: "boundary-v1",
    };

    const first = service.finalize(
      completeInput(turn, "01J0000000000000000000001C"),
    );
    const retry = service.finalize(
      completeInput(turn, "01J0000000000000000000001D"),
    );
    const promoted = service.promote(turn.turnId);
    const promotionRetry = service.promote(turn.turnId);

    expect(retry.savePointId).toBe(first.savePointId);
    expect(retry.revision).toBe(2);
    expect(promoted.status).toBe("promoted");
    expect(promotionRetry.status).toBe("already-promoted");
    if (promoted.status === "promoted" && promotionRetry.status === "already-promoted") {
      expect(promotionRetry.savePointId).toBe(promoted.savePointId);
      expect(promotionRetry.manifestDigest).toBe(promoted.manifestDigest);
    }
  });
});
