export const VS001_BOUNDARY_CONTRACT = {
  registryIdentity: "remo",
  canonicalProjectPath: "C:/path/to/ReMo",
  fixturePackage: "@remo/vs001-fixture",
  fixtureVersion: "vs001-fixture-v1",
  sourceAllowlist: ["packages/test-fixtures/vs001-ui/src/**"],
  origin: "http://127.0.0.1:4173",
  route: "/fixture/save-point",
  captureRoot: "[data-remo-fixture-root]",
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
  captureViewport: { width: 1440, height: 900 },
  responsiveViewport: { width: 390, height: 844 },
  commands: [
    "pnpm --filter @remo/vs001-fixture lint",
    "pnpm --filter @remo/vs001-fixture typecheck",
    "pnpm --filter @remo/vs001-fixture test",
    "pnpm --filter @remo/vs001-fixture build",
  ],
} as const;

export type PreflightCategory =
  | "project"
  | "source"
  | "browser"
  | "privacy"
  | "state"
  | "verification"
  | "fixture";

export interface BoundaryPreflightInput {
  registryIdentity: string;
  canonicalProjectPath: string;
  fixturePackage: string;
  fixtureVersion: string;
  sourceAllowlist: string[];
  observedSourcePaths: string[];
  origin: string;
  route: string;
  captureRoot: string;
  stateKeys: string[];
  maskSelectors: string[];
  blockSelectors: string[];
  selectorMatches: Record<string, number>;
  privacyCanary: string;
  captureViewport: { width: number; height: number };
  responsiveViewport: { width: number; height: number };
  commands: string[];
}

export interface PreflightFailure {
  category: PreflightCategory;
  reasonCode: string;
  explanation: string;
  recovery: string;
}

export interface PreflightCheck {
  category: PreflightCategory;
  label: string;
  status: "pass" | "fail";
  failureCount: number;
}

export interface BoundaryPreflightResult {
  ready: boolean;
  recordingState: "off";
  failures: PreflightFailure[];
  checks: PreflightCheck[];
  contract: typeof VS001_BOUNDARY_CONTRACT;
}

const COPY = <T>(value: readonly T[]): T[] => [...value];

export function createPassingPreflightInput(): BoundaryPreflightInput {
  return {
    registryIdentity: VS001_BOUNDARY_CONTRACT.registryIdentity,
    canonicalProjectPath: VS001_BOUNDARY_CONTRACT.canonicalProjectPath,
    fixturePackage: VS001_BOUNDARY_CONTRACT.fixturePackage,
    fixtureVersion: VS001_BOUNDARY_CONTRACT.fixtureVersion,
    sourceAllowlist: COPY(VS001_BOUNDARY_CONTRACT.sourceAllowlist),
    observedSourcePaths: [
      "packages/test-fixtures/vs001-ui/src/FixtureApp.tsx",
    ],
    origin: VS001_BOUNDARY_CONTRACT.origin,
    route: VS001_BOUNDARY_CONTRACT.route,
    captureRoot: VS001_BOUNDARY_CONTRACT.captureRoot,
    stateKeys: COPY(VS001_BOUNDARY_CONTRACT.stateKeys),
    maskSelectors: COPY(VS001_BOUNDARY_CONTRACT.maskSelectors),
    blockSelectors: COPY(VS001_BOUNDARY_CONTRACT.blockSelectors),
    selectorMatches: {
      "[data-remo-fixture-root]": 1,
      "[data-remo-sensitive]": 1,
      "[data-remo-mask]": 1,
      input: 1,
      textarea: 1,
      "[data-remo-block]": 1,
      iframe: 0,
      canvas: 0,
    },
    privacyCanary: VS001_BOUNDARY_CONTRACT.privacyCanary,
    captureViewport: { ...VS001_BOUNDARY_CONTRACT.captureViewport },
    responsiveViewport: { ...VS001_BOUNDARY_CONTRACT.responsiveViewport },
    commands: COPY(VS001_BOUNDARY_CONTRACT.commands),
  };
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameViewport(
  actual: { width: number; height: number },
  expected: { readonly width: number; readonly height: number },
): boolean {
  return actual.width === expected.width && actual.height === expected.height;
}

function canonicalWindowsPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/u, "").toLocaleLowerCase("en-US");
}

function addFailure(
  failures: PreflightFailure[],
  category: PreflightCategory,
  reasonCode: string,
  explanation: string,
  recovery: string,
): void {
  failures.push({ category, reasonCode, explanation, recovery });
}

export function evaluateBoundaryPreflight(
  input: BoundaryPreflightInput,
): BoundaryPreflightResult {
  const failures: PreflightFailure[] = [];

  if (input.registryIdentity !== VS001_BOUNDARY_CONTRACT.registryIdentity) {
    addFailure(failures, "project", "project.registry-identity-mismatch", "The registry identity is not the binding ReMo project.", "Resolve registry identity remo and rerun preflight.");
  }
  if (canonicalWindowsPath(input.canonicalProjectPath) !== canonicalWindowsPath(VS001_BOUNDARY_CONTRACT.canonicalProjectPath)) {
    addFailure(failures, "project", "project.canonical-path-mismatch", "The resolved project path is outside the canonical ReMo checkout.", "Resolve ReMo through the project registry and rerun preflight.");
  }
  if (input.fixturePackage !== VS001_BOUNDARY_CONTRACT.fixturePackage) {
    addFailure(failures, "fixture", "fixture.package-mismatch", "The selected fixture package is not the binding VS-001 fixture.", "Select @remo/vs001-fixture before retrying preflight.");
  }
  if (input.fixtureVersion !== VS001_BOUNDARY_CONTRACT.fixtureVersion) {
    addFailure(failures, "fixture", "fixture.version-mismatch", "The fixture version does not match the approved contract.", "Restore fixture version vs001-fixture-v1 and rerun preflight.");
  }
  if (!sameOrderedValues(input.sourceAllowlist, VS001_BOUNDARY_CONTRACT.sourceAllowlist)) {
    addFailure(failures, "source", "source.allowlist-mismatch", "The evidence-bearing source allowlist has drifted.", "Restore the single allowlist packages/test-fixtures/vs001-ui/src/**.");
  }
  const sourcePrefix = "packages/test-fixtures/vs001-ui/src/";
  if (input.observedSourcePaths.some((path) => !path.replaceAll("\\", "/").startsWith(sourcePrefix))) {
    addFailure(failures, "source", "source.path-disallowed", "At least one observed path is outside the evidence-bearing fixture source.", "Limit evidence-bearing changes to packages/test-fixtures/vs001-ui/src/**.");
  }
  if (input.origin !== VS001_BOUNDARY_CONTRACT.origin) {
    addFailure(failures, "browser", "browser.origin-mismatch", "The browser origin is not the approved loopback origin.", "Open the fixture at the exact origin http://127.0.0.1:4173.");
  }
  if (input.route !== VS001_BOUNDARY_CONTRACT.route) {
    addFailure(failures, "browser", "browser.route-mismatch", "The browser route is outside the approved fixture route.", "Navigate to the exact route /fixture/save-point and rerun preflight.");
  }
  if (input.captureRoot !== VS001_BOUNDARY_CONTRACT.captureRoot) {
    addFailure(failures, "browser", "selector.capture-root-mismatch", "The configured capture root selector has drifted.", "Restore [data-remo-fixture-root] as the capture root selector.");
  }
  const captureRootCount = input.selectorMatches[VS001_BOUNDARY_CONTRACT.captureRoot] ?? 0;
  if (captureRootCount === 0) {
    addFailure(failures, "browser", "selector.capture-root-missing", "The mandatory capture root was not found.", "Add one [data-remo-fixture-root] element to the allowed route.");
  } else if (captureRootCount !== 1) {
    addFailure(failures, "browser", "selector.capture-root-ambiguous", "The capture root matched more than one element.", "Keep exactly one [data-remo-fixture-root] element on the allowed route.");
  }
  if (!sameOrderedValues(input.maskSelectors, VS001_BOUNDARY_CONTRACT.maskSelectors)) {
    addFailure(failures, "privacy", "selector.mask-list-mismatch", "The configured mask-selector list has drifted.", "Restore the four approved mask selectors in contract order.");
  }
  for (const selector of VS001_BOUNDARY_CONTRACT.maskSelectors) {
    if ((input.selectorMatches[selector] ?? 0) === 0) {
      addFailure(failures, "privacy", "selector.mask-missing", `The mandatory ${selector} mask selector did not match the fixture.`, `Restore the missing ${selector} fixture marker before retrying preflight.`);
    }
  }
  if (!sameOrderedValues(input.blockSelectors, VS001_BOUNDARY_CONTRACT.blockSelectors)) {
    addFailure(failures, "privacy", "selector.block-list-mismatch", "The configured block-selector list has drifted.", "Restore [data-remo-block], iframe, and canvas as the approved block selectors.");
  }
  if ((input.selectorMatches["[data-remo-block]"] ?? 0) === 0) {
    addFailure(failures, "privacy", "selector.block-marker-missing", "The fixture block marker is missing.", "Restore one [data-remo-block] marker before retrying preflight.");
  }
  for (const selector of ["iframe", "canvas"] as const) {
    if ((input.selectorMatches[selector] ?? 0) > 0) {
      addFailure(failures, "privacy", "selector.blocked-content-present", `Blocked ${selector} content is present inside the fixture.`, `Remove the ${selector} from the fixture; blocked content cannot be captured.`);
    }
  }
  if (input.privacyCanary !== VS001_BOUNDARY_CONTRACT.privacyCanary) {
    addFailure(failures, "privacy", "privacy.canary-mismatch", "The required synthetic privacy canary is missing or changed.", "Restore REMO_SECRET_CANARY_V1 in the masked fixture fields.");
  }

  const expectedStateKeys = VS001_BOUNDARY_CONTRACT.stateKeys;
  const unknownStateKeys = input.stateKeys.filter((key) => !expectedStateKeys.includes(key as never));
  if (unknownStateKeys.length > 0) {
    addFailure(failures, "state", "state.unknown-key", `Unknown browser-state keys: ${unknownStateKeys.join(", ")}.`, "Remove unknown state keys; use only activePanel, selectedEvidenceId, detailsExpanded, viewportMode.");
  }
  const missingStateKeys = expectedStateKeys.filter((key) => !input.stateKeys.includes(key));
  if (missingStateKeys.length > 0) {
    addFailure(failures, "state", "state.required-key-missing", `Required browser-state keys are missing: ${missingStateKeys.join(", ")}.`, "Restore all four approved browser-state keys before retrying preflight.");
  }

  const expectedCommands = VS001_BOUNDARY_CONTRACT.commands;
  if (input.commands.some((command) => !expectedCommands.includes(command as never))) {
    addFailure(failures, "verification", "command.unapproved", "At least one verification command is outside the approved allowlist.", "Remove unapproved commands and restore the four @remo/vs001-fixture verification commands.");
  }
  if (expectedCommands.some((command) => !input.commands.includes(command))) {
    addFailure(failures, "verification", "command.required-missing", "At least one required fixture verification command is missing.", "Restore all four @remo/vs001-fixture verification commands.");
  }
  if (!sameViewport(input.captureViewport, VS001_BOUNDARY_CONTRACT.captureViewport)) {
    addFailure(failures, "verification", "viewport.capture-mismatch", "The selected capture viewport has drifted.", "Set the capture viewport to 1440 x 900 CSS pixels.");
  }
  if (!sameViewport(input.responsiveViewport, VS001_BOUNDARY_CONTRACT.responsiveViewport)) {
    addFailure(failures, "verification", "viewport.responsive-mismatch", "The responsive verification viewport has drifted.", "Set the responsive viewport to 390 x 844 CSS pixels.");
  }

  const labels: ReadonlyArray<readonly [PreflightCategory, string]> = [
    ["project", "Project scope"],
    ["source", "Source allowlist"],
    ["browser", "Browser scope"],
    ["privacy", "Privacy rules"],
    ["state", "Browser state"],
    ["verification", "Verification"],
    ["fixture", "Fixture identity"],
  ];
  const checks = labels.map(([category, label]) => {
    const failureCount = failures.filter((failure) => failure.category === category).length;
    return { category, label, status: failureCount === 0 ? "pass" as const : "fail" as const, failureCount };
  });

  return {
    ready: failures.length === 0,
    recordingState: "off",
    failures,
    checks,
    contract: VS001_BOUNDARY_CONTRACT,
  };
}
