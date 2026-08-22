import { mkdtempSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { deriveBranchPreflightIdentity, evaluateBranchPreflight, type BranchPreflightInput, type BranchPreflightOriginalFuture } from "@remo/domain";
import type { BranchGitAdapter, BranchGitResult, ExistingBranchTargetObservation } from "@remo/branch-git";
import { FoundationConflictError, LocalSavePointRepository } from "@remo/storage-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchCrashInjectionError, createBranchOrchestrationService, type BranchConfirmationRequest, type BranchCrashPoint } from "./branch-orchestration-service.js";

const PREFIX = "remo-t9-service-";
const SAVE = "01J000000000000000000000S5";
const OTHER = "01J000000000000000000000S6";
const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const AVAILABLE = { state: "available" as const };
const roots: string[] = [];

function root(): string { const value = resolve(mkdtempSync(join(tmpdir(), PREFIX))); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) { const relation = relative(resolve(tmpdir()), value); if (relation.startsWith(`..${sep}`) || relation === ".." || relation.includes(sep)) throw new Error("Unsafe T9 test root."); rmSync(value, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } });

function evaluation(savePointId = SAVE, revision = 3, time = "2026-08-20T05:00:00.000Z") {
  const target = deriveBranchPreflightIdentity(savePointId, revision);
  const originalFuture: BranchPreflightOriginalFuture = { branchRef: "refs/heads/main", head: COMMIT, statusDigest: DIGEST, indexDigest: DIGEST, approvedSourceDigest: DIGEST, availability: { status: AVAILABLE, index: AVAILABLE, approvedSource: AVAILABLE, capture: AVAILABLE } };
  const input: BranchPreflightInput = {
    savePointId, requestedSavePointId: savePointId, savePointRevision: revision, requestedSavePointRevision: revision,
    lifecycleState: "active", integrityState: "complete", fidelityState: "editable-eligible", privacyPassed: true,
    evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: DIGEST, evidenceDigest: DIGEST })),
    sourceCommit: COMMIT, sourceCommitExists: true,
    repository: { gitAvailable: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true },
    reproducibility: { route: "/fixture", expectedRoute: "/fixture", fixture: "fixture", expectedFixture: "fixture", viewport: "1440x900", expectedViewport: "1440x900", dependencyDigest: DIGEST, expectedDependencyDigest: DIGEST, policyDigest: DIGEST, expectedPolicyDigest: DIGEST },
    target: { ...target, refAbsent: true, pathAbsent: true }, operationActive: false,
    checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false }, originalLineageId: "lineage:original", originalFuture, inspectorReasonCodes: [],
  };
  return { receipt: evaluateBranchPreflight(input, new Date(time)), originalFuture };
}

function request(receipt = evaluation().receipt, key = "intent-key"): BranchConfirmationRequest {
  return { savePointId: receipt.savePointId, confirm: true, preflightDigest: receipt.digest, expectedSavePointRevision: receipt.savePointRevision, displayLabel: "Explore alternate", idempotencyKey: key };
}

function succeeded(): BranchGitResult { return { outcome: "succeeded", evidence: { verified: true } as never }; }
function exact(): ExistingBranchTargetObservation { return { outcome: "exact-success", evidence: { verified: true } as never }; }
function absent(): ExistingBranchTargetObservation { return { outcome: "absent", reasonCodes: ["git.existing-target-absent"], observed: { operationId: "op", branchRef: "ref", worktreePath: "path" } }; }

function harness(options: { readonly crash?: BranchCrashPoint; readonly create?: () => Promise<BranchGitResult>; readonly observe?: () => Promise<ExistingBranchTargetObservation>; readonly initial?: ReturnType<typeof evaluation> } = {}) {
  const repository = new LocalSavePointRepository({ projectRoot: root(), now: () => new Date("2026-08-20T05:00:01.000Z") });
  const initial = options.initial ?? evaluation();
  const fresh = evaluation(initial.receipt.savePointId, initial.receipt.savePointRevision, "2026-08-20T05:00:01.000Z");
  const createLockedWorktree = vi.fn(options.create ?? (() => Promise.resolve(succeeded())));
  const observeExistingTarget = vi.fn(options.observe ?? (() => Promise.resolve(absent())));
  const service = createBranchOrchestrationService({
    store: repository,
    git: { createLockedWorktree, observeExistingTarget } as Pick<BranchGitAdapter, "createLockedWorktree" | "observeExistingTarget">,
    preflightForMutation: vi.fn(() => Promise.resolve(fresh)),
    readIssuedReceipt: (digest) => digest === initial.receipt.digest ? initial.receipt : undefined,
    now: () => new Date("2026-08-20T05:00:02.000Z"),
    ...(options.crash === undefined ? {} : { injectCrash: (point: BranchCrashPoint) => { if (point === options.crash) throw new BranchCrashInjectionError(point); } }),
  });
  return { repository, service, initial, fresh, createLockedWorktree, observeExistingTarget };
}

describe("crash-safe branch orchestration", () => {
  it("returns one receipt for the same intent and rejects a conflicting intent without a second creation", async () => {
    const value = harness();
    const input = request(value.initial.receipt);
    const first = await value.service.confirm(input);
    const retry = await value.service.confirm(input);
    expect(first.state).toBe("succeeded"); expect(retry).toEqual(first); expect(value.createLockedWorktree).toHaveBeenCalledOnce();
    await expect(value.service.confirm({ ...input, displayLabel: "Conflicting label" })).rejects.toMatchObject({ code: "branch.intent-conflict" });
    expect(value.createLockedWorktree).toHaveBeenCalledOnce();
    value.repository.close();
  });

  it("rejects a different save-point intent before journal or Git after the sole alternate succeeds", async () => {
    const projectRoot = root();
    const repository = new LocalSavePointRepository({ projectRoot, now: () => new Date("2026-08-20T05:00:01.000Z") });
    const first = evaluation(SAVE, 3);
    const second = evaluation(OTHER, 4);
    const issued = new Map([[first.receipt.digest, first.receipt], [second.receipt.digest, second.receipt]]);
    const createLockedWorktree = vi.fn(() => Promise.resolve(succeeded()));
    const service = createBranchOrchestrationService({
      store: repository,
      git: { createLockedWorktree, observeExistingTarget: vi.fn(() => Promise.resolve(exact())) } as Pick<BranchGitAdapter, "createLockedWorktree" | "observeExistingTarget">,
      preflightForMutation: vi.fn((savePointId: string) => Promise.resolve(savePointId === SAVE ? first : second)),
      readIssuedReceipt: (digest) => issued.get(digest),
      now: () => new Date("2026-08-20T05:00:02.000Z"),
    });

    expect((await service.confirm(request(first.receipt, "intent-first"))).state).toBe("succeeded");
    await expect(service.confirm(request(second.receipt, "intent-second"))).rejects.toMatchObject({ code: "branch.state-conflict" });
    expect(repository.listBranchOperations()).toHaveLength(1);
    expect(repository.listJournaledBranchIntents()).toEqual([]);
    expect(createLockedWorktree).toHaveBeenCalledOnce();
    repository.close();
  });

  it("rejects stale or unknown confirmation before journal or Git", async () => {
    const value = harness();
    await expect(value.service.confirm({ ...request(value.initial.receipt), preflightDigest: DIGEST })).rejects.toBeInstanceOf(FoundationConflictError);
    expect(value.repository.listJournaledBranchIntents()).toEqual([]); expect(value.createLockedWorktree).not.toHaveBeenCalled();
    value.repository.close();
  });

  it.each(["before-journal-fsync", "before-git", "after-git", "before-sqlite-success", "after-receipt"] as const)("reconciles injected %s deterministically", async (point) => {
    const created = point === "before-git" ? false : point === "before-journal-fsync" ? false : true;
    const value = harness({ crash: point, observe: () => Promise.resolve(created ? exact() : absent()) });
    const input = request(value.initial.receipt);
    await expect(value.service.confirm(input)).rejects.toMatchObject({ point });
    if (point === "before-journal-fsync") {
      expect(value.repository.listJournaledBranchIntents()).toEqual([]); expect(value.repository.listBranchOperations()).toEqual([]);
    } else if (point === "after-receipt") {
      expect(value.repository.listBranchOperations()[0]?.state).toBe("succeeded");
      expect((await value.service.confirm(input)).state).toBe("succeeded");
      expect(value.createLockedWorktree).toHaveBeenCalledOnce();
    } else {
      expect(value.repository.listPendingBranchOperations()).toHaveLength(1);
      const recovered = await value.service.reconcileStartup();
      expect(recovered[0]?.state).toBe(created ? "succeeded" : "failed-no-effect");
    }
    value.repository.close();
  });

  it("holds one genuine async mutation lock across preflight, journal, Git, activation, and receipt", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const value = harness({ create: async () => { calls.push("git-start"); await firstGate; calls.push("git-end"); return succeeded(); } });
    const first = value.service.confirm(request(value.initial.receipt, "intent-first"));
    await vi.waitFor(() => expect(calls).toEqual(["git-start"]));
    const second = value.service.confirm({ ...request(value.initial.receipt, "intent-second"), savePointId: OTHER });
    await Promise.resolve(); expect(value.createLockedWorktree).toHaveBeenCalledTimes(1);
    releaseFirst(); await first; await expect(second).rejects.toBeInstanceOf(FoundationConflictError);
    expect(value.createLockedWorktree).toHaveBeenCalledTimes(1);
    value.repository.close();
  });

  it("marks succeeded lineage unavailable when startup observation drifts", async () => {
    const value = harness();
    const result = await value.service.confirm(request(value.initial.receipt)); expect(result.state).toBe("succeeded");
    value.observeExistingTarget.mockResolvedValue({ outcome: "recovery-required", reasonCodes: ["git.existing-target-ref-head-mismatch"], observed: { operationId: result.operationId, branchRef: result.branchRef, worktreePath: result.worktreeRelativePath } });
    const reconciled = await value.service.reconcileStartup();
    expect(reconciled[0]).toMatchObject({ state: "unavailable", reasonCodes: ["git.existing-target-ref-head-mismatch"] });
    expect(value.repository.listBranchOperations()[0]?.state).toBe("recovery-required");
    expect(value.repository.listHistory().lineages?.some(({ state }) => state === "active-alternate")).toBe(false);
    value.repository.close();
  });
});
