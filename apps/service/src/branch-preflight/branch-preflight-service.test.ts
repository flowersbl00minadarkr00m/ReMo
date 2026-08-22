import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { deriveBranchPreflightIdentity } from "@remo/domain";
import type { BranchPreflightRepositoryInspection, BranchPreflightRepositoryOptions } from "@remo/evidence-git";
import { createBranchPreflightService, type BranchPreflightSavePoint } from "./branch-preflight-service.js";

const SAVE_POINT_ID = "01J000000000000000000000S5";
const SOURCE_COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const AVAILABLE_CAPTURE = { state: "available" as const };

function savePoint(change: Partial<BranchPreflightSavePoint> = {}): BranchPreflightSavePoint {
  return {
    savePointId: SAVE_POINT_ID, revision: 3, lifecycleState: "active", integrityState: "complete", fidelityState: "editable-eligible", privacyPassed: true,
    evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: DIGEST, evidenceDigest: DIGEST })),
    sourceCommit: SOURCE_COMMIT, originalLineageId: "lineage:original", route: "/fixture/save-point", fixture: "vs001-ui-sequence-v1", viewport: "1440x900", dependencyDigest: DIGEST, policyDigest: DIGEST,
    ...change,
  };
}

const inspection: BranchPreflightRepositoryInspection = {
  gitAvailable: true, sourceCommitExists: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true,
  targetRefAbsent: true, targetPathAbsent: true, activeGitOperation: false,
  checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false, fsmonitorConfigured: false, fsmonitorNeutralized: true, unsafeConfigOrigin: false },
  reasonCodes: [],
  originalFuture: { branchRef: "refs/heads/main", head: SOURCE_COMMIT, statusDigest: DIGEST, indexDigest: DIGEST, approvedSourceDigest: DIGEST, availability: { status: AVAILABLE_CAPTURE, index: AVAILABLE_CAPTURE, approvedSource: AVAILABLE_CAPTURE, capture: AVAILABLE_CAPTURE } },
} as const;

describe("branch preflight service", () => {
  it("binds only safe derived identities into read-only inspection and returns ten passing checks", async () => {
    const inspect = vi.fn((options: BranchPreflightRepositoryOptions) => { void options; return Promise.resolve(inspection); });
    const service = createBranchPreflightService({ findSavePoint: () => savePoint(), pendingBranchOperation: () => false, inspect, repositoryRoot: "C:/repo", approvedSourceRoot: "packages/test-fixtures/vs001-ui/src", expected: { route: "/fixture/save-point", fixture: "vs001-ui-sequence-v1", viewport: "1440x900", dependencyDigest: DIGEST, policyDigest: DIGEST }, now: () => new Date("2026-08-19T17:30:00.000Z") });
    const receipt = await service.preflight(SAVE_POINT_ID, 3);
    const identity = deriveBranchPreflightIdentity(SAVE_POINT_ID, 3);
    expect(inspect).toHaveBeenCalledOnce();
    const inspected = inspect.mock.calls[0]?.[0];
    expect(inspected?.sourceCommit).toBe(SOURCE_COMMIT);
    expect(inspected?.branchRef).toBe(identity.branchRef);
    expect(inspected?.operationWorktreePath).toBe(resolve("C:/repo", identity.worktreeRelativePath));
    expect(identity.worktreeRelativePath).toBe(`.remo/worktrees/${identity.operationId}`);
    expect(receipt.ready).toBe(true);
    expect(receipt.checks).toHaveLength(10);
  });

  it("fails closed with all checks present for missing, stale, quarantined, dependency, operation, and Git failures", async () => {
    const cases: Array<{ readonly name: string; readonly point?: BranchPreflightSavePoint; readonly revision: number; readonly inspect?: BranchPreflightRepositoryInspection; readonly pending?: boolean; readonly blocked: string }> = [
      { name: "missing", revision: 1, blocked: "save-identity-revision-lifecycle" },
      { name: "stale", point: savePoint(), revision: 2, blocked: "save-identity-revision-lifecycle" },
      { name: "quarantined", point: savePoint({ lifecycleState: "quarantined" }), revision: 3, blocked: "save-identity-revision-lifecycle" },
      { name: "expired", point: savePoint({ lifecycleState: "expired" }), revision: 3, blocked: "save-identity-revision-lifecycle" },
      { name: "historical only", point: savePoint({ fidelityState: "historical-only" }), revision: 3, blocked: "integrity-fidelity" },
      { name: "dependency", point: savePoint({ dependencyDigest: `sha256:${"c".repeat(64)}` }), revision: 3, blocked: "reproducibility-inputs" },
      { name: "operation", point: savePoint(), revision: 3, pending: true, blocked: "operation-idle" },
      { name: "target collision", point: savePoint(), revision: 3, inspect: { ...inspection, targetPathAbsent: false }, blocked: "target-absence" },
      { name: "active filter", point: savePoint(), revision: 3, inspect: { ...inspection, checkoutSafety: { ...inspection.checkoutSafety, filtersActive: true } }, blocked: "checkout-safety" },
      { name: "active hook", point: savePoint(), revision: 3, inspect: { ...inspection, checkoutSafety: { ...inspection.checkoutSafety, hooksActive: true } }, blocked: "checkout-safety" },
      { name: "submodule", point: savePoint(), revision: 3, inspect: { ...inspection, checkoutSafety: { ...inspection.checkoutSafety, submodulesRequired: true } }, blocked: "checkout-safety" },
      { name: "unsafe ownership", point: savePoint(), revision: 3, inspect: { ...inspection, ownershipSafe: false, checkoutSafety: { ...inspection.checkoutSafety, unsafeOwnership: true } }, blocked: "repository-boundaries" },
      { name: "Git unavailable", point: savePoint(), revision: 3, inspect: { ...inspection, gitAvailable: false, sourceCommitExists: false }, blocked: "source-commit" },
      { name: "status unavailable", point: savePoint(), revision: 3, inspect: { ...inspection, reasonCodes: ["preflight.status-unavailable"], originalFuture: { ...inspection.originalFuture, statusDigest: "", availability: { ...inspection.originalFuture.availability, status: { state: "unavailable", reasonCode: "preflight.status-unavailable" }, capture: { state: "unavailable", reasonCode: "preflight.status-unavailable" } } } }, blocked: "original-future" },
    ];
    for (const item of cases) {
      const service = createBranchPreflightService({ findSavePoint: () => item.point, pendingBranchOperation: () => item.pending ?? false, inspect: () => Promise.resolve(item.inspect ?? inspection), repositoryRoot: "C:/repo", approvedSourceRoot: "packages/test-fixtures/vs001-ui/src", expected: { route: "/fixture/save-point", fixture: "vs001-ui-sequence-v1", viewport: "1440x900", dependencyDigest: DIGEST, policyDigest: DIGEST }, now: () => new Date("2026-08-19T17:30:00.000Z") });
      const receipt = await service.preflight(SAVE_POINT_ID, item.revision);
      expect(receipt.checks, item.name).toHaveLength(10);
      expect(receipt.checks.find(({ id }) => id === item.blocked)?.state, item.name).toBe("block");
      expect(receipt.ready, item.name).toBe(false);
      if (item.name === "status unavailable") expect(receipt.checks.find(({ id }) => id === "original-future")?.reasonCode).toBe("preflight.status-unavailable");
    }
  });
});
