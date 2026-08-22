import { describe, expect, it } from "vitest";
import { verifyScenarioSequence } from "./scenario-harness.mjs";
import { VS001_SCENARIOS } from "./scenarios.mjs";

describe("VS-001 v1 reversible scenario harness", () => {
  it("verifies ten exact ordered forward/inverse scenarios and the reverse-to-base digest", async () => {
    const report = await verifyScenarioSequence();
    expect(VS001_SCENARIOS.map(({ turn }) => turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(report.scenarios.map(({ forwardDigest }) => forwardDigest)).size).toBe(10);
    expect(report.scenarios).toHaveLength(10);
    expect(report.finalDigest).not.toBe(report.baseDigest);
    expect(report.reverseDigest).toBe(report.baseDigest);
  });
});
