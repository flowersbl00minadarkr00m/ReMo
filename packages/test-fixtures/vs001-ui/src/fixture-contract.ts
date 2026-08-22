export const FIXTURE_CONTRACT = {
  packageName: "@remo/vs001-fixture",
  fixtureVersion: "vs001-fixture-v1",
  replayFixtureVersion: "vs002-replay-fixture-v1",
  origin: "http://127.0.0.1:4173",
  route: "/fixture/save-point",
  captureRoot: "[data-remo-fixture-root]",
  populatedCaptureRoot: '[data-remo-fixture-root="vs002-replay-fixture-v1"]',
  evidenceSourceAllowlist: "packages/test-fixtures/vs001-ui/src/**",
  stateKeys: [
    "activePanel",
    "selectedEvidenceId",
    "detailsExpanded",
    "viewportMode",
  ],
  maskSelectors: [
    "[data-remo-sensitive]",
    "[data-remo-mask]",
    "input",
    "textarea",
  ],
  blockSelectors: ["[data-remo-block]", "iframe", "canvas"],
  privacyCanary: "REMO_SECRET_CANARY_V1",
} as const;

export const FIXTURE_STATE = {
  activePanel: "evidence",
  selectedEvidenceId: "fixture-evidence-001",
  detailsExpanded: false,
  viewportMode: "responsive",
} as const;
