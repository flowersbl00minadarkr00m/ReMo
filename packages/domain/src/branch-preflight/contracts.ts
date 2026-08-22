import { sha256Canonical } from "../canonical.js";

export const BRANCH_PREFLIGHT_POLICY_REVISION = "remo.branch-preflight.v1" as const;
export const BRANCH_PREFLIGHT_CHECK_IDS = [
  "save-identity-revision-lifecycle",
  "integrity-fidelity",
  "privacy-correlated-evidence",
  "source-commit",
  "repository-boundaries",
  "reproducibility-inputs",
  "target-absence",
  "operation-idle",
  "checkout-safety",
  "original-future",
] as const;

export type BranchPreflightCheckId = (typeof BRANCH_PREFLIGHT_CHECK_IDS)[number];
export type BranchPreflightLifecycleState = "active" | "quarantined" | "expired" | "deleted" | "missing";

export interface BranchPreflightEvidenceInput {
  readonly componentType: string;
  readonly state: "available" | "blocked" | "not-evaluated";
  readonly correlationDigest: string;
  readonly evidenceDigest: string;
}

export interface DerivedBranchIdentity {
  readonly operationId: string;
  readonly branchRef: string;
  readonly worktreeRelativePath: string;
}

export interface BranchPreflightOriginalFuture {
  readonly branchRef: string;
  readonly head: string;
  readonly statusDigest: string;
  readonly indexDigest: string;
  readonly approvedSourceDigest: string;
  readonly availability: {
    readonly status: BranchPreflightCaptureAvailability;
    readonly index: BranchPreflightCaptureAvailability;
    readonly approvedSource: BranchPreflightCaptureAvailability;
    readonly capture: BranchPreflightCaptureAvailability;
  };
}

export interface BranchPreflightCaptureAvailability {
  readonly state: "available" | "unavailable";
  readonly reasonCode?: string;
}

export interface BranchPreflightInput {
  readonly savePointId: string;
  readonly requestedSavePointId: string;
  readonly savePointRevision: number;
  readonly requestedSavePointRevision: number;
  readonly lifecycleState: BranchPreflightLifecycleState;
  readonly integrityState: "complete" | "incomplete" | "inconsistent" | "quarantined";
  readonly fidelityState: "editable-eligible" | "historical-only" | "degraded" | "unavailable";
  readonly privacyPassed: boolean;
  readonly evidence: readonly BranchPreflightEvidenceInput[];
  readonly sourceCommit: string;
  readonly sourceCommitExists: boolean;
  readonly repository: {
    readonly gitAvailable: boolean;
    readonly canonicalRootSafe: boolean;
    readonly approvedSourceRootSafe: boolean;
    readonly commonDirectorySafe: boolean;
    readonly derivedWorktreeRootSafe: boolean;
    readonly ownershipSafe: boolean;
    readonly linksAbsent: boolean;
  };
  readonly reproducibility: {
    readonly route: string;
    readonly expectedRoute: string;
    readonly fixture: string;
    readonly expectedFixture: string;
    readonly viewport: string;
    readonly expectedViewport: string;
    readonly dependencyDigest: string;
    readonly expectedDependencyDigest: string;
    readonly policyDigest: string;
    readonly expectedPolicyDigest: string;
  };
  readonly target: DerivedBranchIdentity & { readonly refAbsent: boolean; readonly pathAbsent: boolean };
  readonly operationActive: boolean;
  readonly checkoutSafety: {
    readonly filtersActive: boolean;
    readonly hooksActive: boolean;
    readonly externalWorktreeConfig: boolean;
    readonly submodulesRequired: boolean;
    readonly unsafeOwnership: boolean;
    readonly fsmonitorConfigured?: boolean;
    readonly fsmonitorNeutralized?: boolean;
    readonly unsafeConfigOrigin?: boolean;
  };
  readonly originalLineageId: string;
  readonly originalFuture: BranchPreflightOriginalFuture;
  readonly inspectorReasonCodes: readonly string[];
}

export interface BranchPreflightCheck {
  readonly id: BranchPreflightCheckId;
  readonly name: string;
  readonly state: "pass" | "block";
  readonly explanation: string;
  readonly evidenceDigest: string;
  readonly reasonCode?: string;
  readonly recovery?: string;
}

export interface BranchPreflightReceipt {
  readonly preflightId: string;
  readonly savePointId: string;
  readonly savePointRevision: number;
  readonly sourceCommit: string;
  readonly originalLineageId: string;
  readonly originalFutureDigest: string;
  readonly inputDigest: string;
  readonly target: DerivedBranchIdentity;
  readonly checks: readonly BranchPreflightCheck[];
  readonly ready: boolean;
  readonly policyRevision: typeof BRANCH_PREFLIGHT_POLICY_REVISION;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly digest: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const REQUIRED_EVIDENCE = ["screenshot", "rrweb", "source", "dependencies", "lineage"] as const;

export function deriveBranchPreflightIdentity(savePointId: string, revision: number): DerivedBranchIdentity {
  if (!SAFE_ID.test(savePointId) || !Number.isSafeInteger(revision) || revision < 1) throw new TypeError("Branch identity requires a safe save-point ID and positive revision.");
  const stem = `${savePointId.toLocaleLowerCase("en-US")}-r${revision}`;
  const suffix = sha256Canonical({ savePointId, revision }).slice(-10);
  const identity = `${stem}-${suffix}`;
  const operationId = `branch-${identity}`;
  return { operationId, branchRef: `refs/heads/remo/${identity}`, worktreeRelativePath: `.remo/worktrees/${operationId}` };
}

const CHECK_COPY: Readonly<Record<BranchPreflightCheckId, { readonly name: string; readonly pass: string; readonly block: string; readonly recovery: string }>> = {
  "save-identity-revision-lifecycle": { name: "Save identity, revision, and lifecycle", pass: "The selected active save point still matches the requested identity and revision.", block: "The selected save point is missing, inactive, or no longer matches the requested identity and revision.", recovery: "Return to surviving history, select an active save point, and run a fresh preflight." },
  "integrity-fidelity": { name: "Integrity and editable fidelity", pass: "Integrity is complete and fidelity remains editable-eligible.", block: "Incomplete, inconsistent, quarantined, degraded, or historical-only evidence cannot become an editable branch.", recovery: "Restore complete correlated evidence and editable-eligible fidelity before retrying." },
  "privacy-correlated-evidence": { name: "Privacy and correlated evidence", pass: "Privacy passed and screenshot, replay, source, dependency, and lineage evidence are available and mutually correlated.", block: "Required privacy-cleared evidence is missing, unavailable, unbound, or inconsistently correlated.", recovery: "Repair the named evidence or privacy receipt, then run a fresh preflight." },
  "source-commit": { name: "Exact source commit", pass: "The exact bound source state exists as a Git commit object.", block: "The bound source state is absent, malformed, or unavailable from Git.", recovery: "Restore the exact source commit in the configured repository and retry." },
  "repository-boundaries": { name: "Repository and path boundaries", pass: "Repository, approved source, common Git directory, and derived worktree roots pass canonical ownership and no-link checks.", block: "A repository root, source root, common directory, ownership, or no-link boundary is unsafe.", recovery: "Restore canonical owned paths without links or reparse traversal before retrying." },
  "reproducibility-inputs": { name: "Supported reproducibility inputs", pass: "Route, fixture, viewport, dependency, and policy inputs match the supported branch fixture.", block: "A route, fixture, viewport, dependency, or policy input differs from the approved branch fixture.", recovery: "Use the approved fixture inputs and run a fresh preflight." },
  "target-absence": { name: "Derived target absence", pass: "The derived branch ref and operation worktree path are both absent.", block: "The derived branch ref or operation worktree path already exists.", recovery: "Do not reuse, reset, overwrite, or clean the collision; reconcile it before retrying." },
  "operation-idle": { name: "No active branch operation", pass: "No Git or ReMo branch operation is active.", block: "Another Git or ReMo branch operation is active or recovery is pending.", recovery: "Wait for or reconcile the active operation before retrying." },
  "checkout-safety": { name: "Hostile-safe checkout configuration", pass: "No active filter, hook, external worktree configuration, submodule checkout, or unsafe ownership condition can influence checkout.", block: "Checkout configuration exposes an active filter, hook, external worktree mode, submodule, or unsafe ownership condition.", recovery: "Remove the hostile checkout condition and rerun preflight; no checkout was attempted." },
  "original-future": { name: "Original future snapshot", pass: "Original branch ref, HEAD, index/status, and approved-source content are captured in one digest.", block: "The original future could not be captured as a complete authoritative snapshot.", recovery: "Restore an attached branch and readable source/index state, then run a fresh preflight." },
};

export function branchPreflightCheckName(id: BranchPreflightCheckId): string { return CHECK_COPY[id].name; }

function check(id: BranchPreflightCheckId, passed: boolean, evidence: unknown, reasonCode: string): BranchPreflightCheck {
  const copy = CHECK_COPY[id];
  return { id, name: copy.name, state: passed ? "pass" : "block", explanation: passed ? copy.pass : copy.block, evidenceDigest: sha256Canonical(evidence), ...(passed ? {} : { reasonCode, recovery: copy.recovery }) };
}

function firstInspectorReason(input: BranchPreflightInput, prefixes: readonly string[], fallback: string): string {
  return input.inspectorReasonCodes.find((reasonCode) => prefixes.some((prefix) => reasonCode.startsWith(prefix))) ?? fallback;
}

export function evaluateBranchPreflight(input: BranchPreflightInput, now = new Date()): BranchPreflightReceipt {
  if (!Number.isFinite(now.getTime())) throw new TypeError("Preflight evaluation time must be valid.");
  const expectedIdentity = deriveBranchPreflightIdentity(input.savePointId, input.savePointRevision);
  const correlationDigests = new Set(input.evidence.map(({ correlationDigest }) => correlationDigest));
  const evidenceByType = new Map(input.evidence.map((item) => [item.componentType, item]));
  const evidenceReady = input.privacyPassed && REQUIRED_EVIDENCE.every((type) => {
    const item = evidenceByType.get(type);
    return item?.state === "available" && DIGEST.test(item.correlationDigest) && DIGEST.test(item.evidenceDigest);
  }) && correlationDigests.size === 1;
  const repositoryReady = Object.values(input.repository).every(Boolean);
  const reproducibilityReady = input.reproducibility.route === input.reproducibility.expectedRoute && input.reproducibility.fixture === input.reproducibility.expectedFixture && input.reproducibility.viewport === input.reproducibility.expectedViewport && input.reproducibility.dependencyDigest === input.reproducibility.expectedDependencyDigest && input.reproducibility.policyDigest === input.reproducibility.expectedPolicyDigest;
  const checkoutReady = !input.checkoutSafety.filtersActive && !input.checkoutSafety.hooksActive && !input.checkoutSafety.externalWorktreeConfig && !input.checkoutSafety.submodulesRequired && !input.checkoutSafety.unsafeOwnership && input.checkoutSafety.unsafeConfigOrigin !== true && (input.checkoutSafety.fsmonitorConfigured !== true || input.checkoutSafety.fsmonitorNeutralized === true);
  const originalFutureReady = Object.values(input.originalFuture.availability).every(({ state }) => state === "available") && input.originalFuture.branchRef.startsWith("refs/heads/") && COMMIT.test(input.originalFuture.head) && DIGEST.test(input.originalFuture.statusDigest) && DIGEST.test(input.originalFuture.indexDigest) && DIGEST.test(input.originalFuture.approvedSourceDigest);
  const checks = [
    check(BRANCH_PREFLIGHT_CHECK_IDS[0], input.lifecycleState === "active" && input.savePointId === input.requestedSavePointId && input.savePointRevision === input.requestedSavePointRevision, { actual: [input.savePointId, input.savePointRevision, input.lifecycleState], requested: [input.requestedSavePointId, input.requestedSavePointRevision] }, "preflight.save-identity-revision-lifecycle"),
    check(BRANCH_PREFLIGHT_CHECK_IDS[1], input.integrityState === "complete" && input.fidelityState === "editable-eligible", { integrityState: input.integrityState, fidelityState: input.fidelityState }, "preflight.integrity-fidelity"),
    check(BRANCH_PREFLIGHT_CHECK_IDS[2], evidenceReady, { privacyPassed: input.privacyPassed, evidence: input.evidence }, "preflight.privacy-correlated-evidence"),
    check(BRANCH_PREFLIGHT_CHECK_IDS[3], COMMIT.test(input.sourceCommit) && input.sourceCommitExists, { sourceCommit: input.sourceCommit, sourceCommitExists: input.sourceCommitExists, gitAvailable: input.repository.gitAvailable }, firstInspectorReason(input, ["preflight.git-", "preflight.source-commit"], "preflight.source-commit")),
    check(BRANCH_PREFLIGHT_CHECK_IDS[4], repositoryReady, input.repository, firstInspectorReason(input, ["preflight.repository-root", "preflight.source-root", "preflight.common-directory", "preflight.worktree-root", "preflight.ownership"], "preflight.repository-boundaries")),
    check(BRANCH_PREFLIGHT_CHECK_IDS[5], reproducibilityReady, input.reproducibility, "preflight.reproducibility-inputs"),
    check(BRANCH_PREFLIGHT_CHECK_IDS[6], input.target.branchRef === expectedIdentity.branchRef && input.target.worktreeRelativePath === expectedIdentity.worktreeRelativePath && input.target.refAbsent && input.target.pathAbsent, input.target, firstInspectorReason(input, ["preflight.target-"], "preflight.target-collision")),
    check(BRANCH_PREFLIGHT_CHECK_IDS[7], !input.operationActive, { operationActive: input.operationActive }, firstInspectorReason(input, ["preflight.git-operation"], "preflight.operation-active")),
    check(BRANCH_PREFLIGHT_CHECK_IDS[8], checkoutReady, input.checkoutSafety, firstInspectorReason(input, ["preflight.filter", "preflight.attributes", "preflight.hook", "preflight.worktree-config", "preflight.submodule", "preflight.config-"], "preflight.checkout-unsafe")),
    check(BRANCH_PREFLIGHT_CHECK_IDS[9], originalFutureReady, input.originalFuture, input.originalFuture.availability.capture.reasonCode ?? "preflight.original-future-unavailable"),
  ] as const;
  const evaluatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30_000).toISOString();
  const originalFutureDigest = sha256Canonical(input.originalFuture);
  const inputDigest = sha256Canonical(input);
  const body = { preflightId: `preflight-${sha256Canonical({ inputDigest, evaluatedAt }).slice(-20)}`, savePointId: input.savePointId, savePointRevision: input.savePointRevision, sourceCommit: input.sourceCommit, originalLineageId: input.originalLineageId, originalFutureDigest, inputDigest, target: expectedIdentity, checks, ready: checks.every(({ state }) => state === "pass"), policyRevision: BRANCH_PREFLIGHT_POLICY_REVISION, evaluatedAt, expiresAt } as const;
  return { ...body, digest: sha256Canonical(body) };
}

export type BranchPreflightConfirmationBinding = { readonly now: Date; readonly savePointRevision: number; readonly originalFutureDigest: string; readonly policyRevision: string; readonly inputDigest: string };

export function validateBranchPreflightConfirmation(receipt: BranchPreflightReceipt, binding: BranchPreflightConfirmationBinding): { readonly valid: true } | { readonly valid: false; readonly reasonCode: string } {
  if (!receipt.ready) return { valid: false, reasonCode: "preflight.blocked" };
  if (binding.now.getTime() >= Date.parse(receipt.expiresAt)) return { valid: false, reasonCode: "preflight.expired" };
  if (binding.savePointRevision !== receipt.savePointRevision) return { valid: false, reasonCode: "preflight.save-revision-stale" };
  if (binding.originalFutureDigest !== receipt.originalFutureDigest) return { valid: false, reasonCode: "preflight.original-future-stale" };
  if (binding.policyRevision !== receipt.policyRevision) return { valid: false, reasonCode: "preflight.policy-stale" };
  if (binding.inputDigest !== receipt.inputDigest) return { valid: false, reasonCode: "preflight.input-stale" };
  return { valid: true };
}

export function assertBranchPreflightReceipt(value: unknown): BranchPreflightReceipt {
  if (typeof value !== "object" || value === null) throw new TypeError("Branch preflight receipt is malformed.");
  const receipt = value as Partial<BranchPreflightReceipt>;
  const checksValid = Array.isArray(receipt.checks) && receipt.checks.length === BRANCH_PREFLIGHT_CHECK_IDS.length && receipt.checks.every((candidate: unknown, index) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const item = candidate as Partial<BranchPreflightCheck>;
    return item.id === BRANCH_PREFLIGHT_CHECK_IDS[index] && (item.state === "pass" || item.state === "block") && typeof item.name === "string" && typeof item.explanation === "string" && DIGEST.test(item.evidenceDigest ?? "");
  });
  if (typeof receipt.preflightId !== "string" || typeof receipt.savePointId !== "string" || !Number.isSafeInteger(receipt.savePointRevision) || typeof receipt.sourceCommit !== "string" || typeof receipt.originalLineageId !== "string" || !DIGEST.test(receipt.originalFutureDigest ?? "") || !DIGEST.test(receipt.inputDigest ?? "") || !DIGEST.test(receipt.digest ?? "") || receipt.policyRevision !== BRANCH_PREFLIGHT_POLICY_REVISION || typeof receipt.evaluatedAt !== "string" || typeof receipt.expiresAt !== "string" || typeof receipt.ready !== "boolean" || !checksValid) throw new TypeError("Branch preflight receipt is malformed.");
  return receipt as BranchPreflightReceipt;
}
