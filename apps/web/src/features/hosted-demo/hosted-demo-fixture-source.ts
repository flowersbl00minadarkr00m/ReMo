import {
  buildComparisonProjection,
  buildDecisionRecord,
  deriveBranchPreflightIdentity,
  evaluateBranchPreflight,
  type BranchPreflightInput,
  type BranchPreflightReceipt,
  type ComparisonProjection,
  type ComparisonSideInput,
  type DecisionField,
} from "@remo/domain/browser";
import type { BranchResult } from "../branch-preflight/branch-orchestration-client.js";
import type { DecisionProjection } from "../decision-card/decision-client.js";
import { HOSTED_REPLAY_FIXTURE_REVISION, HOSTED_REPLAY_MEDIA_ID } from "../../demo-replay-runtime/protocol.js";
import { HOSTED_DEMO_ALTERNATE_LINEAGE_ID } from "./hosted-demo-session.js";

export const HOSTED_DEMO_COMPARISON_PAIR = Object.freeze({ left: "demo-save-04", right: "demo-save-05" });
export const HOSTED_DEMO_COMPARISON_KEY = `${HOSTED_DEMO_COMPARISON_PAIR.left}::${HOSTED_DEMO_COMPARISON_PAIR.right}` as const;
export const HOSTED_DEMO_BRANCH_SAVE_POINT_ID = HOSTED_DEMO_COMPARISON_PAIR.left;
export const HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION = 1 as const;

const MANIFEST_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

export interface HostedDemoScreenshotManifestEntry {
  readonly kind: "screenshot";
  readonly id: string;
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly componentId: string;
  readonly path: string;
  readonly mediaType: "image/png";
  readonly byteLength: number;
  readonly digest: string;
  readonly width: number;
  readonly height: number;
}

export interface HostedDemoReplayManifestEntry {
  readonly kind: "replay";
  readonly id: typeof HOSTED_REPLAY_MEDIA_ID;
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly componentId: string;
  readonly path: string;
  readonly mediaType: "application/json";
  readonly byteLength: number;
  readonly digest: string;
  readonly eventCount: number;
  readonly viewport: Readonly<{ readonly width: number; readonly height: number }>;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
}

export type HostedDemoMediaManifestEntry = HostedDemoScreenshotManifestEntry | HostedDemoReplayManifestEntry;

const turnFourScreenshot: HostedDemoScreenshotManifestEntry = Object.freeze({
  kind: "screenshot",
  id: "turn-4-screenshot",
  savePointId: HOSTED_DEMO_COMPARISON_PAIR.left,
  turnId: "demo-turn-04",
  revision: 1,
  manifestDigest: MANIFEST_DIGEST,
  componentId: "demo-turn-04:screenshot",
  path: "/hosted-demo/turn-4-screenshot.png",
  mediaType: "image/png",
  byteLength: 28_543,
  digest: "sha256:c253b4ce698d68b277d7e5019f007cb834e9f3de433132d1678c04914d82880a",
  width: 1_440,
  height: 900,
});

const turnFourReplay: HostedDemoReplayManifestEntry = Object.freeze({
  kind: "replay",
  id: HOSTED_REPLAY_MEDIA_ID,
  savePointId: HOSTED_DEMO_COMPARISON_PAIR.left,
  turnId: "demo-turn-04",
  revision: 1,
  manifestDigest: MANIFEST_DIGEST,
  componentId: "demo-turn-04:rrweb",
  path: "/hosted-demo/turn-4-rrweb.json",
  mediaType: "application/json",
  byteLength: 5_143,
  digest: "sha256:735d63d268b1c35c0c698b430d7ae94dbe1a91bc19d00df67aa5e452a4453487",
  eventCount: 4,
  viewport: Object.freeze({ width: 1_440, height: 900 }),
  startTime: 1_787_080_893_999,
  endTime: 1_787_080_895_251,
  durationMs: 1_252,
});

export const HOSTED_DEMO_TURN_5_SCREENSHOT_MANIFEST: HostedDemoScreenshotManifestEntry = Object.freeze({
  kind: "screenshot",
  id: "turn-5-screenshot",
  savePointId: HOSTED_DEMO_COMPARISON_PAIR.right,
  turnId: "demo-turn-05",
  revision: 1,
  manifestDigest: MANIFEST_DIGEST,
  componentId: "demo-turn-05:screenshot",
  path: "/hosted-demo/turn-5-screenshot.png",
  mediaType: "image/png",
  byteLength: 36_983,
  digest: "sha256:5a01bad950efb54e6c91c5c27c350cc82d1a31e977c032013fc090ec6cf869ae",
  width: 1_440,
  height: 900,
});

// Runtime compatibility is a thin view over the same compiled media entries.
export const HOSTED_DEMO_MEDIA_MANIFEST = Object.freeze({
  schemaVersion: "remo.hosted-demo-media-manifest.v1" as const,
  fixtureRevision: HOSTED_REPLAY_FIXTURE_REVISION,
  identity: Object.freeze({
    savePointId: turnFourScreenshot.savePointId,
    turnId: turnFourScreenshot.turnId,
    revision: turnFourScreenshot.revision,
    manifestDigest: turnFourScreenshot.manifestDigest,
  }),
  screenshot: turnFourScreenshot,
  replay: turnFourReplay,
});

const stamp = "2026-08-20T12:04:00.000Z";
const decisionQuestion = "Should the navigation hierarchy change at this boundary?";
const supplied = <T,>(value: T, sourceComponentIds: readonly string[] = []): DecisionField<T> => ({ value, provenance: "user-supplied", sourceComponentIds, recordedAt: stamp });
const inferred = (value: string, sourceComponentIds: readonly string[]): DecisionField<string> => ({ value, provenance: "inferred", sourceComponentIds, recordedAt: stamp });
const unknown = <T,>(): DecisionField<T> => ({ provenance: "unknown", sourceComponentIds: [], recordedAt: stamp });

const decision = buildDecisionRecord({
  decisionId: "decision-turn-04",
  savePointId: HOSTED_DEMO_COMPARISON_PAIR.left,
  turnId: "demo-turn-04",
  revision: 1,
  question: supplied(decisionQuestion),
  options: supplied([
    { id: "adopt", label: "Adopt the revised hierarchy" },
    { id: "retain", label: "Keep the prior hierarchy" },
  ]),
  selectedOptionId: supplied("adopt"),
  owner: supplied("UI supervisor"),
  uncertainty: supplied({ level: "low", source: "human" }),
  evidenceComponentIds: [turnFourReplay.componentId, turnFourScreenshot.componentId],
  expectedEffect: inferred("The revised hierarchy should make the primary destination easier to find.", [turnFourScreenshot.componentId]),
  verification: supplied("Verify keyboard order, responsive layout, and the selected destination.", [turnFourReplay.componentId]),
  outcome: unknown<string>(),
});

const comparisonContext = Object.freeze({
  route: "/fixture/save-point",
  viewport: Object.freeze({ width: 1_440, height: 900 }),
  fixture: "vs001-fixture-v1",
  dependencyDigest: MANIFEST_DIGEST,
  policyRevisions: Object.freeze({ capture: "capture-v2", privacy: "privacy-v1", integrity: "integrity-v1", fidelity: "fidelity-v2" }),
  lineageId: "lineage:original",
  provenance: "fixture-contract" as const,
});

const comparisonSide = (role: "before" | "after"): ComparisonSideInput => {
  const before = role === "before";
  const savePointId = before ? HOSTED_DEMO_COMPARISON_PAIR.left : HOSTED_DEMO_COMPARISON_PAIR.right;
  const turnId = before ? "demo-turn-04" : "demo-turn-05";
  const screenshot = before ? turnFourScreenshot : HOSTED_DEMO_TURN_5_SCREENSHOT_MANIFEST;
  return {
    savePointId,
    turnId,
    displayId: before ? "Turn 4" : "Turn 5",
    state: "available",
    revision: 1,
    manifestDigest: MANIFEST_DIGEST,
    screenshot: { availability: "available", reference: `/api/save-points/${savePointId}/media/screenshot`, componentId: screenshot.componentId, digest: screenshot.digest, width: screenshot.width, height: screenshot.height },
    source: { state: "available", summary: before ? "The synthetic scenario preserves the revised navigation hierarchy source." : "The synthetic scenario preserves the following responsive-panel source change.", authorityMode: "fixture" },
    decision: before
      ? { state: "available", question: decisionQuestion, selectedOption: "Adopt the revised hierarchy", provenance: decision.selectedOptionId.provenance, revision: decision.revision }
      : { state: "unknown" },
    verification: { state: "available", summary: "The committed fixture passed privacy clearance and exact screenshot binding.", provenance: "fixture-contract" },
    integrity: { state: "incomplete", explanation: "The hosted fixture preserves bounded evidence without claiming complete local authority." },
    fidelity: { state: "degraded", explanation: "The hosted screenshot is historical synthetic evidence, not editable local state." },
    context: comparisonContext,
    replayPath: `/replay/${savePointId}`,
  };
};

const digestB = `sha256:${"b".repeat(64)}`;
const available = { state: "available" as const };
const target = deriveBranchPreflightIdentity(HOSTED_DEMO_BRANCH_SAVE_POINT_ID, HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION);
const preflightInput: BranchPreflightInput = {
  savePointId: HOSTED_DEMO_BRANCH_SAVE_POINT_ID,
  requestedSavePointId: HOSTED_DEMO_BRANCH_SAVE_POINT_ID,
  savePointRevision: HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION,
  requestedSavePointRevision: HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION,
  lifecycleState: "active",
  integrityState: "complete",
  fidelityState: "editable-eligible",
  privacyPassed: true,
  evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: digestB, evidenceDigest: digestB })),
  sourceCommit: "d".repeat(40),
  sourceCommitExists: true,
  repository: { gitAvailable: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true },
  reproducibility: { route: "/replay/demo-save-04", expectedRoute: "/replay/demo-save-04", fixture: HOSTED_REPLAY_FIXTURE_REVISION, expectedFixture: HOSTED_REPLAY_FIXTURE_REVISION, viewport: "hosted-demo", expectedViewport: "hosted-demo", dependencyDigest: digestB, expectedDependencyDigest: digestB, policyDigest: digestB, expectedPolicyDigest: digestB },
  target: { ...target, refAbsent: true, pathAbsent: true },
  operationActive: false,
  checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false },
  originalLineageId: "lineage:original",
  originalFuture: { branchRef: "refs/heads/main", head: "d".repeat(40), statusDigest: digestB, indexDigest: digestB, approvedSourceDigest: digestB, availability: { status: available, index: available, approvedSource: available, capture: available } },
  inspectorReasonCodes: [],
};

const preflight = evaluateBranchPreflight(preflightInput, new Date("2030-01-01T00:00:00.000Z"));
const simulatedBranch: BranchResult = {
  schemaVersion: "remo.branch-result.v1",
  operationId: preflight.target.operationId,
  savePointId: HOSTED_DEMO_BRANCH_SAVE_POINT_ID,
  savePointRevision: HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION,
  preflightDigest: preflight.digest,
  displayLabel: "Simulated alternate from Turn 4",
  state: "succeeded",
  reasonCodes: [],
  branchRef: preflight.target.branchRef,
  worktreeRelativePath: preflight.target.worktreeRelativePath,
  lineageId: HOSTED_DEMO_ALTERNATE_LINEAGE_ID,
  updatedAt: "2026-08-20T12:04:30.000Z",
};

export interface HostedDemoCompiledFixtureProjections {
  readonly fixtureRevision: typeof HOSTED_REPLAY_FIXTURE_REVISION;
  readonly media: readonly HostedDemoMediaManifestEntry[];
  readonly decisionsBySavePointId: Readonly<Record<string, DecisionProjection>>;
  readonly comparisonsByPair: Readonly<Record<string, ComparisonProjection>>;
  readonly preflight: BranchPreflightReceipt;
  readonly simulatedBranch: BranchResult;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return value;
}

const compiledSource: HostedDemoCompiledFixtureProjections = deepFreeze({
  fixtureRevision: HOSTED_REPLAY_FIXTURE_REVISION,
  media: [turnFourScreenshot, turnFourReplay, HOSTED_DEMO_TURN_5_SCREENSHOT_MANIFEST],
  decisionsBySavePointId: { [HOSTED_DEMO_COMPARISON_PAIR.left]: { current: decision, revisions: [decision] } },
  comparisonsByPair: { [HOSTED_DEMO_COMPARISON_KEY]: buildComparisonProjection(comparisonSide("before"), comparisonSide("after")) },
  preflight,
  simulatedBranch,
});

export function compiledHostedDemoFixtureProjections(): HostedDemoCompiledFixtureProjections {
  return compiledSource;
}
