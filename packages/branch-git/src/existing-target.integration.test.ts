import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { deriveBranchPreflightIdentity, evaluateBranchPreflight, type BranchPreflightInput } from "@remo/domain";
import { inspectBranchPreflightRepository } from "@remo/evidence-git";
import { afterEach, describe, expect, it } from "vitest";
import { BRANCH_GIT_FIXED_PROFILE, BranchGitAdapter, type ObserveExistingBranchTargetRequest } from "./index.js";

const run = promisify(execFile);
const PREFIX = "remo-branch-git-t9-observer-";
const SAVE_POINT_ID = "01J000000000000000000000S5";
const SOURCE = "src";
const INTEGRATION_TIMEOUT_MS = 90_000;
const LONG_INTEGRATION_TIMEOUT_MS = 180_000;
const roots = new Set<string>();

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await run("git", [...args], { cwd, shell: false, encoding: "utf8" })).stdout;
}

async function fixture() {
  const root = resolve(await mkdtemp(join(tmpdir(), PREFIX)));
  roots.add(root);
  const repositoryRoot = join(root, "repository");
  await mkdir(join(repositoryRoot, SOURCE), { recursive: true });
  await git(repositoryRoot, ["init", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.name", "ReMo Test"]);
  await git(repositoryRoot, ["config", "user.email", "remo@example.invalid"]);
  await writeFile(join(repositoryRoot, SOURCE, "app.txt"), "original future\n");
  await writeFile(join(repositoryRoot, ".gitignore"), ".remo/\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "fixture"]);
  const canonical = await realpath(repositoryRoot);
  const head = (await git(canonical, ["rev-parse", "HEAD"])).trim();
  const target = deriveBranchPreflightIdentity(SAVE_POINT_ID, 3);
  const inspection = await inspectBranchPreflightRepository({ repositoryRoot: canonical, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: target.branchRef, operationWorktreePath: join(canonical, ...target.worktreeRelativePath.split("/")) });
  const digest = `sha256:${"a".repeat(64)}`;
  const input: BranchPreflightInput = {
    savePointId: SAVE_POINT_ID, requestedSavePointId: SAVE_POINT_ID, savePointRevision: 3, requestedSavePointRevision: 3,
    lifecycleState: "active", integrityState: "complete", fidelityState: "editable-eligible", privacyPassed: true,
    evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: digest, evidenceDigest: digest })),
    sourceCommit: head, sourceCommitExists: true,
    repository: { gitAvailable: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true },
    reproducibility: { route: "/fixture/save", expectedRoute: "/fixture/save", fixture: "vs001-ui", expectedFixture: "vs001-ui", viewport: "1440x900", expectedViewport: "1440x900", dependencyDigest: digest, expectedDependencyDigest: digest, policyDigest: digest, expectedPolicyDigest: digest },
    target: { ...target, refAbsent: true, pathAbsent: true }, operationActive: false,
    checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false, fsmonitorConfigured: false, fsmonitorNeutralized: true },
    originalLineageId: "lineage:original", originalFuture: inspection.originalFuture, inspectorReasonCodes: [],
  };
  const adapter = new BranchGitAdapter({ repositoryRoot: canonical, approvedSourceRoot: SOURCE });
  const receipt = evaluateBranchPreflight(input, new Date());
  const observeRequest: ObserveExistingBranchTargetRequest = { savePointId: SAVE_POINT_ID, savePointRevision: 3, sourceCommit: head, originalFuture: input.originalFuture };
  return { root, repositoryRoot: canonical, head, target, adapter, receipt, observeRequest };
}

async function pathExists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

afterEach(async () => {
  for (const root of [...roots]) {
    const relation = relative(resolve(tmpdir()), root);
    if (relation.startsWith(`..${sep}`) || relation === ".." || relation.includes(sep) || !basename(root).startsWith(PREFIX)) throw new Error(`Unsafe fixture root: ${root}`);
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    roots.delete(root);
  }
});

describe.sequential("finite existing-target observer", () => {
  it("returns proven absence before Git and exact success after the sole creation", async () => {
    const value = await fixture();
    const absent = await value.adapter.observeExistingTarget(value.observeRequest);
    expect(absent).toMatchObject({ outcome: "absent", reasonCodes: ["git.existing-target-absent"] });
    const created = await value.adapter.createLockedWorktree({ preflightReceipt: value.receipt, originalFuture: value.observeRequest.originalFuture });
    expect(created.outcome).toBe("succeeded");
    const exact = await value.adapter.observeExistingTarget(value.observeRequest);
    expect(exact.outcome, JSON.stringify(exact)).toBe("exact-success");
    if (exact.outcome === "exact-success") expect(exact.evidence).toMatchObject({ refCommit: value.head, worktreeCommit: value.head, worktreeBranchRef: value.target.branchRef, locked: true, observedLockReason: BRANCH_GIT_FIXED_PROFILE.lockReason, targetIdentityExact: true, originalFutureEqual: true });
  }, INTEGRATION_TIMEOUT_MS);

  it("classifies ref-only, path-only, wrong ref/HEAD, unlocked, and wrong lock reason as recovery-required", async () => {
    for (const condition of ["ref-only", "path-only", "wrong-ref", "wrong-head", "unlocked", "wrong-reason"] as const) {
      const value = await fixture();
      const targetPath = join(value.repositoryRoot, ...value.target.worktreeRelativePath.split("/"));
      if (condition === "ref-only") await git(value.repositoryRoot, ["branch", value.target.branchRef.slice("refs/heads/".length), value.head]);
      else if (condition === "path-only") await mkdir(targetPath, { recursive: true });
      else {
        expect((await value.adapter.createLockedWorktree({ preflightReceipt: value.receipt, originalFuture: value.observeRequest.originalFuture })).outcome).toBe("succeeded");
        if (condition === "wrong-ref") {
          await writeFile(join(value.repositoryRoot, SOURCE, "next.txt"), "next\n"); await git(value.repositoryRoot, ["add", "."]); await git(value.repositoryRoot, ["commit", "-m", "next"]);
          await git(value.repositoryRoot, ["update-ref", value.target.branchRef, (await git(value.repositoryRoot, ["rev-parse", "HEAD"])).trim()]);
        } else if (condition === "wrong-head") {
          await writeFile(join(targetPath, SOURCE, "branch.txt"), "branch\n"); await git(targetPath, ["add", "."]); await git(targetPath, ["commit", "-m", "branch drift"]);
        } else if (condition === "unlocked") await git(value.repositoryRoot, ["worktree", "unlock", targetPath]);
        else { await git(value.repositoryRoot, ["worktree", "unlock", targetPath]); await git(value.repositoryRoot, ["worktree", "lock", "--reason", "wrong reason", targetPath]); }
      }
      const result = await value.adapter.observeExistingTarget(value.observeRequest);
      expect(result.outcome, `${condition}: ${JSON.stringify(result)}`).toBe("recovery-required");
      await rm(value.root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); roots.delete(value.root);
    }
  }, LONG_INTEGRATION_TIMEOUT_MS);

  it("classifies wrong common directory, original-future drift, and indeterminate Git observation as recovery-required", async () => {
    const common = await fixture();
    expect((await common.adapter.createLockedWorktree({ preflightReceipt: common.receipt, originalFuture: common.observeRequest.originalFuture })).outcome).toBe("succeeded");
    const targetPath = join(common.repositoryRoot, ...common.target.worktreeRelativePath.split("/"));
    const other = await fixture();
    await run("attrib.exe", ["-R", "-H", "-S", join(targetPath, ".git")], { cwd: targetPath, shell: false, encoding: "utf8" });
    await writeFile(join(targetPath, ".git"), `gitdir: ${join(other.repositoryRoot, ".git")}\n`);
    expect((await common.adapter.observeExistingTarget(common.observeRequest)).outcome).toBe("recovery-required");
    await rm(common.root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); roots.delete(common.root);
    await rm(other.root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); roots.delete(other.root);

    const drift = await fixture();
    expect((await drift.adapter.createLockedWorktree({ preflightReceipt: drift.receipt, originalFuture: drift.observeRequest.originalFuture })).outcome).toBe("succeeded");
    await writeFile(join(drift.repositoryRoot, SOURCE, "app.txt"), "original future drift\n");
    const drifted = await drift.adapter.observeExistingTarget(drift.observeRequest);
    expect(drifted.outcome).toBe("recovery-required");
    if (drifted.outcome === "recovery-required") expect(drifted.reasonCodes).toContain("git.existing-target-original-future-drift");

    const priorPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const indeterminate = await drift.adapter.observeExistingTarget(drift.observeRequest);
      expect(indeterminate).toMatchObject({ outcome: "recovery-required", reasonCodes: ["git.existing-target-observation-indeterminate"] });
    } finally { process.env.PATH = priorPath; }
    expect(await pathExists(join(drift.repositoryRoot, ".remo", "worktrees", drift.target.operationId))).toBe(true);
  }, LONG_INTEGRATION_TIMEOUT_MS);

  it("exposes one exact read-only observer request and no second executor surface", async () => {
    const value = await fixture();
    const hostile = { ...value.observeRequest, args: ["--force"] } as unknown as ObserveExistingBranchTargetRequest;
    const result = await value.adapter.observeExistingTarget(hostile);
    expect(result).toMatchObject({ outcome: "recovery-required", reasonCodes: ["git.existing-target-request-fields-invalid"] });
    expect((await git(value.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/remo"])).trim()).toBe("");
    expect(Object.getOwnPropertyNames(BranchGitAdapter.prototype).sort()).toEqual(["constructor", "createLockedWorktree", "observeExistingTarget"]);
  });
});
