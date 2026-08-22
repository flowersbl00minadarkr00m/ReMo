import { describe, expect, it } from "vitest";
import { assertDecisionRecord, assertDecisionTransition, buildDecisionRecord, DecisionValidationError, type DecisionContent, type DecisionField } from "./contracts.js";

const turnId = "01J00000000000000000000T04";
const savePointId = "01J00000000000000000000S04";
const recordedAt = "2026-08-18T10:04:00.000Z";
const component = (type: string): string => `${turnId}:${type}`;
const supplied = <T>(value: T, sourceComponentIds: readonly string[] = []): DecisionField<T> => ({ value, provenance: "user-supplied", sourceComponentIds, recordedAt });
const unknown = <T>(): DecisionField<T> => ({ provenance: "unknown", sourceComponentIds: [], recordedAt });

function content(overrides: Partial<DecisionContent> = {}): DecisionContent {
  return {
    question: supplied("Should the navigation remain visible at narrow widths?"),
    options: supplied([{ id: "disclosure", label: "Use an explicit disclosure" }, { id: "hide", label: "Hide secondary destinations" }]),
    selectedOptionId: supplied("disclosure"),
    owner: supplied("Product owner"),
    uncertainty: supplied({ level: "low", source: "human" }),
    evidenceComponentIds: [component("screenshot"), component("verification")],
    expectedEffect: supplied("Primary destinations remain discoverable without horizontal overflow."),
    verification: supplied("Verify keyboard traversal and five responsive widths.", [component("verification")]),
    outcome: unknown(),
    ...overrides,
  };
}

function record(revision = 1, predecessorDigest?: string, overrides: Partial<DecisionContent> = {}) {
  return buildDecisionRecord({ decisionId: "decision-turn-04", savePointId, turnId, revision, ...(predecessorDigest === undefined ? {} : { predecessorDigest }), ...content(overrides) });
}

describe("structured decision evidence", () => {
  it("builds one canonical low-uncertainty contemporaneous record without inventing unknown outcome", () => {
    const value = record();
    expect(value).toMatchObject({ schemaVersion: "remo.decision.v1", revision: 1, question: { provenance: "user-supplied" }, uncertainty: { value: { level: "low", source: "human" } }, outcome: { provenance: "unknown" } });
    expect(value.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(assertDecisionRecord(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it("confirms inferred evidence in a new revision without upgrading its provenance", () => {
    const inferredAt = "2026-08-18T10:05:00.000Z";
    const first = record(1, undefined, { expectedEffect: { value: "The focused destination remains visible.", provenance: "inferred", sourceComponentIds: [component("screenshot")], recordedAt: inferredAt } });
    const next = record(2, first.digest, { expectedEffect: { ...first.expectedEffect, confirmedAt: "2026-08-18T10:06:00.000Z" } });
    expect(assertDecisionTransition(first, next, "confirm-inferred").expectedEffect).toMatchObject({ provenance: "inferred", confirmedAt: "2026-08-18T10:06:00.000Z" });
  });

  it("adds reconstructed evidence to unknown and corrects by preserving predecessor revisions", () => {
    const first = record();
    const reconstructed = record(2, first.digest, { outcome: { value: "Five widths passed without document overflow.", provenance: "reconstructed", sourceComponentIds: [component("verification")], recordedAt: "2026-08-18T10:08:00.000Z" } });
    expect(assertDecisionTransition(first, reconstructed, "reconstructed-supplement").predecessorDigest).toBe(first.digest);
    const corrected = buildDecisionRecord({ ...reconstructed, revision: 3, predecessorDigest: reconstructed.digest, outcome: { value: "Four widths passed; the 320 px result remained unknown.", provenance: "reconstructed", sourceComponentIds: [component("verification")], recordedAt: "2026-08-18T10:09:00.000Z" } });
    expect(assertDecisionTransition(reconstructed, corrected, "correction").predecessorDigest).toBe(reconstructed.digest);
    expect(first.outcome.provenance).toBe("unknown");
  });

  it.each([
    ["cross-turn evidence", () => record(1, undefined, { verification: supplied("Check it", ["01J00000000000000000000T08:verification"]) }), "decision.evidence-cross-turn"],
    ["arbitrary URL", () => record(1, undefined, { owner: supplied("https://example.test/owner") }), "decision.unsafe-text"],
    ["HTML", () => record(1, undefined, { question: supplied("<strong>Choose</strong>") }), "decision.unsafe-text"],
    ["oversized text", () => record(1, undefined, { question: supplied("x".repeat(513)) }), "decision.text-invalid"],
    ["unknown with value", () => record(1, undefined, { outcome: { value: "invented", provenance: "unknown", sourceComponentIds: [], recordedAt } }), "decision.unknown-invalid"],
    ["unknown option", () => record(1, undefined, { selectedOptionId: supplied("not-recorded") }), "decision.selection-invalid"],
  ])("rejects %s", (_name, action, code) => {
    expect(action).toThrowError(DecisionValidationError);
    try { action(); } catch (error) { expect((error as DecisionValidationError).code).toBe(code); }
  });

  it("rejects stale, provenance-upgrading, and unsupported mutations", () => {
    const first = record();
    const stale = buildDecisionRecord({ ...first, revision: 2, predecessorDigest: `sha256:${"f".repeat(64)}`, outcome: { value: "A result", provenance: "reconstructed", sourceComponentIds: [component("verification")], recordedAt: "2026-08-18T10:08:00.000Z" } });
    expect(() => assertDecisionTransition(first, stale, "reconstructed-supplement")).toThrowError(/stale/u);
    const inventedObserved = buildDecisionRecord({ ...first, revision: 2, predecessorDigest: first.digest, outcome: { value: "A result", provenance: "observed", sourceComponentIds: [component("verification")], recordedAt: "2026-08-18T10:08:00.000Z" } });
    expect(() => assertDecisionTransition(first, inventedObserved, "correction")).toThrowError(/retroactive observed/u);
  });
});
