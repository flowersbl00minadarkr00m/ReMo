import { describe, expect, it } from "vitest";
import {
  VS001_BOUNDARY_CONTRACT,
  createPassingPreflightInput,
  evaluateBoundaryPreflight,
  type BoundaryPreflightInput,
} from "./preflight.js";

function withChange(
  change: (input: BoundaryPreflightInput) => void,
): BoundaryPreflightInput {
  const input = createPassingPreflightInput();
  change(input);
  return input;
}

describe("VS-001 boundary preflight", () => {
  it("passes only the exact binding fixture contract", () => {
    const result = evaluateBoundaryPreflight(createPassingPreflightInput());

    expect(result.ready).toBe(true);
    expect(result.recordingState).toBe("off");
    expect(result.failures).toEqual([]);
    expect(result.contract.fixtureVersion).toBe("vs001-fixture-v1");
  });

  it.each([
    {
      name: "an ambiguous capture root",
      input: withChange((value) => {
        value.selectorMatches[VS001_BOUNDARY_CONTRACT.captureRoot] = 2;
      }),
      reasonCode: "selector.capture-root-ambiguous",
      recovery: "Keep exactly one [data-remo-fixture-root] element on the allowed route.",
    },
    {
      name: "a missing mandatory privacy selector",
      input: withChange((value) => {
        value.selectorMatches["[data-remo-mask]"] = 0;
      }),
      reasonCode: "selector.mask-missing",
      recovery: "Restore the missing [data-remo-mask] fixture marker before retrying preflight.",
    },
    {
      name: "a disallowed source path",
      input: withChange((value) => {
        value.observedSourcePaths.push("packages/test-fixtures/vs001-ui/scenarios/v1/turn-01.patch");
      }),
      reasonCode: "source.path-disallowed",
      recovery: "Limit evidence-bearing changes to packages/test-fixtures/vs001-ui/src/**.",
    },
    {
      name: "origin drift",
      input: withChange((value) => {
        value.origin = "http://localhost:4173";
      }),
      reasonCode: "browser.origin-mismatch",
      recovery: "Open the fixture at the exact origin http://127.0.0.1:4173.",
    },
    {
      name: "route drift",
      input: withChange((value) => {
        value.route = "/fixture/other";
      }),
      reasonCode: "browser.route-mismatch",
      recovery: "Navigate to the exact route /fixture/save-point and rerun preflight.",
    },
    {
      name: "an unknown browser-state key",
      input: withChange((value) => {
        value.stateKeys.push("ambientStorage");
      }),
      reasonCode: "state.unknown-key",
      recovery: "Remove unknown state keys; use only activePanel, selectedEvidenceId, detailsExpanded, viewportMode.",
    },
    {
      name: "an unapproved command",
      input: withChange((value) => {
        value.commands.push("pnpm test:e2e");
      }),
      reasonCode: "command.unapproved",
      recovery: "Remove unapproved commands and restore the four @remo/vs001-fixture verification commands.",
    },
  ])("fails closed for $name with a specific recovery", ({ input, reasonCode, recovery }) => {
    const result = evaluateBoundaryPreflight(input);

    expect(result.ready).toBe(false);
    expect(result.recordingState).toBe("off");
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode, recovery }),
      ]),
    );
  });
});
