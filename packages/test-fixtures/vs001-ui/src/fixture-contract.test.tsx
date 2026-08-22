import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FixtureApp } from "./FixtureApp.js";
import { FIXTURE_CONTRACT, FIXTURE_STATE } from "./fixture-contract.js";

describe("VS-001 binding fixture", () => {
  it("pins the exact route, allowlists, selectors, state, and canary", () => {
    expect(FIXTURE_CONTRACT).toMatchObject({
      packageName: "@remo/vs001-fixture",
      fixtureVersion: "vs001-fixture-v1",
      replayFixtureVersion: "vs002-replay-fixture-v1",
      origin: "http://127.0.0.1:4173",
      route: "/fixture/save-point",
      captureRoot: "[data-remo-fixture-root]",
      populatedCaptureRoot: '[data-remo-fixture-root="vs002-replay-fixture-v1"]',
      evidenceSourceAllowlist: "packages/test-fixtures/vs001-ui/src/**",
      privacyCanary: "REMO_SECRET_CANARY_V1",
    });
    expect(FIXTURE_CONTRACT.stateKeys).toEqual(Object.keys(FIXTURE_STATE));
    expect(FIXTURE_CONTRACT.maskSelectors).toEqual([
      "[data-remo-sensitive]",
      "[data-remo-mask]",
      "input",
      "textarea",
    ]);
    expect(FIXTURE_CONTRACT.blockSelectors).toEqual([
      "[data-remo-block]",
      "iframe",
      "canvas",
    ]);
  });

  it("models one populated host capture root plus masked input/text and a block marker", () => {
    const markup = renderToStaticMarkup(
      <div data-remo-fixture-root={FIXTURE_CONTRACT.replayFixtureVersion}>
        <FixtureApp />
      </div>,
    );

    expect(markup.match(/data-remo-fixture-root/g)).toHaveLength(1);
    expect(markup).toContain('data-remo-fixture-root="vs002-replay-fixture-v1"');
    expect(markup).toContain("data-remo-sensitive");
    expect(markup).toContain("data-remo-mask");
    expect(markup).toContain("<input");
    expect(markup).toContain("<textarea");
    expect(markup).toContain("data-remo-block");
    expect(markup.match(/REMO_SECRET_CANARY_V1/g)?.length).toBeGreaterThanOrEqual(3);
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("<canvas");
  });
});
