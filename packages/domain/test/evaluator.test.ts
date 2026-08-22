import { describe, expect, it } from "vitest";
import {
  PROVENANCE_VALUES,
  evaluateBundle,
  isProvenance,
  type ComponentType,
  type CorrelationTuple,
  type EvidenceDescriptor,
  type FinalizationInput,
} from "../src/index.js";

const correlation: CorrelationTuple = {
  projectId: "project-1",
  turnId: "01J0000000000000000000000D",
  captureWindowId: "window-d",
  boundaryRevision: "boundary-v1",
};

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

function matchingEvidence(): EvidenceDescriptor[] {
  return componentTypes.map((componentType) => ({
    componentId: `${correlation.turnId}:${componentType}`,
    componentType,
    authority: componentType === "trace" ? "langfuse" : "remo",
    correlation: { ...correlation },
    capturedAt: "2026-08-15T20:00:00.000Z",
    digest: `sha256:${componentType}`,
    ...(componentType === "trace"
      ? { externalId: "0123456789abcdef0123456789abcdef" }
      : {}),
    availability: "available",
    provenance: componentType === "decision" ? "user-supplied" : "observed",
    policyRevision: "policy-v1",
    claims: {
      sourceState: "tree-a",
      fixtureId: "fixture-v1",
    },
  }));
}

function matchingInput(): FinalizationInput {
  return {
    schemaVersion: "remo.bundle.v1",
    identityVersion: "ulid-v1",
    policyRevision: "policy-v1",
    savePointId: "01J0000000000000000000001D",
    correlation,
    privacy: { status: "passed", reasonCodes: [] },
    evidence: matchingEvidence(),
  };
}

describe("trust evaluator", () => {
  it("produces byte-identical canonical output for equivalent input orderings", () => {
    const first = matchingInput();
    const second: FinalizationInput = {
      ...matchingInput(),
      evidence: [...matchingEvidence()].reverse(),
    };

    const firstResult = evaluateBundle(first);
    const secondResult = evaluateBundle(second);

    expect(firstResult.canonicalManifest).toBe(secondResult.canonicalManifest);
    expect(firstResult.manifestDigest).toBe(secondResult.manifestDigest);
  });

  it("canonicalizes conflicting duplicate-ID descriptors independent of input order", () => {
    const evidence = matchingEvidence();
    const trace = evidence.find(({ componentType }) => componentType === "trace");
    if (trace === undefined) throw new Error("test fixture lacks trace");
    const conflictingTrace: EvidenceDescriptor = {
      ...trace,
      correlation: {
        ...trace.correlation,
        turnId: "01J0000000000000000000000E",
      },
      digest: "sha256:conflicting-trace",
    };
    const forward = evaluateBundle({
      ...matchingInput(),
      evidence: [...evidence, conflictingTrace],
    });
    const reversed = evaluateBundle({
      ...matchingInput(),
      evidence: [...evidence, conflictingTrace].reverse(),
    });

    expect(forward.integrity.state).toBe("inconsistent");
    expect(reversed.integrity.state).toBe("inconsistent");
    expect(forward.integrity.reasonCodes).toContain(
      "evidence.duplicate-component",
    );
    expect(forward.integrity.reasonCodes).toContain(
      "correlation.turn-mismatch",
    );
    expect(forward.canonicalManifest).toBe(reversed.canonicalManifest);
    expect(forward.manifestDigest).toBe(reversed.manifestDigest);
  });

  it("classifies only fully matching evidence as complete", () => {
    const result = evaluateBundle(matchingInput());

    expect(result.integrity).toEqual({
      state: "complete",
      reasonCodes: [],
      componentIds: [],
    });
    expect(result.fidelity.state).toBe("editable-eligible");
    expect(result.promotionAllowed).toBe(true);
  });

  it("classifies missing correlation proof as incomplete", () => {
    const evidence = matchingEvidence();
    const trace = evidence.find(({ componentType }) => componentType === "trace");
    if (trace === undefined) throw new Error("test fixture lacks trace");
    delete trace.correlation.turnId;

    const result = evaluateBundle({ ...matchingInput(), evidence });

    expect(result.integrity.state).toBe("incomplete");
    expect(result.integrity.reasonCodes).toContain(
      "evidence.correlation-proof-missing",
    );
    expect(result.promotionAllowed).toBe(false);
  });

  it("classifies a trace without a valid W3C trace ID as incomplete", () => {
    const evidence = matchingEvidence().map((descriptor) =>
      descriptor.componentType === "trace"
        ? { ...descriptor, externalId: "not-a-trace-id" }
        : descriptor,
    );

    const result = evaluateBundle({ ...matchingInput(), evidence });

    expect(result.integrity.state).toBe("incomplete");
    expect(result.integrity.reasonCodes).toContain("trace.id-proof-missing");
  });

  it("quarantines privacy failure before evaluating an identity conflict", () => {
    const evidence = matchingEvidence().map((descriptor) =>
      descriptor.componentType === "trace"
        ? {
            ...descriptor,
            correlation: { ...descriptor.correlation, turnId: "01J0000000000000000000000E" },
          }
        : descriptor,
    );
    evidence[0] = { ...evidence[0], blobRef: "unsafe-local-blob" } as EvidenceDescriptor;

    const result = evaluateBundle({
      ...matchingInput(),
      privacy: {
        status: "failed",
        reasonCodes: ["privacy.failed"],
        failedComponentIds: [`${correlation.turnId}:screenshot`],
      },
      evidence,
    });

    expect(result.integrity.state).toBe("quarantined");
    expect(result.integrity.reasonCodes).toEqual(["privacy.failed"]);
    expect(result.integrity.reasonCodes).not.toContain("correlation.turn-mismatch");
    expect(result.fidelity.state).toBe("unavailable");
    expect(result.manifest.evidence.every((descriptor) => descriptor.blobRef === undefined)).toBe(
      true,
    );
  });

  it("limits decision provenance to the approved non-private vocabulary", () => {
    expect(PROVENANCE_VALUES).toEqual([
      "observed",
      "user-supplied",
      "inferred",
      "reconstructed",
      "unknown",
    ]);
    expect(isProvenance("private-chain-of-thought")).toBe(false);
  });
});
