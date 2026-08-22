import { describe, expect, it } from "vitest";
import {
  BRANCH_PREFLIGHT_CHECK_IDS,
  BRANCH_PREFLIGHT_POLICY_REVISION,
  deriveBranchPreflightIdentity,
  evaluateBranchPreflight,
  validateBranchPreflightConfirmation,
  type BranchPreflightInput,
} from "./contracts.js";

const SAVE_POINT_ID = "01J000000000000000000000S5";
const SOURCE_COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const AVAILABLE_CAPTURE = { state: "available" as const };

function passingInput(): BranchPreflightInput {
  const derived = deriveBranchPreflightIdentity(SAVE_POINT_ID, 3);
  return {
    savePointId: SAVE_POINT_ID,
    requestedSavePointId: SAVE_POINT_ID,
    savePointRevision: 3,
    requestedSavePointRevision: 3,
    lifecycleState: "active",
    integrityState: "complete",
    fidelityState: "editable-eligible",
    privacyPassed: true,
    evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: DIGEST, evidenceDigest: DIGEST })),
    sourceCommit: SOURCE_COMMIT,
    sourceCommitExists: true,
    repository: { gitAvailable: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true },
    reproducibility: {
      route: "/fixture/save-point", expectedRoute: "/fixture/save-point",
      fixture: "vs001-ui-sequence-v1", expectedFixture: "vs001-ui-sequence-v1",
      viewport: "1440x900", expectedViewport: "1440x900",
      dependencyDigest: DIGEST, expectedDependencyDigest: DIGEST,
      policyDigest: DIGEST, expectedPolicyDigest: DIGEST,
    },
    target: { ...derived, refAbsent: true, pathAbsent: true },
    operationActive: false,
    checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false },
    originalLineageId: "lineage:original",
    originalFuture: { branchRef: "refs/heads/main", head: SOURCE_COMMIT, statusDigest: DIGEST, indexDigest: DIGEST, approvedSourceDigest: DIGEST, availability: { status: AVAILABLE_CAPTURE, index: AVAILABLE_CAPTURE, approvedSource: AVAILABLE_CAPTURE, capture: AVAILABLE_CAPTURE } },
    inspectorReasonCodes: [],
  };
}

describe("branch preflight receipt", () => {
  it("returns all ten checks in canonical order and a stable 30-second canonical receipt", () => {
    const now = new Date("2026-08-19T17:30:00.000Z");
    const first = evaluateBranchPreflight(passingInput(), now);
    const second = evaluateBranchPreflight(passingInput(), now);

    expect(first.checks.map(({ id }) => id)).toEqual(BRANCH_PREFLIGHT_CHECK_IDS);
    expect(first.checks).toHaveLength(10);
    expect(first.checks.every(({ state, explanation, evidenceDigest }) => state === "pass" && explanation.length > 0 && evidenceDigest?.startsWith("sha256:") === true)).toBe(true);
    expect(first).toEqual(second);
    expect(first.policyRevision).toBe(BRANCH_PREFLIGHT_POLICY_REVISION);
    expect(first.evaluatedAt).toBe("2026-08-19T17:30:00.000Z");
    expect(first.expiresAt).toBe("2026-08-19T17:30:30.000Z");
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.preflightId).toMatch(/^preflight-[0-9a-f]{20}$/u);
    expect(first.target.branchRef).not.toContain(" ");
    expect(first.target.operationId).toMatch(/^branch-[a-z0-9-]+$/u);
    expect(first.target.worktreeRelativePath).toMatch(/^\.remo\/worktrees\/[a-z0-9-]+$/u);
    expect(first.target.worktreeRelativePath).toBe(`.remo/worktrees/${first.target.operationId}`);
  });

  it.each([
    ["save-identity-revision-lifecycle", (input: BranchPreflightInput) => ({ ...input, requestedSavePointRevision: 2 })],
    ["save-identity-revision-lifecycle", (input: BranchPreflightInput) => ({ ...input, lifecycleState: "quarantined" as const })],
    ["save-identity-revision-lifecycle", (input: BranchPreflightInput) => ({ ...input, lifecycleState: "expired" as const })],
    ["integrity-fidelity", (input: BranchPreflightInput) => ({ ...input, fidelityState: "historical-only" as const })],
    ["integrity-fidelity", (input: BranchPreflightInput) => ({ ...input, integrityState: "incomplete" as const })],
    ["privacy-correlated-evidence", (input: BranchPreflightInput) => ({ ...input, privacyPassed: false })],
    ["privacy-correlated-evidence", (input: BranchPreflightInput) => ({ ...input, evidence: input.evidence.map((item) => item.componentType === "dependencies" ? { ...item, state: "not-evaluated" as const } : item) })],
    ["privacy-correlated-evidence", (input: BranchPreflightInput) => ({ ...input, evidence: input.evidence.map((item) => item.componentType === "lineage" ? { ...item, correlationDigest: `sha256:${"c".repeat(64)}` } : item) })],
    ["source-commit", (input: BranchPreflightInput) => ({ ...input, sourceCommitExists: false })],
    ["repository-boundaries", (input: BranchPreflightInput) => ({ ...input, repository: { ...input.repository, ownershipSafe: false } })],
    ["reproducibility-inputs", (input: BranchPreflightInput) => ({ ...input, reproducibility: { ...input.reproducibility, dependencyDigest: `sha256:${"c".repeat(64)}` } })],
    ["reproducibility-inputs", (input: BranchPreflightInput) => ({ ...input, reproducibility: { ...input.reproducibility, route: "/unsupported" } })],
    ["reproducibility-inputs", (input: BranchPreflightInput) => ({ ...input, reproducibility: { ...input.reproducibility, fixture: "unsupported" } })],
    ["reproducibility-inputs", (input: BranchPreflightInput) => ({ ...input, reproducibility: { ...input.reproducibility, viewport: "390x844" } })],
    ["reproducibility-inputs", (input: BranchPreflightInput) => ({ ...input, reproducibility: { ...input.reproducibility, policyDigest: `sha256:${"c".repeat(64)}` } })],
    ["target-absence", (input: BranchPreflightInput) => ({ ...input, target: { ...input.target, refAbsent: false } })],
    ["target-absence", (input: BranchPreflightInput) => ({ ...input, target: { ...input.target, pathAbsent: false } })],
    ["operation-idle", (input: BranchPreflightInput) => ({ ...input, operationActive: true })],
    ["checkout-safety", (input: BranchPreflightInput) => ({ ...input, checkoutSafety: { ...input.checkoutSafety, filtersActive: true } })],
    ["checkout-safety", (input: BranchPreflightInput) => ({ ...input, checkoutSafety: { ...input.checkoutSafety, hooksActive: true } })],
    ["checkout-safety", (input: BranchPreflightInput) => ({ ...input, checkoutSafety: { ...input.checkoutSafety, externalWorktreeConfig: true } })],
    ["checkout-safety", (input: BranchPreflightInput) => ({ ...input, checkoutSafety: { ...input.checkoutSafety, submodulesRequired: true } })],
    ["checkout-safety", (input: BranchPreflightInput) => ({ ...input, checkoutSafety: { ...input.checkoutSafety, unsafeOwnership: true } })],
    ["checkout-safety", (input: BranchPreflightInput) => ({ ...input, checkoutSafety: { ...input.checkoutSafety, unsafeConfigOrigin: true } })],
    ["original-future", (input: BranchPreflightInput) => ({ ...input, originalFuture: { ...input.originalFuture, branchRef: "" } })],
    ["original-future", (input: BranchPreflightInput) => ({ ...input, originalFuture: { ...input.originalFuture, indexDigest: "unavailable" } })],
    ["original-future", (input: BranchPreflightInput) => ({ ...input, originalFuture: { ...input.originalFuture, statusDigest: DIGEST, availability: { ...input.originalFuture.availability, status: { state: "unavailable" as const, reasonCode: "preflight.status-unavailable" }, capture: { state: "unavailable" as const, reasonCode: "preflight.status-unavailable" } } }, inspectorReasonCodes: ["preflight.status-unavailable"] })],
  ] as const)("blocks the %s check without omitting any check", (id, change) => {
    const receipt = evaluateBranchPreflight(change(passingInput()), new Date("2026-08-19T17:30:00.000Z"));
    expect(receipt.checks).toHaveLength(10);
    const blocked = receipt.checks.find((check) => check.id === id);
    expect(blocked?.state).toBe("block");
    expect(typeof blocked?.reasonCode).toBe("string");
    expect(typeof blocked?.recovery).toBe("string");
    expect(receipt.ready).toBe(false);
  });

  it("surfaces inspector reason codes and never accepts placeholder digests for unavailable original-future evidence", () => {
    const input = passingInput();
    const receipt = evaluateBranchPreflight({
      ...input,
      originalFuture: { ...input.originalFuture, statusDigest: DIGEST, availability: { ...input.originalFuture.availability, status: { state: "unavailable", reasonCode: "preflight.status-blocked-by-filter" }, capture: { state: "unavailable", reasonCode: "preflight.status-blocked-by-filter" } } },
      inspectorReasonCodes: ["preflight.filter-configured", "preflight.status-blocked-by-filter"],
      checkoutSafety: { ...input.checkoutSafety, filtersActive: true },
    }, new Date("2026-08-19T17:30:00.000Z"));
    expect(receipt.checks.find(({ id }) => id === "checkout-safety")?.reasonCode).toBe("preflight.filter-configured");
    expect(receipt.checks.find(({ id }) => id === "original-future")?.reasonCode).toBe("preflight.status-blocked-by-filter");
    expect(receipt.ready).toBe(false);
  });

  it("invalidates confirmation on expiry or any bound revision, ref, policy, or input drift", () => {
    const receipt = evaluateBranchPreflight(passingInput(), new Date("2026-08-19T17:30:00.000Z"));
    const binding = { now: new Date("2026-08-19T17:30:29.999Z"), savePointRevision: receipt.savePointRevision, originalFutureDigest: receipt.originalFutureDigest, policyRevision: receipt.policyRevision, inputDigest: receipt.inputDigest };
    expect(validateBranchPreflightConfirmation(receipt, binding)).toEqual({ valid: true });
    expect(validateBranchPreflightConfirmation(receipt, { ...binding, now: new Date(receipt.expiresAt) })).toMatchObject({ valid: false, reasonCode: "preflight.expired" });
    expect(validateBranchPreflightConfirmation(receipt, { ...binding, savePointRevision: 4 })).toMatchObject({ valid: false, reasonCode: "preflight.save-revision-stale" });
    expect(validateBranchPreflightConfirmation(receipt, { ...binding, originalFutureDigest: DIGEST })).toMatchObject({ valid: false, reasonCode: "preflight.original-future-stale" });
    expect(validateBranchPreflightConfirmation(receipt, { ...binding, policyRevision: "remo.branch-preflight.v2" })).toMatchObject({ valid: false, reasonCode: "preflight.policy-stale" });
    expect(validateBranchPreflightConfirmation(receipt, { ...binding, inputDigest: DIGEST })).toMatchObject({ valid: false, reasonCode: "preflight.input-stale" });
  });
});
