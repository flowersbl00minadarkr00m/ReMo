import { canonicalSerialize, sha256Canonical } from "@remo/domain";
import { assertBranchPreflightReceipt, assertComparisonProjection, assertDecisionRecord, assertHistoryPage, type ComparisonProjection, type HistoryPage } from "@remo/domain/browser";
import type { BranchResult } from "../branch-preflight/branch-orchestration-client.js";
import type { DecisionProjection } from "../decision-card/decision-client.js";
import type { HistoryDetailSummary } from "../history-filmstrip/ReplayWorkspace.js";
import {
  HOSTED_DEMO_BRANCH_SAVE_POINT_ID,
  HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION,
  HOSTED_DEMO_COMPARISON_KEY,
  HOSTED_DEMO_COMPARISON_PAIR,
  compiledHostedDemoFixtureProjections,
  type HostedDemoCompiledFixtureProjections,
  type HostedDemoMediaManifestEntry,
} from "./hosted-demo-fixture-source.js";

export const HOSTED_DEMO_MANIFEST_PATH = "/hosted-demo/fixture-manifest.json";
export const HOSTED_DEMO_FIXTURE_PATH = "/hosted-demo/fixture.json";

export interface HostedDemoFixtureManifestEntry {
  readonly id: "fixture";
  readonly path: typeof HOSTED_DEMO_FIXTURE_PATH;
  readonly mediaType: "application/json";
  readonly byteLength: number;
  readonly digest: string;
}

export interface HostedDemoFixtureManifest {
  readonly schemaVersion: "remo.hosted-demo-manifest.v1";
  readonly fixtureRevision: string;
  readonly entries: readonly [HostedDemoFixtureManifestEntry];
}

export interface HostedDemoFixtureBundle {
  readonly schemaVersion: "remo.hosted-demo-fixture.v1";
  readonly fixtureRevision: string;
  readonly history: HistoryPage;
  readonly detailsBySavePointId: Readonly<Record<string, HistoryDetailSummary>>;
  readonly decisionsBySavePointId: Readonly<Record<string, DecisionProjection>>;
  readonly comparisonsByPair: Readonly<Record<string, ComparisonProjection>>;
  readonly preflight: ReturnType<typeof assertBranchPreflightReceipt>;
  readonly simulatedBranch: BranchResult;
  readonly media: readonly HostedDemoMediaManifestEntry[];
}

type HostedDemoFixtureCore = Pick<HostedDemoFixtureBundle, "schemaVersion" | "fixtureRevision" | "history" | "detailsBySavePointId">;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const FIXTURE_REVISION_PATTERN = /^rel001-fixture-[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const POSIX_PATH_PATTERN = /^\/(?!\/)/u;
const URL_PATTERN = /(?:https?|wss?):\/\//iu;
const PRIVATE_HOST_PATTERN = /(?:localhost|127(?:\.[0-9]{1,3}){3}|0\.0\.0\.0|\[?::1\]?|10(?:\.[0-9]{1,3}){3}|192\.168(?:\.[0-9]{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]{1,3}){2})/iu;
const CREDENTIAL_KEY_SUFFIXES = ["password", "passphrase", "secret", "secrets", "credential", "credentials", "token", "apikey", "privatekey"] as const;
const CREDENTIAL_VALUE_PATTERN = /(?:gh[opusr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-proj-[A-Za-z0-9_-]{20,}|xoxb-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|Bearer\s+\S+|(?:password|api[_-]?key|secret|token)\s*[:=]\s*\S+)/iu;
const APPROVED_BUNDLE_PATHS = new Set([
  "/hosted-demo/turn-4-screenshot.png",
  "/hosted-demo/turn-4-rrweb.json",
  "/hosted-demo/turn-5-screenshot.png",
  "/fixture/save-point",
  "/api/save-points/demo-save-04/media/screenshot",
  "/api/save-points/demo-save-05/media/screenshot",
  "/replay/demo-save-04",
  "/replay/demo-save-05",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredentialKey(key: string): boolean {
  const normalized = key.replace(/[_-]/gu, "").toLowerCase();
  return CREDENTIAL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function assertSafeFixtureStrings(value: unknown, path = "fixture"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeFixtureStrings(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (isCredentialKey(key)) throw new TypeError(`Hosted demo fixture contains a credential-shaped field at ${path}.${key}.`);
      assertSafeFixtureStrings(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (WINDOWS_PATH_PATTERN.test(value) || (POSIX_PATH_PATTERN.test(value) && !APPROVED_BUNDLE_PATHS.has(value))) throw new TypeError(`Hosted demo fixture contains an absolute local path at ${path}.`);
  if (URL_PATTERN.test(value) || PRIVATE_HOST_PATTERN.test(value)) throw new TypeError(`Hosted demo fixture contains a forbidden URL or host at ${path}.`);
  if (CREDENTIAL_VALUE_PATTERN.test(value)) throw new TypeError(`Hosted demo fixture contains a credential-shaped value at ${path}.`);
}

function assertManifest(value: unknown): HostedDemoFixtureManifest {
  if (!isRecord(value) || value.schemaVersion !== "remo.hosted-demo-manifest.v1" || !FIXTURE_REVISION_PATTERN.test(String(value.fixtureRevision)) || !Array.isArray(value.entries) || value.entries.length !== 1) {
    throw new TypeError("Hosted demo fixture manifest schema is invalid.");
  }
  const entry: unknown = value.entries[0];
  if (!isRecord(entry) || entry.id !== "fixture" || entry.path !== HOSTED_DEMO_FIXTURE_PATH || entry.mediaType !== "application/json" || !Number.isSafeInteger(entry.byteLength) || Number(entry.byteLength) < 1 || !SHA256_PATTERN.test(String(entry.digest))) {
    throw new TypeError("Hosted demo fixture manifest entry is invalid.");
  }
  return value as unknown as HostedDemoFixtureManifest;
}

function isHistoryDetail(value: unknown): value is HistoryDetailSummary {
  if (!isRecord(value) || typeof value.savePointId !== "string" || typeof value.turnId !== "string" || typeof value.nominationReason !== "string" || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !SHA256_PATTERN.test(String(value.manifestDigest)) || !Array.isArray(value.components)) return false;
  if (!value.components.every((component) => isRecord(component) && typeof component.type === "string" && typeof component.availability === "string")) return false;
  return isRecord(value.integrity) && typeof value.integrity.state === "string" && isRecord(value.fidelity) && typeof value.fidelity.state === "string";
}

function assertFixtureCore(value: unknown): HostedDemoFixtureCore {
  if (!isRecord(value) || value.schemaVersion !== "remo.hosted-demo-fixture.v1" || !FIXTURE_REVISION_PATTERN.test(String(value.fixtureRevision)) || !isRecord(value.history) || !isRecord(value.detailsBySavePointId)) {
    throw new TypeError("Hosted demo fixture schema is invalid.");
  }
  const history = assertHistoryPage(value.history as unknown as HistoryPage);
  const ordered = [...history.anchors].sort((left, right) => left.sequenceNo - right.sequenceNo);
  if (ordered.length !== 10 || ordered.some((anchor, index) => anchor.sequenceNo !== index + 1 || anchor.lineageId !== "lineage:original") || ordered.filter(({ state }) => state === "tombstone").length !== 1) {
    throw new TypeError("Hosted demo fixture must contain exactly ten chronological original-lineage anchors and one safe tombstone.");
  }
  const active = ordered.filter(({ state }) => state === "active");
  const details = value.detailsBySavePointId;
  if (Object.keys(details).length !== active.length) throw new TypeError("Hosted demo detail coverage does not match active fixture identities.");
  for (const anchor of active) {
    const detail = details[anchor.savePointId];
    if (!isHistoryDetail(detail) || detail.savePointId !== anchor.savePointId || detail.turnId !== anchor.turnId || detail.nominationReason !== anchor.nominationReason) {
      throw new TypeError("Hosted demo detail identity does not match its history anchor.");
    }
  }
  assertSafeFixtureStrings(value);
  return value as unknown as HostedDemoFixtureCore;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function activeIdentity(fixture: HostedDemoFixtureCore, savePointId: string, turnId: string): boolean {
  return fixture.history.anchors.some((anchor) => anchor.state === "active" && anchor.savePointId === savePointId && anchor.turnId === turnId)
    && fixture.detailsBySavePointId[savePointId]?.turnId === turnId;
}

function assertCompiledProjections(fixture: HostedDemoFixtureCore, value: unknown): HostedDemoCompiledFixtureProjections {
  if (!isRecord(value) || value.fixtureRevision !== fixture.fixtureRevision || !Array.isArray(value.media) || !isRecord(value.decisionsBySavePointId) || !isRecord(value.comparisonsByPair)) {
    fail("Hosted demo compiled fixture projections are invalid.");
  }

  const media = value.media as unknown as readonly HostedDemoMediaManifestEntry[];
  if (media.length !== 3) fail("Hosted demo media inventory is invalid.");
  const expectedComponents = ["demo-turn-04:screenshot", "demo-turn-04:rrweb", "demo-turn-05:screenshot"];
  if (media.map(({ componentId }) => componentId).join("\u0000") !== expectedComponents.join("\u0000")) fail("Hosted demo media inventory identity is invalid.");
  const paths = new Set<string>();
  for (const entry of media) {
    if (!isRecord(entry) || !activeIdentity(fixture, entry.savePointId, entry.turnId) || fixture.detailsBySavePointId[entry.savePointId]?.manifestDigest !== entry.manifestDigest || !SHA256_PATTERN.test(entry.digest) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 1 || !APPROVED_BUNDLE_PATHS.has(entry.path) || paths.has(entry.path)) fail("Hosted demo media binding is invalid.");
    paths.add(entry.path);
    if (entry.kind === "screenshot" && (entry.mediaType !== "image/png" || entry.width !== 1_440 || entry.height !== 900)) fail("Hosted demo screenshot metadata is invalid.");
    if (entry.kind === "replay" && (entry.mediaType !== "application/json" || entry.eventCount !== 4 || entry.viewport.width !== 1_440 || entry.viewport.height !== 900 || entry.durationMs !== entry.endTime - entry.startTime)) fail("Hosted demo replay metadata is invalid.");
  }

  if (Object.keys(value.decisionsBySavePointId).join("\u0000") !== HOSTED_DEMO_COMPARISON_PAIR.left) fail("Hosted demo decision inventory is invalid.");
  const decisionValue = value.decisionsBySavePointId[HOSTED_DEMO_COMPARISON_PAIR.left];
  if (!isRecord(decisionValue) || !Array.isArray(decisionValue.revisions)) fail("Hosted demo decision projection is invalid.");
  const current = assertDecisionRecord(decisionValue.current);
  const revisions = decisionValue.revisions.map(assertDecisionRecord);
  if (current.savePointId !== HOSTED_DEMO_COMPARISON_PAIR.left || current.turnId !== "demo-turn-04" || revisions.length !== 1 || revisions[0]?.digest !== current.digest || current.question.value === undefined || current.options.value === undefined || current.selectedOptionId.value === undefined || current.owner.value === undefined || current.outcome.provenance !== "unknown" || current.uncertainty.value?.level !== "low" || current.uncertainty.value.source !== "human" || current.uncertainty.provenance !== "user-supplied") fail("Hosted demo decision evidence is invalid.");
  const expectedEvidence = ["demo-turn-04:rrweb", "demo-turn-04:screenshot"];
  if (current.evidenceComponentIds.join("\u0000") !== expectedEvidence.join("\u0000")) fail("Hosted demo decision media binding is invalid.");

  if (Object.keys(value.comparisonsByPair).join("\u0000") !== HOSTED_DEMO_COMPARISON_KEY) fail("Hosted demo comparison inventory is invalid.");
  const comparison = assertComparisonProjection(value.comparisonsByPair[HOSTED_DEMO_COMPARISON_KEY]);
  if (comparison.left.savePointId !== HOSTED_DEMO_COMPARISON_PAIR.left || comparison.left.turnId !== "demo-turn-04" || comparison.right.savePointId !== HOSTED_DEMO_COMPARISON_PAIR.right || comparison.right.turnId !== "demo-turn-05" || comparison.parityClaimAllowed || !comparison.qualifiers.some(({ severity }) => severity === "blocks-equivalence")) fail("Hosted demo comparison identity or qualification is invalid.");
  for (const side of [comparison.left, comparison.right]) {
    const expected = media.find(({ kind, savePointId }) => kind === "screenshot" && savePointId === side.savePointId);
    if (expected === undefined || side.screenshot.availability !== "available" || side.screenshot.componentId !== expected.componentId || side.screenshot.digest !== expected.digest || side.screenshot.width !== expected.width || side.screenshot.height !== expected.height) fail("Hosted demo comparison screenshot binding is invalid.");
  }

  const preflight = assertBranchPreflightReceipt(value.preflight);
  if (!preflight.ready || preflight.savePointId !== HOSTED_DEMO_BRANCH_SAVE_POINT_ID || preflight.savePointRevision !== HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION || preflight.checks.length !== 10 || preflight.checks.some(({ state }) => state !== "pass")) fail("Hosted demo preflight projection is invalid.");
  const branch = value.simulatedBranch;
  if (!isRecord(branch) || branch.schemaVersion !== "remo.branch-result.v1" || branch.operationId !== preflight.target.operationId || branch.savePointId !== preflight.savePointId || branch.savePointRevision !== preflight.savePointRevision || branch.preflightDigest !== preflight.digest || branch.state !== "succeeded" || branch.lineageId !== "lineage:simulated-alternate" || branch.branchRef !== preflight.target.branchRef || branch.worktreeRelativePath !== preflight.target.worktreeRelativePath || !Array.isArray(branch.reasonCodes) || branch.reasonCodes.length !== 0) fail("Hosted demo simulated branch projection is invalid.");

  const projections: HostedDemoCompiledFixtureProjections = {
    fixtureRevision: fixture.fixtureRevision as HostedDemoCompiledFixtureProjections["fixtureRevision"],
    media,
    decisionsBySavePointId: { [HOSTED_DEMO_COMPARISON_PAIR.left]: { current, revisions } },
    comparisonsByPair: { [HOSTED_DEMO_COMPARISON_KEY]: comparison },
    preflight,
    simulatedBranch: branch as unknown as BranchResult,
  };
  assertSafeFixtureStrings(projections);
  if (canonicalSerialize(projections) !== canonicalSerialize(compiledHostedDemoFixtureProjections())) fail("Hosted demo compiled fixture authority does not match the immutable revision.");
  return projections;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${label} JSON is invalid.`);
  }
}

export function validateHostedDemoFixture(manifestValue: unknown, fixtureText: string, projectionValue: unknown = compiledHostedDemoFixtureProjections()): HostedDemoFixtureBundle {
  const manifest = assertManifest(manifestValue);
  const fixtureValue = parseJson(fixtureText, "Hosted demo fixture");
  const fixture = assertFixtureCore(fixtureValue);
  const entry = manifest.entries[0];
  const canonical = canonicalSerialize(fixtureValue);
  if (manifest.fixtureRevision !== fixture.fixtureRevision) throw new TypeError("Hosted demo fixture revision does not match its manifest.");
  if (fixtureText !== canonical) throw new TypeError("Hosted demo fixture bytes are not in canonical JSON form.");
  if (entry.byteLength !== new TextEncoder().encode(fixtureText).byteLength) throw new TypeError("Hosted demo fixture byte length does not match its manifest.");
  if (entry.digest !== sha256Canonical(fixtureValue)) throw new TypeError("Hosted demo fixture digest does not match its manifest.");
  const projections = assertCompiledProjections(fixture, projectionValue);
  return immutableClone({ ...fixture, ...projections });
}

async function readJsonTextResponse(response: Response, label: string): Promise<string> {
  if (!response.ok) throw new Error(`${label} is unavailable.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new TypeError(`${label} media type is invalid.`);
  return await response.text();
}

const staticRequest = (signal?: AbortSignal): RequestInit => ({
  method: "GET",
  credentials: "omit",
  mode: "same-origin",
  redirect: "error",
  referrerPolicy: "no-referrer",
  ...(signal === undefined ? {} : { signal }),
});

export async function loadHostedDemoFixture(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<HostedDemoFixtureBundle> {
  const manifestText = await readJsonTextResponse(await fetcher(HOSTED_DEMO_MANIFEST_PATH, staticRequest(signal)), "Hosted demo fixture manifest");
  const manifestValue = parseJson(manifestText, "Hosted demo fixture manifest");
  const manifest = assertManifest(manifestValue);
  const fixtureText = await readJsonTextResponse(await fetcher(manifest.entries[0].path, staticRequest(signal)), "Hosted demo fixture");
  return validateHostedDemoFixture(manifest, fixtureText);
}
