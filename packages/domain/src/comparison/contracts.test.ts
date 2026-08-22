import { describe, expect, it } from "vitest";
import { assertComparisonProjection, buildComparisonProjection, type ComparisonSideInput } from "./contracts.js";

const side = (savePointId: string, overrides: Partial<ComparisonSideInput> = {}): ComparisonSideInput => ({
  savePointId, turnId: `${savePointId}-turn`, displayId: savePointId, state: "available", revision: 1, manifestDigest: `sha256:${"a".repeat(64)}`,
  screenshot: { availability: "available", reference: `/api/save-points/${savePointId}/media/screenshot`, componentId: `${savePointId}:screenshot`, digest: `sha256:${"c".repeat(64)}`, width: 1440, height: 900 },
  source: { state: "available", summary: "Allowed-path source change", authorityMode: "fixture" },
  decision: { state: "available", question: "Which layout?", selectedOption: "Compact", provenance: "user-supplied", revision: 1 },
  verification: { state: "available", summary: "Responsive checks passed", provenance: "observed" },
  integrity: { state: "complete", explanation: "Complete" }, fidelity: { state: "editable-eligible", explanation: "Eligible" },
  context: { route: "/fixture/save-point", viewport: { width: 1440, height: 900 }, fixture: "vs002-replay-fixture-v1", dependencyDigest: `sha256:${"b".repeat(64)}`, policyRevisions: { capture: "capture-v2", privacy: "privacy-v1", integrity: "integrity-v1", fidelity: "fidelity-v2" }, lineageId: "lineage:original", provenance: "fixture-contract" }, replayPath: `/replay/${savePointId}`,
  ...overrides,
});
const withoutContext = (value: ComparisonSideInput): ComparisonSideInput => {
  const { context: omitted, ...result } = value;
  void omitted;
  return result;
};
const withoutReplayPath = (value: ComparisonSideInput): ComparisonSideInput => {
  const { replayPath: omitted, ...result } = value;
  void omitted;
  return result;
};

describe("qualified basic comparison", () => {
  it("assigns explicit roles and permits only a qualified context match", () => {
    const projection = buildComparisonProjection(side("save-before"), side("save-after"));
    expect(projection.left.role).toBe("before"); expect(projection.right.role).toBe("after"); expect(projection.parityClaimAllowed).toBe(true);
    expect(projection.qualifiers).toHaveLength(1);
    expect(projection.qualifiers[0]?.code).toBe("evidence");
    expect(projection.qualifiers[0]?.severity).toBe("note");
    expect(projection.qualifiers[0]?.explanation).toContain("does not establish");
  });
  it("rejects the same identity", () => {
    try { buildComparisonProjection(side("same-save"), side("same-save")); throw new Error("same identity unexpectedly passed"); }
    catch (error: unknown) { expect(error).toMatchObject({ code: "comparison.same-identity" }); }
  });
  it("blocks parity for context, trust, lineage, and evidence mismatches", () => {
    const baseContext = side("x").context!;
    const right = side("save-after", { state: "unavailable", screenshot: { availability: "unavailable" }, integrity: { state: "incomplete", explanation: "Incomplete" }, fidelity: { state: "degraded", explanation: "Degraded" }, context: { ...baseContext, route: "/fixture/other", viewport: { width: 390, height: 844 }, fixture: "mismatch", dependencyDigest: `sha256:${"c".repeat(64)}`, policyRevisions: { ...baseContext.policyRevisions, privacy: "privacy-v2" }, lineageId: "lineage:alternate" } });
    const projection = buildComparisonProjection(side("save-before"), right);
    expect(projection.parityClaimAllowed).toBe(false);
    expect(new Set(projection.qualifiers.map(({ code }) => code))).toEqual(new Set(["evidence", "integrity", "fidelity", "route", "viewport", "fixture", "dependency", "policy"]));
    expect(projection.qualifiers.some(({ code, explanation }) => code === "evidence" && explanation.includes("Lineage differs"))).toBe(true);
  });
  it.each([
    ["both incomplete", { integrity: { state: "incomplete", explanation: "Incomplete" } }],
    ["both degraded", { fidelity: { state: "degraded", explanation: "Degraded" } }],
    ["both historical-only", { fidelity: { state: "historical-only", explanation: "Historical only" } }],
    ["equal unavailable screenshots", { screenshot: { availability: "unavailable" } }],
    ["equal unavailable verification", { verification: { state: "unavailable", summary: "Unavailable" } }],
    ["equal unavailable decisions", { decision: { state: "unavailable" } }],
    ["equal unknown decisions", { decision: { state: "unknown" } }],
    ["equal unavailable dependency evidence", { context: { ...side("context").context!, dependencyDigest: "unavailable" } }],
    ["equal unavailable policy evidence", { context: { ...side("context").context!, policyRevisions: { ...side("context").context!.policyRevisions, capture: "unavailable" } } }],
    ["equal unknown fixture context", { context: { ...side("context").context!, fixture: "unknown" } }],
  ] satisfies readonly (readonly [string, Partial<ComparisonSideInput>])[])("fails parity closed for %s", (_label, overrides) => {
    const projection = buildComparisonProjection(side("save-before", overrides), side("save-after", overrides));
    expect(projection.parityClaimAllowed).toBe(false);
    expect(projection.qualifiers.some(({ severity }) => severity === "blocks-equivalence")).toBe(true);
  });
  it("fails parity closed when comparison context is absent on both sides", () => {
    const projection = buildComparisonProjection(withoutContext(side("save-before")), withoutContext(side("save-after")));
    expect(projection.parityClaimAllowed).toBe(false);
    expect(projection.qualifiers).toContainEqual(expect.objectContaining({ code: "evidence", severity: "blocks-equivalence" }));
  });
  it("fails parity closed for asymmetric decision evidence", () => {
    const asymmetric = buildComparisonProjection(side("save-before", { decision: { state: "unknown" } }), side("save-after"));
    expect(asymmetric.parityClaimAllowed).toBe(false);
    expect(asymmetric.qualifiers).toContainEqual(expect.objectContaining({ code: "evidence", severity: "blocks-equivalence" }));
  });
  it("accepts replayPath only when absent or the exact internal route for the same save point", () => {
    expect(buildComparisonProjection(withoutReplayPath(side("save-before")), side("save-after")).left.replayPath).toBeUndefined();
    expect(buildComparisonProjection(side("save-before"), side("save-after")).left.replayPath).toBe("/replay/save-before");
  });
  it.each([
    ["external URL", "https://example.test/replay/save-before"],
    ["script scheme", "javascript:alert(1)"],
    ["mismatched identity", "/replay/save-after"],
    ["query", "/replay/save-before?mode=unsafe"],
    ["fragment", "/replay/save-before#unsafe"],
  ])("rejects a replayPath with %s", (_label, replayPath) => {
    expect(() => buildComparisonProjection(side("save-before", { replayPath }), side("save-after"))).toThrow(/replay path/iu);
  });
  it("strictly rejects unknown fields at every nested runtime boundary and Later keys", () => {
    const canonical = buildComparisonProjection(side("save-before"), side("save-after"));
    const hostile: readonly ((value: unknown) => void)[] = [
      (value) => { (value as { left: Record<string, unknown> }).left.winner = true; },
      (value) => { ((value as { left: { context: { viewport: Record<string, unknown> } } }).left.context.viewport).scale = 2; },
      (value) => { ((value as { left: { source: Record<string, unknown> } }).left.source).score = 0.9; },
      (value) => { ((value as { left: { verification: Record<string, unknown> } }).left.verification).confidence = "high"; },
      (value) => { ((value as { left: { integrity: Record<string, unknown> } }).left.integrity).complete = true; },
      (value) => { ((value as { left: { fidelity: Record<string, unknown> } }).left.fidelity).rank = 1; },
      (value) => { ((value as { left: { context: { policyRevisions: Record<string, unknown> } } }).left.context.policyRevisions).retention = "later"; },
      (value) => { ((value as { left: { screenshot: Record<string, unknown> } }).left.screenshot).pixelDiff = "later"; },
      (value) => { ((value as { qualifiers: Record<string, unknown>[] }).qualifiers[0]!).verdict = "same"; },
      (value) => { ((value as { left: { decision: Record<string, unknown> } }).left.decision).causalAttribution = "layout"; },
      (value) => { (value as Record<string, unknown>).winner = "before"; },
    ];
    for (const mutate of hostile) {
      const value = structuredClone(canonical);
      mutate(value);
      expect(() => assertComparisonProjection(value)).toThrow(/unknown field/u);
    }
  });
  it("rejects malformed nested values, bounds, enums, and non-canonical projections", () => {
    const malformed = structuredClone(buildComparisonProjection(side("save-before"), side("save-after")));
    (malformed.left.context!.viewport as { width: number }).width = 0;
    expect(() => assertComparisonProjection(malformed)).toThrow(/bound/u);
    const badEnum = structuredClone(buildComparisonProjection(side("save-before"), side("save-after")));
    (badEnum.left.fidelity as { state: string }).state = "perfect";
    expect(() => assertComparisonProjection(badEnum)).toThrow(/invalid/u);
    const forged = structuredClone(buildComparisonProjection(side("save-before"), side("save-after"))) as { parityClaimAllowed: boolean };
    forged.parityClaimAllowed = false;
    expect(() => assertComparisonProjection(forged)).toThrow(/canonical/u);
  });
  it("fails parity closed when preserved context dimensions are not bound to the authenticated screenshot", () => {
    const unbound = side("save-after", { context: { ...side("seed").context!, viewport: { width: 390, height: 844 } } });
    const projection = buildComparisonProjection(side("save-before"), unbound);
    expect(projection.parityClaimAllowed).toBe(false);
    const qualifier = projection.qualifiers.find(({ explanation }) => /bound.*authenticated screenshot dimensions/u.test(explanation));
    expect(qualifier).toMatchObject({ code: "evidence", severity: "blocks-equivalence" });
  });
  it("contains no Later diff, score, winner, verdict, or causal fields", () => {
    const value = JSON.stringify(buildComparisonProjection(side("save-before"), side("save-after")));
    for (const forbidden of ["pixelDiff", "semanticDiff", "heatmap", "causalAttribution", "score", "winner", "verdict"]) expect(value).not.toContain(`"${forbidden}"`);
  });
});
