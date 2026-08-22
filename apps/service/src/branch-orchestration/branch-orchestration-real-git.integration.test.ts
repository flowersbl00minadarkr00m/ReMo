import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BranchGitAdapter } from "@remo/branch-git";
import { deriveBranchPreflightIdentity, evaluateBranchPreflight, type BranchPreflightReceipt } from "@remo/domain";
import { inspectBranchPreflightRepository } from "@remo/evidence-git";
import { LocalSavePointRepository } from "@remo/storage-local";
import { afterEach, describe, expect, it } from "vitest";
import { BranchCrashInjectionError, createBranchOrchestrationService } from "./branch-orchestration-service.js";

const run = promisify(execFile);
const SAVE_ID = "01J000000000000000000000S5";
const DIGEST = `sha256:${"b".repeat(64)}`;
const roots: string[] = [];

async function git(root: string, args: readonly string[]): Promise<string> {
  return (await run("git", ["-C", root, ...args], { windowsHide: true })).stdout.trim();
}

async function abruptChild(root: string, sourceCommit: string, point: string): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const childPath = fileURLToPath(new URL("./branch-orchestration-crash-child.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", childPath, root, point], { cwd: import.meta.dirname, windowsHide: true, env: { ...process.env, REMO_T9_SOURCE_COMMIT: sourceCommit }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "remo-t9-real-service-")));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".remo/\n");
  await writeFile(join(root, "src", "app.ts"), "export const fixture = 's005';\n");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "ReMo T9 Fixture"]);
  await git(root, ["config", "user.email", "remo-t9@example.invalid"]);
  await git(root, ["add", ".gitignore", "src/app.ts"]);
  await git(root, ["commit", "-m", "s005 fixture"]);
  const sourceCommit = await git(root, ["rev-parse", "HEAD"]);
  const target = deriveBranchPreflightIdentity(SAVE_ID, 1);
  const evaluate = async () => {
    const inspection = await inspectBranchPreflightRepository({ repositoryRoot: root, approvedSourceRoot: "src", sourceCommit, branchRef: target.branchRef, operationWorktreePath: join(root, target.worktreeRelativePath) });
    const receipt = evaluateBranchPreflight({
      savePointId: SAVE_ID, requestedSavePointId: SAVE_ID, savePointRevision: 1, requestedSavePointRevision: 1,
      lifecycleState: "active", integrityState: "complete", fidelityState: "editable-eligible", privacyPassed: true,
      evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: DIGEST, evidenceDigest: DIGEST })),
      sourceCommit, sourceCommitExists: inspection.sourceCommitExists,
      repository: { gitAvailable: inspection.gitAvailable, canonicalRootSafe: inspection.canonicalRootSafe, approvedSourceRootSafe: inspection.approvedSourceRootSafe, commonDirectorySafe: inspection.commonDirectorySafe, derivedWorktreeRootSafe: inspection.derivedWorktreeRootSafe, ownershipSafe: inspection.ownershipSafe, linksAbsent: inspection.linksAbsent },
      reproducibility: { route: "/fixture/save-point", expectedRoute: "/fixture/save-point", fixture: "s005", expectedFixture: "s005", viewport: "1440x900", expectedViewport: "1440x900", dependencyDigest: DIGEST, expectedDependencyDigest: DIGEST, policyDigest: DIGEST, expectedPolicyDigest: DIGEST },
      target: { ...target, refAbsent: inspection.targetRefAbsent, pathAbsent: inspection.targetPathAbsent }, operationActive: false, checkoutSafety: inspection.checkoutSafety,
      originalLineageId: "lineage:original", originalFuture: inspection.originalFuture, inspectorReasonCodes: inspection.reasonCodes,
    }, new Date());
    return { receipt, originalFuture: inspection.originalFuture };
  };
  return { root, sourceCommit, target, evaluate };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.sequential("S-005 real Git service restart", () => {
  it.each([
    ["before-journal-fsync", undefined, false, false],
    ["before-git", "failed", false, false],
    ["after-git", "succeeded", true, true],
    ["before-sqlite-success", "succeeded", true, true],
    ["after-receipt", "succeeded", true, true],
  ] as const)("abruptly terminates a Windows child at %s and reconciles exact disk/Git/lineage inventory", async (point, expectedState, targetExists, alternateActive) => {
    if (process.platform !== "win32") return;
    const value = await fixture();
    const child = await abruptChild(value.root, value.sourceCommit, point);
    expect(child).toMatchObject({ code: 86, stdout: "", stderr: "" });

    const repository = new LocalSavePointRepository({ projectRoot: value.root });
    const adapter = new BranchGitAdapter({ repositoryRoot: value.root, approvedSourceRoot: "src" });
    const restarted = createBranchOrchestrationService({ store: repository, git: adapter, preflightForMutation: value.evaluate, readIssuedReceipt: () => undefined });
    const reconciled = await restarted.reconcileStartup();
    const operations = repository.listBranchOperations();
    const refExists = await git(value.root, ["show-ref", "--verify", "--quiet", value.target.branchRef]).then(() => true, () => false);
    const worktreeCount = (await git(value.root, ["worktree", "list", "--porcelain"])).match(/^worktree /gmu)?.length ?? 0;
    const lineages = repository.listHistory(10).lineages ?? [];

    expect(operations.map(({ state }) => state)).toEqual(expectedState === undefined ? [] : [expectedState]);
    expect(refExists).toBe(targetExists);
    expect(worktreeCount).toBe(targetExists ? 2 : 1);
    expect(lineages.some(({ state }) => state === "active-alternate")).toBe(alternateActive);
    if (point === "before-journal-fsync") expect(reconciled).toEqual([]);
    else if (point === "before-git") {
      expect(reconciled).toHaveLength(1);
      expect(reconciled[0]?.state).toBe("failed-no-effect");
      expect(reconciled[0]?.reasonCodes).toContain("git.existing-target-absent");
    }
    else if (point === "after-receipt") expect(reconciled).toEqual([]);
    else expect(reconciled).toEqual([expect.objectContaining({ state: "succeeded", lineageId: `lineage:alternate:${value.target.operationId}` })]);
    repository.close();
  }, 120_000);

  it("reconciles post-create interruption to one exact alternate lineage without a second mutation", async () => {
    const value = await fixture();
    let repository = new LocalSavePointRepository({ projectRoot: value.root });
    const adapter = new BranchGitAdapter({ repositoryRoot: value.root, approvedSourceRoot: "src" });
    const initial = await value.evaluate();
    let issued: BranchPreflightReceipt | undefined = initial.receipt;
    const service = createBranchOrchestrationService({
      store: repository, git: adapter, preflightForMutation: value.evaluate, readIssuedReceipt: () => issued,
      injectCrash(point) { if (point === "after-git") throw new BranchCrashInjectionError(point); },
    });
    await expect(service.confirm({ savePointId: SAVE_ID, confirm: true, preflightDigest: initial.receipt.digest, expectedSavePointRevision: 1, displayLabel: "S-005 alternate", idempotencyKey: "s005-real-git" })).rejects.toBeInstanceOf(BranchCrashInjectionError);
    expect(await git(value.root, ["show-ref", "--verify", "--hash", value.target.branchRef])).toBe(value.sourceCommit);
    expect((await git(value.root, ["worktree", "list", "--porcelain"])).match(/^worktree /gmu)).toHaveLength(2);
    repository.close();

    repository = new LocalSavePointRepository({ projectRoot: value.root });
    issued = undefined;
    const restarted = createBranchOrchestrationService({ store: repository, git: adapter, preflightForMutation: value.evaluate, readIssuedReceipt: () => undefined });
    const reconciled = await restarted.reconcileStartup();
    expect(reconciled).toEqual([expect.objectContaining({ state: "succeeded", savePointId: SAVE_ID, lineageId: `lineage:alternate:${value.target.operationId}` })]);
    expect((await git(value.root, ["worktree", "list", "--porcelain"])).match(/^worktree /gmu)).toHaveLength(2);
    expect(repository.listHistory(10).lineages).toEqual(expect.arrayContaining([expect.objectContaining({ state: "active-alternate", branchOperationId: value.target.operationId })]));
    repository.close();
  }, 90_000);
});
