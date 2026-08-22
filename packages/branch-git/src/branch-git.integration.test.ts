import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  deriveBranchPreflightIdentity,
  evaluateBranchPreflight,
  sha256Canonical,
  type BranchPreflightInput,
  type BranchPreflightReceipt,
} from "@remo/domain";
import { inspectBranchPreflightRepository } from "@remo/evidence-git";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BRANCH_GIT_FIXED_PROFILE, BranchGitAdapter, type BranchGitResult, type CreateLockedBranchWorktreeRequest } from "./index.js";

const run = promisify(execFile);
const FIXTURE_PREFIX = "remo-branch-git-t8-";
const SAVE_POINT_ID = "01J000000000000000000000S5";
const SOURCE = "src";
const createdRoots = new Set<string>();

interface Fixture { readonly root: string; readonly repositoryRoot: string; readonly head: string }

async function disposableRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX));
  createdRoots.add(resolve(root));
  return root;
}

async function cleanupRoot(root: string): Promise<void> {
  const exact = resolve(root);
  const temporary = resolve(tmpdir());
  const relation = relative(temporary, exact);
  if (relation.startsWith(`..${sep}`) || relation === ".." || relation.includes(sep) || !basename(exact).startsWith(FIXTURE_PREFIX)) throw new Error(`Refusing unsafe fixture cleanup: ${exact}`);
  await rm(exact, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  createdRoots.delete(exact);
}

afterEach(async () => {
  for (const root of [...createdRoots]) await cleanupRoot(root);
});

afterAll(() => {
  expect([...createdRoots]).toEqual([]);
});

async function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await run("git", [...args], { cwd, shell: false, encoding: "utf8", env: env === undefined ? process.env : env })).stdout;
}

async function fixtureRepository(options: { readonly ignoreRemo?: boolean; readonly repositoryPadding?: number } = {}): Promise<Fixture> {
  const root = await disposableRoot();
  const repositoryRoot = join(root, options.repositoryPadding === undefined ? "repository" : `repository-${"p".repeat(options.repositoryPadding)}`);
  await mkdir(join(repositoryRoot, SOURCE), { recursive: true });
  await git(repositoryRoot, ["init", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.name", "ReMo Test"]);
  await git(repositoryRoot, ["config", "user.email", "remo@example.invalid"]);
  await writeFile(join(repositoryRoot, SOURCE, "app.txt"), "original future\n");
  await writeFile(join(repositoryRoot, ".gitignore"), options.ignoreRemo === false ? "*.log\n" : ".remo/\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "fixture"]);
  const head = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  return { root, repositoryRoot: await realpath(repositoryRoot), head };
}

function passingInput(fixture: Fixture, inspection: Awaited<ReturnType<typeof inspectBranchPreflightRepository>>, savePointId = SAVE_POINT_ID): BranchPreflightInput {
  const target = deriveBranchPreflightIdentity(savePointId, 3);
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    savePointId,
    requestedSavePointId: savePointId,
    savePointRevision: 3,
    requestedSavePointRevision: 3,
    lifecycleState: "active",
    integrityState: "complete",
    fidelityState: "editable-eligible",
    privacyPassed: true,
    evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: digest, evidenceDigest: digest })),
    sourceCommit: fixture.head,
    sourceCommitExists: true,
    repository: { gitAvailable: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true },
    reproducibility: { route: "/fixture/save", expectedRoute: "/fixture/save", fixture: "vs001-ui", expectedFixture: "vs001-ui", viewport: "1440x900", expectedViewport: "1440x900", dependencyDigest: digest, expectedDependencyDigest: digest, policyDigest: digest, expectedPolicyDigest: digest },
    target: { ...target, refAbsent: true, pathAbsent: true },
    operationActive: false,
    checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false, fsmonitorConfigured: false, fsmonitorNeutralized: true },
    originalLineageId: "lineage:original",
    originalFuture: inspection.originalFuture,
    inspectorReasonCodes: [],
  };
}

async function requestFor(fixture: Fixture, savePointId = SAVE_POINT_ID): Promise<{ readonly adapter: BranchGitAdapter; readonly request: CreateLockedBranchWorktreeRequest }> {
  const target = deriveBranchPreflightIdentity(savePointId, 3);
  const inspectionOptions = {
    repositoryRoot: fixture.repositoryRoot,
    approvedSourceRoot: SOURCE,
    sourceCommit: fixture.head,
    branchRef: target.branchRef,
    operationWorktreePath: join(fixture.repositoryRoot, ...target.worktreeRelativePath.split("/")),
  } as const;
  const inspection = await inspectBranchPreflightRepository(inspectionOptions);
  const input = passingInput(fixture, inspection, savePointId);
  return {
    adapter: new BranchGitAdapter({ repositoryRoot: fixture.repositoryRoot, approvedSourceRoot: SOURCE }),
    request: { preflightReceipt: evaluateBranchPreflight(input, new Date()), originalFuture: input.originalFuture },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function withProcessEnvironment<T>(overrides: Readonly<Record<string, string>>, action: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) { previous.set(key, process.env[key]); process.env[key] = value; }
  try { return await action(); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

function resign(receipt: BranchPreflightReceipt, changes: Partial<BranchPreflightReceipt>): BranchPreflightReceipt {
  const changed = { ...receipt, ...changes };
  const body = Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "digest"));
  return { ...changed, digest: sha256Canonical(body) };
}

function expectBlocked(result: BranchGitResult, reason: string): void {
  expect(result.outcome).toBe("blocked");
  if (result.outcome === "blocked") expect(result.reasonCodes).toContain(reason);
}

describe("finite hostile-safe branch Git adapter", () => {
  it("creates exactly one derived ref and one locked worktree at the exact source commit", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    expect((await git(fixture.repositoryRoot, ["--version"])).trim()).toBe("git version 2.53.0.windows.1");
    const originalIndex = await readFile(join(fixture.repositoryRoot, ".git", "index"));
    const originalSource = await readFile(join(fixture.repositoryRoot, SOURCE, "app.txt"));
    const originalMain = (await git(fixture.repositoryRoot, ["rev-parse", "refs/heads/main"])).trim();
    const beforeRefs = await git(fixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
    const beforeWorktrees = await git(fixture.repositoryRoot, ["worktree", "list", "--porcelain"]);
    const result = await adapter.createLockedWorktree(request);
    expect(result.outcome, JSON.stringify({ result, expected: request.originalFuture })).toBe("succeeded");
    if (result.outcome !== "succeeded") return;
    expect(result.evidence).toMatchObject({ refCommit: fixture.head, worktreeCommit: fixture.head, worktreeClean: true, worktreeStatus: "", locked: true, observedLockReason: BRANCH_GIT_FIXED_PROFILE.lockReason, exactRefDelta: true, exactWorktreeDelta: true, originalFutureEqual: true });
    expect(result.evidence.creationCommand).toEqual({
      executable: "git",
      argv: ["-c", `core.hooksPath=${result.evidence.hooksDirectory}`, "-c", "core.fsmonitor=false", "worktree", "add", "--lock", "--reason", BRANCH_GIT_FIXED_PROFILE.lockReason, "-b", result.evidence.shortBranch, result.evidence.worktreePath, fixture.head],
      cwd: fixture.repositoryRoot,
      shell: false,
    });
    const afterRefs = await git(fixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
    const afterWorktrees = await git(fixture.repositoryRoot, ["worktree", "list", "--porcelain"]);
    expect(afterRefs.trim().split(/\r?\n/u)).toHaveLength(beforeRefs.trim().split(/\r?\n/u).length + 1);
    expect((afterWorktrees.match(/^worktree /gmu) ?? [])).toHaveLength((beforeWorktrees.match(/^worktree /gmu) ?? []).length + 1);
    expect(await readFile(join(fixture.repositoryRoot, ".git", "index"))).toEqual(originalIndex);
    expect(await readFile(join(fixture.repositoryRoot, SOURCE, "app.txt"))).toEqual(originalSource);
    expect((await git(fixture.repositoryRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(originalMain);
    expect(await readdir(result.evidence.hooksDirectory)).toEqual([]);
  }, 30_000);

  it("accepts the first fresh T7 inspection without warming or changing canonical index bytes", async () => {
    const fixture = await fixtureRepository();
    const indexPath = join(fixture.repositoryRoot, ".git", "index");
    const indexBytesBefore = await readFile(indexPath);
    const indexMetadataBefore = await stat(indexPath);
    const { adapter, request } = await requestFor(fixture);
    const indexBytesAfterPreflight = await readFile(indexPath);
    const indexMetadataAfterPreflight = await stat(indexPath);

    expect(indexBytesAfterPreflight).toEqual(indexBytesBefore);
    expect({ size: indexMetadataAfterPreflight.size, mtimeMs: indexMetadataAfterPreflight.mtimeMs, mode: indexMetadataAfterPreflight.mode }).toEqual({
      size: indexMetadataBefore.size,
      mtimeMs: indexMetadataBefore.mtimeMs,
      mode: indexMetadataBefore.mode,
    });

    const result = await adapter.createLockedWorktree(request);
    expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
    if (result.outcome !== "succeeded") return;
    expect(result.evidence.originalFutureBefore).toEqual(request.originalFuture);
    expect(await readFile(indexPath)).toEqual(indexBytesBefore);
  }, 30_000);

  it("matches T7 global portable-path digest ordering for punctuation-adjacent files and directories", async () => {
    const fixture = await fixtureRepository();
    await mkdir(join(fixture.repositoryRoot, SOURCE, "a"));
    await writeFile(join(fixture.repositoryRoot, SOURCE, "a-b"), "punctuation sibling\n");
    await writeFile(join(fixture.repositoryRoot, SOURCE, "a", "x"), "nested sibling\n");
    await git(fixture.repositoryRoot, ["add", `${SOURCE}/a-b`, `${SOURCE}/a/x`]);
    await git(fixture.repositoryRoot, ["commit", "-m", "portable path ordering"]);
    const head = (await git(fixture.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const { adapter, request } = await requestFor({ ...fixture, head });

    const result = await adapter.createLockedWorktree(request);
    expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
    if (result.outcome !== "succeeded") return;
    expect(result.evidence.originalFutureBefore.approvedSourceDigest).toBe(request.originalFuture.approvedSourceDigest);
    expect(result.evidence.originalFutureAfter.approvedSourceDigest).toBe(request.originalFuture.approvedSourceDigest);
  }, 30_000);

  it.each([
    ["branch ref injection", { branchRef: "refs/heads/remo/safe --force" }],
    ["worktree traversal", { worktreeRelativePath: ".remo/worktrees/../../outside" }],
    ["operation traversal", { operationId: "../../outside" }],
  ] as const)("rejects %s in planned target metadata before mutation", async (_name, targetChange) => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const target = { ...request.preflightReceipt.target, ...targetChange };
    const receipt = resign(request.preflightReceipt, { target });
    expectBlocked(await adapter.createLockedWorktree({ ...request, preflightReceipt: receipt }), "git.derived-identity-mismatch");
    expect((await git(fixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/remo"])).trim()).toBe("");
  });

  it.each(["displayLabel", "args", "config", "command", "reason"])("rejects an extra %s request field because the adapter API is exact", async (field) => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const extended = { ...request, [field]: field === "args" ? ["--force"] : "hostile" } as unknown as CreateLockedBranchWorktreeRequest;
    expectBlocked(await adapter.createLockedWorktree(extended), "git.request-fields-invalid");
    expect(await pathExists(join(fixture.repositoryRoot, ".remo"))).toBe(false);
  });

  it("blocks an unsafe derived absolute Windows path length before invoking Git", async () => {
    const fixture = await fixtureRepository({ repositoryPadding: 112 });
    const { adapter, request } = await requestFor(fixture);
    const targetPath = join(fixture.repositoryRoot, ...request.preflightReceipt.target.worktreeRelativePath.split("/"));
    expect(targetPath.length).toBeGreaterThan(BRANCH_GIT_FIXED_PROFILE.maxDerivedWorktreePath);
    expectBlocked(await adapter.createLockedWorktree(request), "git.worktree-path-too-long");
    expect((await git(fixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/remo"])).trim()).toBe("");
    expect(await pathExists(join(fixture.repositoryRoot, ".remo"))).toBe(false);
  });

  it("rejects source argument injection and receipt tamper before mutation", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const sourceTamper = resign(request.preflightReceipt, { sourceCommit: `${fixture.head} --force` });
    expectBlocked(await adapter.createLockedWorktree({ ...request, preflightReceipt: sourceTamper }), "git.source-commit-invalid");
    expectBlocked(await adapter.createLockedWorktree({ ...request, preflightReceipt: { ...request.preflightReceipt, ready: false } }), "git.preflight-blocked");
  });

  it("blocks local aliases, hooks, external worktree config, and dotted filters after the accepted receipt", async () => {
    for (const [reason, config] of [
      ["git.alias-configured", ["alias.worktree", "!echo hostile"]],
      ["git.external-worktree-config", ["extensions.worktreeConfig", "true"]],
      ["git.filter-configured", ["filter.hostile.dotted.process", "node hostile.js"]],
    ] as const) {
      const fixture = await fixtureRepository();
      const { adapter, request } = await requestFor(fixture);
      await git(fixture.repositoryRoot, ["config", config[0], config[1]]);
      expectBlocked(await adapter.createLockedWorktree(request), reason);
      await cleanupRoot(fixture.root);
    }
    const hookFixture = await fixtureRepository();
    const { adapter, request } = await requestFor(hookFixture);
    await writeFile(join(hookFixture.repositoryRoot, ".git", "hooks", "post-checkout"), "hostile\n");
    expectBlocked(await adapter.createLockedWorktree(request), "git.hook-present");
  }, 30_000);

  it("blocks filter attributes and submodule gitlinks without materializing either", async () => {
    const filterFixture = await fixtureRepository();
    await writeFile(join(filterFixture.repositoryRoot, ".gitattributes"), "*.txt filter=hostile\n");
    await git(filterFixture.repositoryRoot, ["add", ".gitattributes"]);
    await git(filterFixture.repositoryRoot, ["commit", "-m", "hostile attributes"]);
    const filterHead = (await git(filterFixture.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    let prepared = await requestFor({ ...filterFixture, head: filterHead });
    expectBlocked(await prepared.adapter.createLockedWorktree(prepared.request), "git.filter-attribute");
    await cleanupRoot(filterFixture.root);

    const infoFixture = await fixtureRepository();
    prepared = await requestFor(infoFixture);
    await writeFile(join(infoFixture.repositoryRoot, ".git", "info", "attributes"), "*.txt filter=hostile-info\n");
    expectBlocked(await prepared.adapter.createLockedWorktree(prepared.request), "git.filter-attribute");
    await cleanupRoot(infoFixture.root);

    const submoduleFixture = await fixtureRepository();
    await git(submoduleFixture.repositoryRoot, ["update-index", "--add", "--cacheinfo", `160000,${submoduleFixture.head},vendor/submodule`]);
    await git(submoduleFixture.repositoryRoot, ["commit", "-m", "gitlink"]);
    const newHead = (await git(submoduleFixture.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const withGitlink = { ...submoduleFixture, head: newHead };
    prepared = await requestFor(withGitlink);
    expectBlocked(await prepared.adapter.createLockedWorktree(prepared.request), "git.submodule-gitlink");
  }, 30_000);

  it("neutralizes hostile global/system configuration, inherited overrides, aliases, and hooks", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const hostile = join(fixture.root, "hostile.config");
    const marker = join(fixture.root, "hook-ran.marker");
    const hooks = join(fixture.root, "hostile-hooks");
    await mkdir(hooks);
    await writeFile(join(hooks, "post-checkout"), `echo hostile>${marker}\n`);
    await writeFile(hostile, `[alias]\n  worktree = !exit 91\n[core]\n  hooksPath = ${hooks.replaceAll("\\", "/")}\n  fsmonitor = true\n[filter "hostile.dotted"]\n  process = exit 92\n`);
    const hostileHome = join(fixture.root, "hostile-home");
    const hostileXdg = join(fixture.root, "hostile-xdg");
    await mkdir(join(hostileXdg, "git"), { recursive: true });
    await mkdir(hostileHome);
    await writeFile(join(hostileHome, ".gitconfig"), await readFile(hostile));
    await writeFile(join(hostileXdg, "git", "config"), await readFile(hostile));
    const originalMain = (await git(fixture.repositoryRoot, ["rev-parse", "refs/heads/main"])).trim();
    const originalSource = await readFile(join(fixture.repositoryRoot, SOURCE, "app.txt"));
    const overrides = {
      GIT_CONFIG_GLOBAL: hostile,
      GIT_CONFIG_SYSTEM: hostile,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "alias.worktree",
      GIT_CONFIG_VALUE_0: "!exit 93",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: hooks,
      GIT_CONFIG_KEY_2: "filter.command.scope.process",
      GIT_CONFIG_VALUE_2: "exit 94",
      GIT_CONFIG_PARAMETERS: "invalid-command-scope-config",
      GIT_DIR: join(fixture.root, "hostile-git-dir"),
      GIT_WORK_TREE: join(fixture.root, "hostile-work-tree"),
      GIT_ATTR_SOURCE: "refs/heads/hostile-attributes",
      GIT_OBJECT_DIRECTORY: join(fixture.root, "hostile-objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(fixture.root, "hostile-alternates"),
      GIT_EXEC_PATH: join(fixture.root, "hostile-exec-path"),
      GIT_ASKPASS: join(fixture.root, "hostile-askpass.exe"),
      GIT_EDITOR: join(fixture.root, "hostile-editor.exe"),
      GIT_SSH_COMMAND: "exit 95",
      GIT_SSH_VARIANT: "hostile",
      GIT_TEMPLATE_DIR: join(fixture.root, "hostile-template"),
      HOME: hostileHome,
      XDG_CONFIG_HOME: hostileXdg,
    } as const;
    const result = await withProcessEnvironment(overrides, async () => {
      const result = await adapter.createLockedWorktree(request);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      await expect(readFile(marker)).rejects.toThrow();
      return result;
    });
    expect((await git(fixture.repositoryRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(originalMain);
    expect(await readFile(join(fixture.repositoryRoot, SOURCE, "app.txt"))).toEqual(originalSource);
    if (result.outcome === "succeeded") expect(result.evidence.originalFutureEqual).toBe(true);
  }, 30_000);

  it("classifies Git's real dubious-ownership failure without a production test shortcut", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const icacls = join(systemRoot, "System32", "icacls.exe");
    await run(icacls, [fixture.repositoryRoot, "/setowner", "*S-1-5-18", "/T", "/C"], { shell: false, encoding: "utf8" });
    const hostResult = await adapter.createLockedWorktree(request);
    if (hostResult.outcome === "blocked") {
      expect(hostResult.reasonCodes).toContain("git.ownership-unsafe");
      return;
    }
    expect(hostResult.outcome).toBe("succeeded");

    // This elevated Windows host treats a SYSTEM-owned repository as safe.
    // Exercise Git's own dubious-ownership failure outside production and
    // prove the adapter maps that real stderr while never consuming the test
    // variable or adding safe.directory in its production profile.
    let ownershipError: unknown;
    try { await git(fixture.repositoryRoot, ["status", "--short"], { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" }); }
    catch (error) { ownershipError = error; }
    expect((ownershipError as { readonly stderr?: string }).stderr).toContain("dubious ownership");
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('failure.message.includes("dubious ownership") ? "git.ownership-unsafe"');
    expect(source).not.toContain("GIT_TEST_ASSUME_DIFFERENT_OWNER");
    expect(source).not.toContain("safe.directory");
  }, 30_000);

  it("blocks repository and .remo reparse-point boundaries", async () => {
    const fixture = await fixtureRepository();
    const alias = join(fixture.root, "repository-link");
    await symlink(fixture.repositoryRoot, alias, process.platform === "win32" ? "junction" : "dir");
    const request = await requestFor(fixture);
    const linkedAdapter = new BranchGitAdapter({ repositoryRoot: resolve(alias), approvedSourceRoot: SOURCE });
    const linkedResult = await linkedAdapter.createLockedWorktree(request.request);
    expect(linkedResult.outcome).toBe("blocked");
    if (linkedResult.outcome === "blocked") expect(linkedResult.reasonCodes.some((reason) => reason.endsWith("unsafe") || reason.endsWith("mismatch") || reason.endsWith("link"))).toBe(true);
    const outside = await disposableRoot();
    await symlink(outside, join(fixture.repositoryRoot, ".remo"), process.platform === "win32" ? "junction" : "dir");
    const result = await request.adapter.createLockedWorktree(request.request);
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") expect(result.reasonCodes.some((reason) => reason.includes("link"))).toBe(true);
  });

  it("blocks pre-existing unsafe hooks ACLs and hooks-directory reparse points before Git", async () => {
    const aclFixture = await fixtureRepository();
    const aclPrepared = await requestFor(aclFixture);
    const hooksDirectory = join(aclFixture.repositoryRoot, ".remo", "private", BRANCH_GIT_FIXED_PROFILE.hooksDirectoryName);
    await mkdir(hooksDirectory, { recursive: true });
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    await run(join(systemRoot, "System32", "icacls.exe"), [hooksDirectory, "/grant", "*S-1-1-0:(OI)(CI)RX"], { shell: false, encoding: "utf8" });
    expectBlocked(await aclPrepared.adapter.createLockedWorktree(aclPrepared.request), "git.hooks-directory-acl-not-current-user-only");
    expect((await git(aclFixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/remo"])).trim()).toBe("");
    await cleanupRoot(aclFixture.root);

    const linkFixture = await fixtureRepository();
    const linkPrepared = await requestFor(linkFixture);
    const privateRoot = join(linkFixture.repositoryRoot, ".remo", "private");
    const outside = await disposableRoot();
    await mkdir(privateRoot, { recursive: true });
    await symlink(outside, join(privateRoot, BRANCH_GIT_FIXED_PROFILE.hooksDirectoryName), process.platform === "win32" ? "junction" : "dir");
    expectBlocked(await linkPrepared.adapter.createLockedWorktree(linkPrepared.request), "git.hooks-directory-link");
    expect((await git(linkFixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/remo"])).trim()).toBe("");
  }, 30_000);

  it("blocks hostile private XDG content and unsafe environment ACLs before any Git child can consume them", async () => {
    const hostileFixture = await fixtureRepository();
    const hostilePrepared = await requestFor(hostileFixture);
    const environmentRoot = join(hostileFixture.repositoryRoot, ".remo", "private", "git-environment-v1");
    const hostileAttributes = join(environmentRoot, "xdg", "git", "attributes");
    await mkdir(join(environmentRoot, "home"), { recursive: true });
    await mkdir(join(environmentRoot, "xdg", "git"), { recursive: true });
    await writeFile(hostileAttributes, "*.txt filter=hostile-global\n");
    const hostileBytes = await readFile(hostileAttributes);
    expectBlocked(await hostilePrepared.adapter.createLockedWorktree(hostilePrepared.request), "git.private-environment-shape-unsafe");
    expect(await readFile(hostileAttributes)).toEqual(hostileBytes);
    expect((await git(hostileFixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/remo"])).trim()).toBe("");
    await cleanupRoot(hostileFixture.root);

    const aclFixture = await fixtureRepository();
    const aclPrepared = await requestFor(aclFixture);
    const aclEnvironmentRoot = join(aclFixture.repositoryRoot, ".remo", "private", "git-environment-v1");
    await mkdir(join(aclEnvironmentRoot, "home"), { recursive: true });
    await mkdir(join(aclEnvironmentRoot, "xdg"));
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    await run(join(systemRoot, "System32", "icacls.exe"), [aclEnvironmentRoot, "/grant", "*S-1-1-0:(OI)(CI)RX"], { shell: false, encoding: "utf8" });
    expectBlocked(await aclPrepared.adapter.createLockedWorktree(aclPrepared.request), "git.private-environment-acl-not-current-user-only");
    expect((await git(aclFixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/remo"])).trim()).toBe("");
  }, 30_000);

  it("returns recovery-required when unignored private/worktree state changes the original status digest", async () => {
    const fixture = await fixtureRepository({ ignoreRemo: false });
    const { adapter, request } = await requestFor(fixture);
    const targetPath = join(fixture.repositoryRoot, ...request.preflightReceipt.target.worktreeRelativePath.split("/"));
    const ignoreBefore = await readFile(join(fixture.repositoryRoot, ".gitignore"));
    const excludePath = join(fixture.repositoryRoot, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath);
    const result = await adapter.createLockedWorktree(request);
    expect(result.outcome, JSON.stringify(result)).toBe("recovery-required");
    if (result.outcome === "recovery-required") {
      expect(result.reasonCodes).toContain("git.post-create-verification-failed");
      expect(result.observed.originalFutureEqual).toBe(false);
      expect(result.observed).toMatchObject({ refCommit: fixture.head, worktreeCommit: fixture.head, locked: true });
    }
    expect(await readFile(join(fixture.repositoryRoot, ".gitignore"))).toEqual(ignoreBefore);
    expect(await readFile(excludePath)).toEqual(excludeBefore);
    expect((await git(fixture.repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]))).toContain(".remo/");
    expect((await git(fixture.repositoryRoot, ["rev-parse", request.preflightReceipt.target.branchRef])).trim()).toBe(fixture.head);
    expect(await pathExists(targetPath)).toBe(true);
    const worktrees = await git(fixture.repositoryRoot, ["worktree", "list", "--porcelain"]);
    expect(worktrees).toContain(`worktree ${targetPath.replaceAll("\\", "/")}`);
    expect(worktrees).toContain(`locked ${BRANCH_GIT_FIXED_PROFILE.lockReason}`);
  }, 30_000);

  it("blocks ref/path collisions and mismatched original-future evidence", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    await git(fixture.repositoryRoot, ["branch", request.preflightReceipt.target.branchRef.slice("refs/heads/".length), fixture.head]);
    expectBlocked(await adapter.createLockedWorktree(request), "git.target-ref-collision");
    const second = await fixtureRepository();
    const prepared = await requestFor(second);
    await mkdir(join(second.repositoryRoot, ...prepared.request.preflightReceipt.target.worktreeRelativePath.split("/")), { recursive: true });
    expectBlocked(await prepared.adapter.createLockedWorktree(prepared.request), "git.target-path-collision");
    const third = await fixtureRepository();
    const stale = await requestFor(third);
    await writeFile(join(third.repositoryRoot, SOURCE, "app.txt"), "tampered future\n");
    expectBlocked(await stale.adapter.createLockedWorktree(stale.request), "git.original-future-stale");
  }, 30_000);

  it("observes a post-preflight ref/path race as recovery-required and never retries with force", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const targetPath = join(fixture.repositoryRoot, ...request.preflightReceipt.target.worktreeRelativePath.split("/"));
    const hooksDirectory = join(fixture.repositoryRoot, ".remo", "private", BRANCH_GIT_FIXED_PROFILE.hooksDirectoryName);
    const resultPromise = adapter.createLockedWorktree(request);
    await waitForPath(hooksDirectory);
    await mkdir(targetPath, { recursive: true });
    await git(fixture.repositoryRoot, ["branch", request.preflightReceipt.target.branchRef.slice("refs/heads/".length), fixture.head]);
    const result = await resultPromise;
    expect(result.outcome, JSON.stringify(result)).toBe("recovery-required");
    if (result.outcome === "recovery-required") {
      expect(result.reasonCodes).toContain("git.creation-process-failed-partial");
      expect(result.observed.creationCommand?.argv).not.toContain("--force");
      expect(result.observed.creationCommand?.argv).not.toContain("-B");
    }
    expect((await git(fixture.repositoryRoot, ["rev-parse", request.preflightReceipt.target.branchRef])).trim()).toBe(fixture.head);
  }, 30_000);

  it("returns recovery-required when an existing worktree record changes across the exact delta", async () => {
    const fixture = await fixtureRepository();
    const existingWorktree = join(fixture.root, "existing-worktree");
    const { adapter, request } = await requestFor(fixture);
    await git(fixture.repositoryRoot, ["worktree", "add", "-b", "existing-worktree", existingWorktree, fixture.head]);
    const hooksDirectory = join(fixture.repositoryRoot, ".remo", "private", BRANCH_GIT_FIXED_PROFILE.hooksDirectoryName);

    const resultPromise = adapter.createLockedWorktree(request);
    const earlyResult = await Promise.race([
      waitForPath(hooksDirectory).then(() => undefined),
      resultPromise,
    ]);
    expect(earlyResult, JSON.stringify(earlyResult)).toBeUndefined();
    await git(fixture.repositoryRoot, ["worktree", "lock", "--reason", "concurrent existing-record mutation", existingWorktree]);
    const result = await resultPromise;

    expect(result.outcome, JSON.stringify(result)).toBe("recovery-required");
    if (result.outcome === "recovery-required") {
      expect(result.reasonCodes).toContain("git.post-create-verification-failed");
      expect(result.observed.exactWorktreeDelta).toBe(false);
    }
    expect((await git(fixture.repositoryRoot, ["worktree", "list", "--porcelain"]))).toContain("locked concurrent existing-record mutation");
  }, 30_000);

  it("returns typed recovery-required evidence when real Git creates a ref before a worktree-add process failure", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    await mkdir(join(fixture.repositoryRoot, ".remo"), { recursive: true });
    await writeFile(join(fixture.repositoryRoot, ".remo", "worktrees"), "not a directory\n");
    const result = await adapter.createLockedWorktree(request);
    expect(result.outcome, JSON.stringify(result)).toBe("recovery-required");
    if (result.outcome === "recovery-required") {
      expect(result.processError?.message.length).toBeGreaterThan(0);
      expect(result.reasonCodes).toEqual(["git.creation-process-failed-partial"]);
    }
    expect((await git(fixture.repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/remo"])).trim()).toBe(request.preflightReceipt.target.branchRef);
  }, 30_000);

  it("treats an unavailable creation and indeterminate post-failure ref probe as recovery-required", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const hooksDirectory = join(fixture.repositoryRoot, ".remo", "private", BRANCH_GIT_FIXED_PROFILE.hooksDirectoryName);
    const targetPath = join(fixture.repositoryRoot, ...request.preflightReceipt.target.worktreeRelativePath.split("/"));
    const priorPath = process.env.PATH;
    const resultPromise = adapter.createLockedWorktree(request);
    await waitForPath(hooksDirectory);
    process.env.PATH = "";
    let result: BranchGitResult;
    try { result = await resultPromise; }
    finally { process.env.PATH = priorPath; }

    expect(result.outcome, JSON.stringify(result)).toBe("recovery-required");
    if (result.outcome === "recovery-required") expect(result.reasonCodes).toEqual(["git.creation-process-failed-effect-indeterminate"]);
    expect(await pathExists(targetPath)).toBe(false);
    expect((await git(fixture.repositoryRoot, ["show-ref", "--verify", "--hash", request.preflightReceipt.target.branchRef]).catch(() => "")).trim()).toBe("");
    expect(await pathExists(hooksDirectory)).toBe(true);
  }, 30_000);

  it("returns failed-no-effect only when exit-1 proves ref absence and the target path is absent", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const hooksDirectory = join(fixture.repositoryRoot, ".remo", "private", BRANCH_GIT_FIXED_PROFILE.hooksDirectoryName);
    const targetPath = join(fixture.repositoryRoot, ...request.preflightReceipt.target.worktreeRelativePath.split("/"));
    const shortBranch = request.preflightReceipt.target.branchRef.slice("refs/heads/".length);
    const refLock = join(fixture.repositoryRoot, ".git", "refs", "heads", `${shortBranch}.lock`);
    const resultPromise = adapter.createLockedWorktree(request);
    await waitForPath(hooksDirectory);
    await mkdir(resolve(refLock, ".."), { recursive: true });
    await writeFile(refLock, "held by deterministic fixture\n");
    const result = await resultPromise;

    expect(result.outcome, JSON.stringify(result)).toBe("failed-no-effect");
    if (result.outcome === "failed-no-effect") expect(result.reasonCodes).toEqual(["git.creation-process-failed-no-effect"]);
    expect(await pathExists(targetPath)).toBe(false);
    expect((await git(fixture.repositoryRoot, ["show-ref", "--verify", "--hash", request.preflightReceipt.target.branchRef]).catch(() => "")).trim()).toBe("");
    expect(await readFile(refLock, "utf8")).toContain("deterministic fixture");
  }, 30_000);

  it("fails closed when the Git process is unavailable", async () => {
    const fixture = await fixtureRepository();
    const { adapter, request } = await requestFor(fixture);
    const prior = process.env.PATH;
    process.env.PATH = "";
    try {
      expectBlocked(await adapter.createLockedWorktree(request), "git.process-unavailable");
    } finally {
      process.env.PATH = prior;
    }
  });

  it("exposes no arbitrary, force, destructive, or canonical-checkout API form", async () => {
    const module = await import("./index.js");
    expect(Object.keys(module).sort()).toEqual(["BRANCH_GIT_FIXED_PROFILE", "BranchGitAdapter"]);
    expect(Object.getOwnPropertyNames(BranchGitAdapter.prototype).sort()).toEqual(["constructor", "createLockedWorktree", "observeExistingTarget"]);
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("displayLabel");
    expect(source).not.toContain("GIT_TEST_ASSUME_DIFFERENT_OWNER");
    for (const inheritedOverride of ["GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_ATTR_SOURCE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_EXEC_PATH", "GIT_ASKPASS", "GIT_EDITOR", "GIT_SSH_COMMAND", "GIT_TEMPLATE_DIR"]) expect(source).not.toContain(inheritedOverride);
    for (const forbidden of ["reset", "clean", "delete", "prune", "--force", "-B", "checkout"]) expect(source).not.toMatch(new RegExp(`execFileAsync\\([^\\n]+${forbidden}`, "u"));
    expect(BRANCH_GIT_FIXED_PROFILE.configKeys).toEqual(["core.hooksPath", "core.fsmonitor"]);
    expect(BRANCH_GIT_FIXED_PROFILE.maxDerivedWorktreePath).toBe(240);
  });
});
