import { describe, expect, it } from "vitest";
import { classifyMeaningfulChange, nominateMeaningfulChange } from "./nomination.js";

const tsxChange = {
  path: "packages/test-fixtures/vs001-ui/src/FixtureApp.tsx",
  before: "export const View = () => <main><h1>Evidence</h1></main>;",
  after: "export const View = () => <main aria-label=\"Evidence\"><header><h1>Evidence</h1></header></main>;",
};

describe("deterministic meaningful-change nomination", () => {
  it("classifies approved TSX and CSS categories and nominates exactly once with a typed boundary", () => {
    const result = nominateMeaningfulChange({
      changes: [tsxChange, tsxChange, {
        path: "packages/test-fixtures/vs001-ui/src/styles.css",
        before: ".grid { display: block; }",
        after: ".grid { display: grid; grid-template-columns: 1fr 1fr; } @media (max-width: 680px) { .grid { grid-template-columns: 1fr; } }",
      }],
      boundaries: [{ kind: "verification", boundaryId: "fixture-tests", occurredAt: "2026-08-16T05:00:00.000Z" }],
      uncertainty: false,
    });
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") throw new Error("expected candidate");
    expect(result.categories).toEqual(["structure", "layout/style-system", "responsive", "accessibility"]);
    expect(result.boundaries).toHaveLength(1);
  });

  it("classifies meaningful nested TSX and CSS anywhere beneath the approved src root", () => {
    const result = nominateMeaningfulChange({
      changes: [
        { ...tsxChange, path: "packages/test-fixtures/vs001-ui/src/panels/evidence/EvidencePanel.tsx" },
        {
          path: "packages/test-fixtures/vs001-ui/src/panels/evidence/EvidencePanel.css",
          before: ".panel { display: block; }",
          after: ".panel { display: grid; } @media (max-width: 680px) { .panel { display: block; } }",
        },
      ],
      boundaries: [{ kind: "verification", boundaryId: "nested-fixture", occurredAt: "2026-08-16T05:00:00.000Z" }],
      uncertainty: false,
    });
    expect(result).toMatchObject({ status: "candidate", categories: ["structure", "layout/style-system", "responsive", "accessibility"] });
  });

  it.each([
    ["no change", [], [{ kind: "decision" as const, boundaryId: "d", occurredAt: "2026-08-16T05:00:00.000Z" }]],
    ["no boundary", [tsxChange], []],
    ["uncertainty alone", [], [], true],
    ["comments and whitespace", [{ ...tsxChange, before: "const x = 1;", after: "// note\nconst   x = 1;" }], [{ kind: "human-intervention" as const, boundaryId: "h", occurredAt: "2026-08-16T05:00:00.000Z" }]],
    ["excluded-only", [{ path: "README.md", before: "a", after: "b" }], [{ kind: "decision" as const, boundaryId: "d", occurredAt: "2026-08-16T05:00:00.000Z" }]],
    ["support-only", [{ path: "packages/test-fixtures/vs001-ui/scenarios/v1/turn.patch", before: "a", after: "b" }], [{ kind: "decision" as const, boundaryId: "d", occurredAt: "2026-08-16T05:00:00.000Z" }]],
    ["fixture support TSX", [{ ...tsxChange, path: "packages/test-fixtures/vs001-ui/src/test-support/FixtureHarness.tsx" }], [{ kind: "decision" as const, boundaryId: "d", occurredAt: "2026-08-16T05:00:00.000Z" }]],
    ["generated TSX", [{ ...tsxChange, path: "packages/test-fixtures/vs001-ui/src/panels/Evidence.generated.tsx" }], [{ kind: "decision" as const, boundaryId: "d", occurredAt: "2026-08-16T05:00:00.000Z" }]],
    ["lockfile-only", [{ path: "pnpm-lock.yaml", before: "a", after: "b" }], [{ kind: "decision" as const, boundaryId: "d", occurredAt: "2026-08-16T05:00:00.000Z" }]],
  ])("settles %s as no-candidate", (_name, changes, boundaries, uncertainty = false) => {
    expect(nominateMeaningfulChange({ changes, boundaries, uncertainty }).status).toBe("no-candidate");
  });

  it("fails closed on unsupported or uncertain source classification", () => {
    expect(classifyMeaningfulChange({ ...tsxChange, before: "const value = 1;", after: "const value = 2;" })).toMatchObject({ qualifying: false, uncertain: true });
  });
});
