export const COMPARISON_SCHEMA_VERSION = "remo.comparison.v1" as const;

export type ComparisonRole = "before" | "after";
export type ComparisonSideState = "available" | "missing" | "deleted" | "unavailable";
export type ComparisonQualifierCode = "route" | "viewport" | "fixture" | "dependency" | "policy" | "integrity" | "fidelity" | "evidence";

export interface ComparisonContext {
  readonly route: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly fixture: string;
  readonly dependencyDigest: string;
  readonly policyRevisions: Readonly<Record<"capture" | "privacy" | "integrity" | "fidelity", string>>;
  readonly lineageId: string;
  readonly provenance: "observed" | "fixture-contract";
}

export interface ComparisonDecisionSummary {
  readonly state: "available" | "unknown" | "unavailable";
  readonly question?: string;
  readonly selectedOption?: string;
  readonly provenance?: "observed" | "user-supplied" | "inferred" | "reconstructed" | "unknown";
  readonly revision?: number;
}

export interface ComparisonSideInput {
  readonly savePointId: string;
  readonly turnId?: string;
  readonly displayId?: string;
  readonly state: ComparisonSideState;
  readonly revision?: number;
  readonly manifestDigest?: string;
  readonly screenshot:
    | { readonly availability: "available"; readonly reference: string; readonly componentId: string; readonly digest: string; readonly width: number; readonly height: number }
    | { readonly availability: "missing" | "unavailable" };
  readonly source: { readonly state: "available" | "unknown" | "unavailable"; readonly summary: string; readonly authorityMode?: "fixture" | "live" };
  readonly decision: ComparisonDecisionSummary;
  readonly verification: { readonly state: "available" | "unknown" | "unavailable"; readonly summary: string; readonly provenance?: string };
  readonly integrity: { readonly state: "complete" | "incomplete" | "inconsistent" | "unavailable"; readonly explanation: string };
  readonly fidelity: { readonly state: "editable-eligible" | "degraded" | "historical-only" | "unavailable"; readonly explanation: string };
  readonly context?: ComparisonContext;
  readonly replayPath?: string;
}

export interface ComparisonSide extends ComparisonSideInput { readonly role: ComparisonRole }

export interface ComparisonProjection {
  readonly schemaVersion: typeof COMPARISON_SCHEMA_VERSION;
  readonly left: ComparisonSide;
  readonly right: ComparisonSide;
  readonly qualifiers: readonly { readonly code: ComparisonQualifierCode; readonly severity: "note" | "blocks-equivalence"; readonly explanation: string }[];
  readonly parityClaimAllowed: boolean;
}

export class ComparisonValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ComparisonValidationError"; }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u;
const mismatch = (code: ComparisonQualifierCode, explanation: string) => ({ code, severity: "blocks-equivalence" as const, explanation });
const samePolicies = (left: ComparisonContext["policyRevisions"], right: ComparisonContext["policyRevisions"]): boolean => left.capture === right.capture && left.privacy === right.privacy && left.integrity === right.integrity && left.fidelity === right.fidelity;
const screenshotContextBound = (side: ComparisonSideInput): boolean => side.screenshot.availability !== "available" || side.context === undefined
  ? false
  : side.screenshot.width === side.context.viewport.width && side.screenshot.height === side.context.viewport.height;
const unavailableValue = (value: string): boolean => ["unknown", "unavailable"].includes(value.trim().toLocaleLowerCase("en-US"));
const contextEvidenceAvailable = (context: ComparisonContext): boolean =>
  !unavailableValue(context.fixture)
  && !unavailableValue(context.lineageId)
  && DIGEST.test(context.dependencyDigest)
  && Object.values(context.policyRevisions).every((value) => !unavailableValue(value));

type UnknownRecord = Record<string, unknown>;
const SIDE_KEYS = ["savePointId", "turnId", "displayId", "state", "revision", "manifestDigest", "screenshot", "source", "decision", "verification", "integrity", "fidelity", "context", "replayPath"] as const;

function record(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ComparisonValidationError("comparison.projection-invalid", `${label} must be an object.`);
  const result = value as UnknownRecord;
  if (Object.keys(result).some((key) => !keys.includes(key))) throw new ComparisonValidationError("comparison.projection-invalid", `${label} contains an unknown field.`);
  return result;
}

function text(value: unknown, label: string, maximum = 2_048): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new ComparisonValidationError("comparison.projection-invalid", `${label} must be a bounded non-empty string.`);
  return value;
}

function optionalText(value: unknown, label: string, maximum = 2_048): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum);
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ComparisonValidationError("comparison.projection-invalid", `${label} is invalid.`);
  return value as T;
}

function positiveInteger(value: unknown, label: string, maximum = 16_384): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new ComparisonValidationError("comparison.projection-invalid", `${label} is outside the supported bound.`);
  return Number(value);
}

function parseContext(value: unknown): ComparisonContext | undefined {
  if (value === undefined) return undefined;
  const context = record(value, ["route", "viewport", "fixture", "dependencyDigest", "policyRevisions", "lineageId", "provenance"], "Comparison context");
  const viewport = record(context.viewport, ["width", "height"], "Comparison viewport");
  const policies = record(context.policyRevisions, ["capture", "privacy", "integrity", "fidelity"], "Comparison policies");
  const route = text(context.route, "Comparison route", 512);
  if (!route.startsWith("/")) throw new ComparisonValidationError("comparison.projection-invalid", "Comparison route must be absolute within the captured origin.");
  const dependencyDigest = text(context.dependencyDigest, "Dependency digest", 128);
  if (dependencyDigest !== "unavailable" && !DIGEST.test(dependencyDigest)) throw new ComparisonValidationError("comparison.projection-invalid", "Dependency digest is invalid.");
  return {
    route,
    viewport: { width: positiveInteger(viewport.width, "Viewport width"), height: positiveInteger(viewport.height, "Viewport height") },
    fixture: text(context.fixture, "Fixture identity", 256),
    dependencyDigest,
    policyRevisions: {
      capture: text(policies.capture, "Capture policy", 128),
      privacy: text(policies.privacy, "Privacy policy", 128),
      integrity: text(policies.integrity, "Integrity policy", 128),
      fidelity: text(policies.fidelity, "Fidelity policy", 128),
    },
    lineageId: text(context.lineageId, "Lineage identity", 256),
    provenance: member(context.provenance, ["observed", "fixture-contract"], "Context provenance"),
  };
}

function parseScreenshot(value: unknown): ComparisonSideInput["screenshot"] {
  const initial = record(value, ["availability", "reference", "componentId", "digest", "width", "height"], "Screenshot summary");
  const availability = member(initial.availability, ["available", "missing", "unavailable"], "Screenshot availability");
  if (availability !== "available") {
    record(value, ["availability"], "Unavailable screenshot summary");
    return { availability };
  }
  const reference = text(initial.reference, "Screenshot reference", 512);
  const componentId = text(initial.componentId, "Screenshot component identity", 256);
  const digest = text(initial.digest, "Screenshot digest", 80);
  if (!reference.startsWith("/api/save-points/") || !reference.endsWith("/media/screenshot") || !COMPONENT_ID.test(componentId) || !DIGEST.test(digest)) throw new ComparisonValidationError("comparison.projection-invalid", "Authenticated screenshot metadata is invalid.");
  return { availability, reference, componentId, digest, width: positiveInteger(initial.width, "Screenshot width"), height: positiveInteger(initial.height, "Screenshot height") };
}

function parseSide(value: unknown, expectedRole?: ComparisonRole): ComparisonSideInput | ComparisonSide {
  const side = record(value, expectedRole === undefined ? SIDE_KEYS : [...SIDE_KEYS, "role"], "Comparison side");
  const savePointId = text(side.savePointId, "Save-point identity", 128);
  if (!ID.test(savePointId)) throw new ComparisonValidationError("comparison.identity-invalid", "Comparison identities are malformed.");
  const source = record(side.source, ["state", "summary", "authorityMode"], "Source summary");
  const decision = record(side.decision, ["state", "question", "selectedOption", "provenance", "revision"], "Decision summary");
  const verification = record(side.verification, ["state", "summary", "provenance"], "Verification summary");
  const integrity = record(side.integrity, ["state", "explanation"], "Integrity summary");
  const fidelity = record(side.fidelity, ["state", "explanation"], "Fidelity summary");
  const role = expectedRole === undefined ? undefined : member(side.role, [expectedRole], "Comparison role");
  const revision = side.revision === undefined ? undefined : positiveInteger(side.revision, "Manifest revision", Number.MAX_SAFE_INTEGER);
  const manifestDigest = optionalText(side.manifestDigest, "Manifest digest", 80);
  if (manifestDigest !== undefined && !DIGEST.test(manifestDigest)) throw new ComparisonValidationError("comparison.projection-invalid", "Manifest digest is invalid.");
  const replayPath = optionalText(side.replayPath, "Replay path", 512);
  if (replayPath !== undefined && replayPath !== `/replay/${encodeURIComponent(savePointId)}`) throw new ComparisonValidationError("comparison.projection-invalid", "Replay path must be the exact internal route for this save point.");
  const result: ComparisonSideInput = {
    savePointId,
    ...(side.turnId === undefined ? {} : { turnId: text(side.turnId, "Turn identity", 128) }),
    ...(side.displayId === undefined ? {} : { displayId: text(side.displayId, "Display identity", 128) }),
    state: member(side.state, ["available", "missing", "deleted", "unavailable"], "Comparison side state"),
    ...(revision === undefined ? {} : { revision }),
    ...(manifestDigest === undefined ? {} : { manifestDigest }),
    screenshot: parseScreenshot(side.screenshot),
    source: {
      state: member(source.state, ["available", "unknown", "unavailable"], "Source state"),
      summary: text(source.summary, "Source summary"),
      ...(source.authorityMode === undefined ? {} : { authorityMode: member(source.authorityMode, ["fixture", "live"], "Source authority mode") }),
    },
    decision: {
      state: member(decision.state, ["available", "unknown", "unavailable"], "Decision state"),
      ...(decision.question === undefined ? {} : { question: text(decision.question, "Decision question") }),
      ...(decision.selectedOption === undefined ? {} : { selectedOption: text(decision.selectedOption, "Selected option") }),
      ...(decision.provenance === undefined ? {} : { provenance: member(decision.provenance, ["observed", "user-supplied", "inferred", "reconstructed", "unknown"], "Decision provenance") }),
      ...(decision.revision === undefined ? {} : { revision: positiveInteger(decision.revision, "Decision revision", Number.MAX_SAFE_INTEGER) }),
    },
    verification: {
      state: member(verification.state, ["available", "unknown", "unavailable"], "Verification state"),
      summary: text(verification.summary, "Verification summary"),
      ...(verification.provenance === undefined ? {} : { provenance: text(verification.provenance, "Verification provenance", 128) }),
    },
    integrity: { state: member(integrity.state, ["complete", "incomplete", "inconsistent", "unavailable"], "Integrity state"), explanation: text(integrity.explanation, "Integrity explanation") },
    fidelity: { state: member(fidelity.state, ["editable-eligible", "degraded", "historical-only", "unavailable"], "Fidelity state"), explanation: text(fidelity.explanation, "Fidelity explanation") },
    ...(side.context === undefined ? {} : { context: parseContext(side.context)! }),
    ...(replayPath === undefined ? {} : { replayPath }),
  };
  return role === undefined ? result : { ...result, role };
}

export function buildComparisonProjection(left: ComparisonSideInput, right: ComparisonSideInput): ComparisonProjection {
  const safeLeft = parseSide(left) as ComparisonSideInput;
  const safeRight = parseSide(right) as ComparisonSideInput;
  if (safeLeft.savePointId === safeRight.savePointId) throw new ComparisonValidationError("comparison.same-identity", "Choose two distinct save points before comparing.");
  const qualifiers: ComparisonProjection["qualifiers"][number][] = [];
  if (safeLeft.state !== "available" || safeRight.state !== "available") qualifiers.push(mismatch("evidence", "One comparison side is missing, deleted, or unavailable; no equivalence claim is supportable."));
  if (safeLeft.screenshot.availability !== "available" || safeRight.screenshot.availability !== "available") qualifiers.push(mismatch("evidence", "Both immutable screenshots are not safely available, so visual parity is not claimed."));
  if (safeLeft.integrity.state !== "complete" || safeRight.integrity.state !== "complete") qualifiers.push(mismatch("integrity", `Integrity must be complete on both sides; before is ${safeLeft.integrity.state} and after is ${safeRight.integrity.state}.`));
  if (safeLeft.fidelity.state !== "editable-eligible" || safeRight.fidelity.state !== "editable-eligible") qualifiers.push(mismatch("fidelity", `Fidelity must be editable-eligible on both sides; before is ${safeLeft.fidelity.state} and after is ${safeRight.fidelity.state}.`));
  if (safeLeft.source.state !== "available" || safeRight.source.state !== "available" || safeLeft.verification.state !== "available" || safeRight.verification.state !== "available") qualifiers.push(mismatch("evidence", "Required source and verification evidence must be available on both sides before parity may be claimed."));
  if (safeLeft.decision.state !== "available" || safeRight.decision.state !== "available") qualifiers.push(mismatch("evidence", `Required decision evidence must be available on both sides before parity may be claimed; before is ${safeLeft.decision.state} and after is ${safeRight.decision.state}.`));
  if (safeLeft.context === undefined || safeRight.context === undefined) qualifiers.push(mismatch("evidence", "Comparison context is unavailable on one or both sides."));
  else {
    if (!screenshotContextBound(safeLeft) || !screenshotContextBound(safeRight)) qualifiers.push(mismatch("evidence", "Each preserved comparison context must be bound to its own authenticated screenshot dimensions."));
    if (!contextEvidenceAvailable(safeLeft.context) || !contextEvidenceAvailable(safeRight.context)) qualifiers.push(mismatch("evidence", "Required dependency, policy, fixture, or lineage context is unavailable on one or both sides."));
    if (safeLeft.context.route !== safeRight.context.route) qualifiers.push(mismatch("route", `Capture routes differ: ${safeLeft.context.route} versus ${safeRight.context.route}.`));
    if (safeLeft.context.viewport.width !== safeRight.context.viewport.width || safeLeft.context.viewport.height !== safeRight.context.viewport.height) qualifiers.push(mismatch("viewport", `Captured viewports differ: ${safeLeft.context.viewport.width}x${safeLeft.context.viewport.height} versus ${safeRight.context.viewport.width}x${safeRight.context.viewport.height}.`));
    if (safeLeft.context.fixture !== safeRight.context.fixture) qualifiers.push(mismatch("fixture", `Fixture identities differ: ${safeLeft.context.fixture} versus ${safeRight.context.fixture}.`));
    if (safeLeft.context.dependencyDigest !== safeRight.context.dependencyDigest) qualifiers.push(mismatch("dependency", "Dependency evidence digests differ between the selected turns."));
    if (!samePolicies(safeLeft.context.policyRevisions, safeRight.context.policyRevisions)) qualifiers.push(mismatch("policy", "Capture, privacy, integrity, or fidelity policy revisions differ between the selected turns."));
    if (safeLeft.context.lineageId !== safeRight.context.lineageId) qualifiers.push(mismatch("evidence", `Lineage differs: ${safeLeft.context.lineageId} versus ${safeRight.context.lineageId}; cross-lineage equivalence is not claimed.`));
  }
  if (qualifiers.length === 0) qualifiers.push({ code: "evidence", severity: "note", explanation: "The preserved comparison context matches. This does not establish pixel, semantic, causal, or quality equivalence." });
  return { schemaVersion: COMPARISON_SCHEMA_VERSION, left: { ...safeLeft, role: "before" }, right: { ...safeRight, role: "after" }, qualifiers, parityClaimAllowed: qualifiers.every(({ severity }) => severity !== "blocks-equivalence") };
}

export function assertComparisonProjection(value: unknown): ComparisonProjection {
  const projection = record(value, ["schemaVersion", "left", "right", "qualifiers", "parityClaimAllowed"], "Comparison projection");
  if (projection.schemaVersion !== COMPARISON_SCHEMA_VERSION || typeof projection.parityClaimAllowed !== "boolean" || !Array.isArray(projection.qualifiers)) throw new ComparisonValidationError("comparison.projection-invalid", "Comparison projection shape is invalid.");
  const left = parseSide(projection.left, "before") as ComparisonSide;
  const right = parseSide(projection.right, "after") as ComparisonSide;
  const qualifiers = projection.qualifiers.map((value) => {
    const qualifier = record(value, ["code", "severity", "explanation"], "Comparison qualifier");
    return { code: member(qualifier.code, ["route", "viewport", "fixture", "dependency", "policy", "integrity", "fidelity", "evidence"], "Qualifier code"), severity: member(qualifier.severity, ["note", "blocks-equivalence"], "Qualifier severity"), explanation: text(qualifier.explanation, "Qualifier explanation") };
  });
  const parsed: ComparisonProjection = { schemaVersion: COMPARISON_SCHEMA_VERSION, left, right, qualifiers, parityClaimAllowed: projection.parityClaimAllowed };
  const { role: leftRole, ...leftInput } = left;
  const { role: rightRole, ...rightInput } = right;
  void leftRole;
  void rightRole;
  const rebuilt = buildComparisonProjection(leftInput, rightInput);
  if (JSON.stringify(rebuilt) !== JSON.stringify(parsed)) throw new ComparisonValidationError("comparison.projection-invalid", "Comparison projection is not the canonical qualified result.");
  return rebuilt;
}
