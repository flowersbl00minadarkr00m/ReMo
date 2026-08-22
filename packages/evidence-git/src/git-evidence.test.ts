import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  captureGitSnapshot,
  createNodeGitExecutor,
  detectGitDrift,
  extractGitTextChanges,
  inspectBranchPreflightRepository,
  type GitExecutor,
} from "./index.js";

const run = promisify(execFile);
const SOURCE = "packages/test-fixtures/vs001-ui/src";

async function fixtureRepository(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "remo-git-evidence-"));
  await mkdir(join(repositoryRoot, SOURCE), { recursive: true });
  await writeFile(join(repositoryRoot, SOURCE, "FixtureApp.tsx"), "export const FixtureApp = () => <main />;\n");
  await writeFile(join(repositoryRoot, "README.md"), "excluded\n");
  await run("git", ["init", "--initial-branch=main"], { cwd: repositoryRoot, shell: false });
  await run("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repositoryRoot, shell: false });
  await run("git", ["config", "user.name", "Fixture"], { cwd: repositoryRoot, shell: false });
  await run("git", ["add", "."], { cwd: repositoryRoot, shell: false });
  await run("git", ["commit", "-m", "fixture"], { cwd: repositoryRoot, shell: false });
  return realpath(repositoryRoot);
}

describe("read-only allowlisted Git evidence", () => {
  it("captures HEAD, status, diff, and hashes only below the approved source root", async () => {
    const repositoryRoot = await fixtureRepository();
    await writeFile(join(repositoryRoot, SOURCE, "FixtureApp.tsx"), "export const FixtureApp = () => <main aria-label=\"changed\" />;\n");
    await writeFile(join(repositoryRoot, "README.md"), "excluded changed\n");

    const snapshot = await captureGitSnapshot({ repositoryRoot, allowedSourceRoot: SOURCE });
    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(snapshot.changedPaths).toEqual([`${SOURCE}/FixtureApp.tsx`]);
    expect(snapshot.diff).toContain("aria-label");
    expect(snapshot.diff).not.toContain("README");
    expect(Object.keys(snapshot.fileHashes)).toEqual([`${SOURCE}/FixtureApp.tsx`]);
    const textChanges = extractGitTextChanges(snapshot);
    expect(textChanges.uncertainPaths).toEqual([]);
    expect(textChanges.changes[0]?.path).toBe(`${SOURCE}/FixtureApp.tsx`);
    expect(textChanges.changes[0]?.before).toContain("<main />");
    expect(textChanges.changes[0]?.after).toContain("aria-label");
  });

  it("uses shell-free read-only argument arrays, path separation, and timeouts", async () => {
    const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number; shell: false }> = [];
    const executor: GitExecutor = (executable, args, options) => {
      calls.push({ executable, args, timeoutMs: options.timeoutMs, shell: options.shell });
      if (args[0] === "rev-parse") return Promise.resolve({ stdout: `${"a".repeat(40)}\n`, stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    };
    const repositoryRoot = await fixtureRepository();
    await captureGitSnapshot({ repositoryRoot, allowedSourceRoot: SOURCE, executor, timeoutMs: 3210 });

    expect(calls.every((call) => call.executable === "git" && call.shell === false && call.timeoutMs === 3210)).toBe(true);
    expect(calls.every((call) => ["rev-parse", "status", "diff"].includes(call.args[0] ?? ""))).toBe(true);
    expect(calls.filter((call) => call.args[0] !== "rev-parse").every((call) => call.args.includes("--"))).toBe(true);
  });

  it("propagates executor timeouts and detects pre/post drift", async () => {
    const repositoryRoot = await fixtureRepository();
    const timedOut: GitExecutor = () => Promise.reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    await expect(captureGitSnapshot({ repositoryRoot, allowedSourceRoot: SOURCE, executor: timedOut, timeoutMs: 1 })).rejects.toMatchObject({ code: "ETIMEDOUT" });

    const before = await captureGitSnapshot({ repositoryRoot, allowedSourceRoot: SOURCE });
    await writeFile(join(repositoryRoot, SOURCE, "FixtureApp.tsx"), "export const FixtureApp = () => <main aria-label=\"drift\" />;\n");
    const after = await captureGitSnapshot({ repositoryRoot, allowedSourceRoot: SOURCE });
    expect(detectGitDrift(before, after)).toMatchObject({ drifted: true });
  });

  it("rejects symlink or junction traversal before running Git", async () => {
    const repositoryRoot = await fixtureRepository();
    const outside = await mkdtemp(join(tmpdir(), "remo-git-outside-"));
    const link = join(repositoryRoot, "linked-source");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await expect(captureGitSnapshot({ repositoryRoot, allowedSourceRoot: "linked-source", executor: createNodeGitExecutor() })).rejects.toMatchObject({ reasonCode: "source.symlink-or-junction" });
    await expect(captureGitSnapshot({ repositoryRoot, allowedSourceRoot: "../outside", executor: createNodeGitExecutor() })).rejects.toMatchObject({ reasonCode: "source.path-invalid" });
  });
});

async function immutableInventory(repositoryRoot: string): Promise<unknown> {
  const gitDirectory = (await run("git", ["rev-parse", "--git-dir"], { cwd: repositoryRoot, shell: false })).stdout.trim();
  const indexPath = join(repositoryRoot, gitDirectory, "index");
  const [indexBytes, indexMetadata] = await Promise.all([readFile(indexPath), stat(indexPath)]);
  const refs = await run("git", ["for-each-ref", "--format=%(refname)%00%(objectname)"], { cwd: repositoryRoot, shell: false });
  const worktrees = await run("git", ["worktree", "list", "--porcelain"], { cwd: repositoryRoot, shell: false });
  const source = await readFile(join(repositoryRoot, SOURCE, "FixtureApp.tsx"), "utf8");
  return { indexBytes: indexBytes.toString("base64"), indexMetadata: { size: indexMetadata.size, mtimeMs: indexMetadata.mtimeMs, mode: indexMetadata.mode }, refs: refs.stdout, worktrees: worktrees.stdout, source, rootEntries: (await readdir(repositoryRoot)).sort() };
}

describe("branch preflight repository inspection", () => {
  const operationPath = (repositoryRoot: string) => join(repositoryRoot, ".remo", "worktrees", "branch-test-safe");

  it("binds every Git read to the fixed shell-free, no-lock executor profile", async () => {
    const repositoryRoot = await fixtureRepository();
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
    const calls: Array<{ readonly args: readonly string[]; readonly timeoutMs: number; readonly shell: false; readonly env?: Readonly<Record<string, string>> }> = [];
    const executor: GitExecutor = async (executable, args, options) => {
      calls.push({ args, ...options });
      const result = await run(executable, [...args], { cwd: options.cwd, shell: false, timeout: options.timeoutMs, env: { ...process.env, ...options.env } });
      return { stdout: result.stdout, stderr: result.stderr };
    };
    await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: operationPath(repositoryRoot), timeoutMs: 4321, executor });
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.every(({ args, timeoutMs, shell, env }) => args[0] === "--no-optional-locks" && args.includes("core.fsmonitor=false") && args.includes("protocol.file.allow=never") && timeoutMs === 4321 && shell === false && env?.GIT_OPTIONAL_LOCKS === "0" && env.GIT_CONFIG_NOSYSTEM === "1" && env.GIT_TERMINAL_PROMPT === "0")).toBe(true);
    const command = (call: { readonly args: readonly string[] }) => call.args[call.args.indexOf("--no-optional-locks") + 7];
    const statusIndex = calls.findIndex((call) => command(call) === "status");
    const configIndices = calls.map((call, index) => command(call) === "config" ? index : -1).filter((index) => index >= 0);
    expect(statusIndex).toBeGreaterThan(Math.max(...configIndices));
  });

  it("strips inherited Git environment overrides from the controlled read profile", async () => {
    const repositoryRoot = await fixtureRepository();
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
    const prior = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
    try {
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "filter.hostile.process";
      process.env.GIT_CONFIG_VALUE_0 = "node hostile.js";
      const result = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: operationPath(repositoryRoot) });
      expect(result.checkoutSafety.filtersActive).toBe(false);
    } finally {
      for (const [key, value] of [["GIT_CONFIG_COUNT", prior.count], ["GIT_CONFIG_KEY_0", prior.key], ["GIT_CONFIG_VALUE_0", prior.value]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("inspects exact commit, roots, target absence, safety, and original future with zero effect", async () => {
    const repositoryRoot = await fixtureRepository();
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
    const before = await immutableInventory(repositoryRoot);
    const result = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: operationPath(repositoryRoot) });
    const after = await immutableInventory(repositoryRoot);

    expect(result).toMatchObject({ gitAvailable: true, sourceCommitExists: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true, targetRefAbsent: true, targetPathAbsent: true, activeGitOperation: false });
    expect(result.checkoutSafety).toEqual({ filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false, fsmonitorConfigured: false, fsmonitorNeutralized: true, unsafeConfigOrigin: false });
    expect(result.originalFuture.branchRef).toBe("refs/heads/main");
    expect(result.originalFuture.head).toBe(head);
    expect(result.originalFuture.approvedSourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.originalFuture.availability).toEqual({ status: { state: "available" }, index: { state: "available" }, approvedSource: { state: "available" }, capture: { state: "available" } });
    expect(after).toEqual(before);
  });

  it("accepts only the displayed canonical-project .remo/worktrees operation path", async () => {
    const repositoryRoot = await fixtureRepository();
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
    const exact = operationPath(repositoryRoot);
    const accepted = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: exact });
    expect(accepted.derivedWorktreeRootSafe).toBe(true);
    const external = join(await mkdtemp(join(tmpdir(), "remo-external-worktrees-")), "branch-test-safe");
    const rejected = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: external });
    expect(rejected.derivedWorktreeRootSafe).toBe(false);
    expect(rejected.reasonCodes).toContain("preflight.worktree-root-unsafe");
  });

  it.each([
    ["filter", ["config", "filter.hostile.clean", "node hostile.js"]],
    ["external worktree config", ["config", "extensions.worktreeConfig", "true"]],
  ] as const)("blocks hostile %s configuration without mutation", async (_name, configArgs) => {
    const repositoryRoot = await fixtureRepository();
    if (_name === "filter") {
      await writeFile(join(repositoryRoot, ".gitattributes"), "*.tsx filter=hostile\n");
      await run("git", ["add", ".gitattributes"], { cwd: repositoryRoot, shell: false });
      await run("git", ["commit", "-m", "bind hostile attributes"], { cwd: repositoryRoot, shell: false });
    }
    await run("git", [...configArgs], { cwd: repositoryRoot, shell: false });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
    const before = await immutableInventory(repositoryRoot);
    const result = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: operationPath(repositoryRoot) });
    expect(result.checkoutSafety.filtersActive || result.checkoutSafety.externalWorktreeConfig).toBe(true);
    expect(await immutableInventory(repositoryRoot)).toEqual(before);
  });

  it("blocks a hostile working-tree filter before status can execute it and leaves every protected surface unchanged", async () => {
    const repositoryRoot = await fixtureRepository();
    const hostileRoot = await mkdtemp(join(tmpdir(), "remo-hostile-filter-"));
    const scriptPath = join(hostileRoot, "filter.cjs");
    const markerPath = join(hostileRoot, "executed.marker");
    await writeFile(scriptPath, "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'executed');process.stdin.pipe(process.stdout);\n");
    await writeFile(join(repositoryRoot, ".gitattributes"), "*.tsx filter=hostile.guard\n");
    const quote = (value: string) => `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
    await run("git", ["config", "filter.hostile.guard.process", `${quote(process.execPath)} ${quote(scriptPath)} ${quote(markerPath)}`], { cwd: repositoryRoot, shell: false });
    await writeFile(join(repositoryRoot, SOURCE, "FixtureApp.tsx"), "export const FixtureApp = () => <main aria-label=\"hostile-filter-sentinel\" />;\n");
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
    const before = await immutableInventory(repositoryRoot);
    const commands: string[] = [];
    const executor: GitExecutor = async (executable, args, options) => {
      commands.push(args[7] ?? "");
      const result = await run(executable, [...args], { cwd: options.cwd, shell: false, timeout: options.timeoutMs, env: { ...process.env, ...options.env } });
      return { stdout: result.stdout, stderr: result.stderr };
    };

    const result = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: operationPath(repositoryRoot), executor });

    expect(result.reasonCodes).toContain("preflight.filter-configured");
    expect(result.reasonCodes).toContain("preflight.status-blocked-by-filter");
    expect(result.originalFuture.statusDigest).toBe("");
    expect(result.originalFuture.availability.status).toEqual({ state: "unavailable", reasonCode: "preflight.status-blocked-by-filter" });
    expect(commands).not.toContain("status");
    expect(await readFile(markerPath).then(() => true, () => false)).toBe(false);
    expect(await immutableInventory(repositoryRoot)).toEqual(before);
  }, 20_000);

  it("fails closed on every configured executable filter before status, whether or not attributes reference it", async () => {
    const repositoryRoot = await fixtureRepository();
    await run("git", ["config", "filter.hostile.process", "node hostile.js"], { cwd: repositoryRoot, shell: false });
    let head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
    const configuredOnly = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: operationPath(repositoryRoot) });
    expect(configuredOnly.checkoutSafety.filtersActive).toBe(true);
    expect(configuredOnly.reasonCodes).toContain("preflight.filter-configured");
    expect(configuredOnly.originalFuture.availability.status).toMatchObject({ state: "unavailable", reasonCode: "preflight.status-blocked-by-filter" });
    await run("git", ["config", "--unset", "filter.hostile.process"], { cwd: repositoryRoot, shell: false });
    await writeFile(join(repositoryRoot, SOURCE, ".gitattributes"), "*.tsx filter=hostile\n");
    await run("git", ["add", "."], { cwd: repositoryRoot, shell: false });
    await run("git", ["commit", "-m", "nested attributes"], { cwd: repositoryRoot, shell: false });
    await run("git", ["config", "filter.hostile.process", "node hostile.js"], { cwd: repositoryRoot, shell: false });
    head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
    const referenced = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: operationPath(repositoryRoot) });
    expect(referenced.checkoutSafety.filtersActive).toBe(true);
    expect(referenced.reasonCodes).toContain("preflight.filter-active");
  }, 20_000);

  it("names executable hooks, submodule gitlinks, fsmonitor, unsafe include origins, active operations, and collisions without effect", async () => {
    const scenarios = ["hook", "submodule", "fsmonitor", "fsmonitor-bare", "include", "operation", "collision"] as const;
    for (const scenario of scenarios) {
      const repositoryRoot = await fixtureRepository();
      const targetPath = operationPath(repositoryRoot);
      if (scenario === "hook") { const hook = join(repositoryRoot, ".git", "hooks", "post-checkout"); await writeFile(hook, "#!/bin/sh\nexit 0\n"); await chmod(hook, 0o755); }
      if (scenario === "submodule") { const initial = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim(); await run("git", ["update-index", "--add", "--cacheinfo", `160000,${initial},vendor/submodule`], { cwd: repositoryRoot, shell: false }); await run("git", ["commit", "-m", "gitlink"], { cwd: repositoryRoot, shell: false }); }
      if (scenario === "fsmonitor") await run("git", ["config", "core.fsmonitor", "true"], { cwd: repositoryRoot, shell: false });
      if (scenario === "fsmonitor-bare") { const configPath = join(repositoryRoot, ".git", "config"); await writeFile(configPath, `${await readFile(configPath, "utf8")}\n[core]\n\tfsmonitor\n`); }
      if (scenario === "include") { const outside = join(await mkdtemp(join(tmpdir(), "remo-config-")), "included.config"); await writeFile(outside, "[core]\n\tfsmonitor = true\n"); await run("git", ["config", "include.path", outside], { cwd: repositoryRoot, shell: false }); }
      if (scenario === "operation") await writeFile(join(repositoryRoot, ".git", "MERGE_HEAD"), "a".repeat(40));
      if (scenario === "collision") await mkdir(targetPath, { recursive: true });
      const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, shell: false })).stdout.trim();
      const before = await immutableInventory(repositoryRoot);
      const result = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: head, branchRef: "refs/heads/remo/test-safe", operationWorktreePath: targetPath });
      expect(await immutableInventory(repositoryRoot), scenario).toEqual(before);
      if (scenario === "hook") expect(result.reasonCodes).toContain("preflight.hook-active");
      if (scenario === "submodule") expect(result.reasonCodes).toContain("preflight.submodule-required");
      if (scenario === "fsmonitor" || scenario === "fsmonitor-bare") expect(result.checkoutSafety).toMatchObject({ fsmonitorConfigured: true, fsmonitorNeutralized: true });
      if (scenario === "include") expect(result.reasonCodes).toContain("preflight.config-origin-unsafe");
      if (scenario === "operation") expect(result.reasonCodes).toContain("preflight.git-operation-active");
      if (scenario === "collision") expect(result).toMatchObject({ targetRefAbsent: true, targetPathAbsent: false });
    }
  }, 20_000);

  it("names missing commits and dubious ownership while preserving all ten-check upstream inputs", async () => {
    const repositoryRoot = await fixtureRepository();
    const operationWorktreePath = operationPath(repositoryRoot);
    const missing = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: "a".repeat(40), branchRef: "refs/heads/remo/test-safe", operationWorktreePath });
    expect(missing.reasonCodes).toContain("preflight.source-commit-missing");
    const dubious = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: "a".repeat(40), branchRef: "refs/heads/remo/test-safe", operationWorktreePath, executor: () => Promise.reject(new Error("fatal: detected dubious ownership in repository")) });
    expect(dubious.reasonCodes).toEqual(["preflight.ownership-dubious"]);
  });

  it("fails closed when Git is unavailable and never falls back to a shell", async () => {
    const repositoryRoot = await fixtureRepository();
    const result = await inspectBranchPreflightRepository({ repositoryRoot, approvedSourceRoot: SOURCE, sourceCommit: "a".repeat(40), branchRef: "refs/heads/remo/test-safe", operationWorktreePath: operationPath(repositoryRoot), executor: (_executable, _args, options) => { expect(options.shell).toBe(false); return Promise.reject(Object.assign(new Error("git unavailable"), { code: "ENOENT" })); } });
    expect(result).toMatchObject({ gitAvailable: false, sourceCommitExists: false, targetRefAbsent: false, targetPathAbsent: true });
    expect(result.reasonCodes).toEqual(["preflight.git-unavailable"]);
  });
});
