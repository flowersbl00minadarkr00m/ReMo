import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const READ_ONLY_GIT_COMMANDS = new Set(["rev-parse", "status", "diff"]);
export interface GitExecutionOptions { readonly cwd: string; readonly timeoutMs: number; readonly shell: false; readonly env?: Readonly<Record<string, string>> }
export type GitExecutor = (executable: string, args: readonly string[], options: GitExecutionOptions) => Promise<{ readonly stdout: string; readonly stderr: string }>;
export interface GitSnapshotOptions { readonly repositoryRoot: string; readonly allowedSourceRoot: string; readonly timeoutMs?: number; readonly executor?: GitExecutor }
export interface GitSnapshot { readonly head: string; readonly changedPaths: readonly string[]; readonly status: string; readonly diff: string; readonly fileHashes: Readonly<Record<string, string>>; readonly snapshotDigest: string }
export interface GitTextChange { readonly path: string; readonly before: string; readonly after: string }
export interface GitTextChangeSet { readonly changes: readonly GitTextChange[]; readonly uncertainPaths: readonly string[] }

export interface BranchPreflightRepositoryInspection {
  readonly gitAvailable: boolean;
  readonly sourceCommitExists: boolean;
  readonly canonicalRootSafe: boolean;
  readonly approvedSourceRootSafe: boolean;
  readonly commonDirectorySafe: boolean;
  readonly derivedWorktreeRootSafe: boolean;
  readonly ownershipSafe: boolean;
  readonly linksAbsent: boolean;
  readonly targetRefAbsent: boolean;
  readonly targetPathAbsent: boolean;
  readonly activeGitOperation: boolean;
  readonly checkoutSafety: { readonly filtersActive: boolean; readonly hooksActive: boolean; readonly externalWorktreeConfig: boolean; readonly submodulesRequired: boolean; readonly unsafeOwnership: boolean; readonly fsmonitorConfigured: boolean; readonly fsmonitorNeutralized: true; readonly unsafeConfigOrigin: boolean };
  readonly reasonCodes: readonly string[];
  readonly originalFuture: {
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
  };
}

export interface BranchPreflightCaptureAvailability { readonly state: "available" | "unavailable"; readonly reasonCode?: string }

export interface BranchPreflightRepositoryOptions {
  readonly repositoryRoot: string;
  readonly approvedSourceRoot: string;
  readonly sourceCommit: string;
  readonly branchRef: string;
  readonly operationWorktreePath: string;
  readonly timeoutMs?: number;
  readonly executor?: GitExecutor;
}

export class GitBoundaryError extends Error {
  readonly reasonCode: "source.path-invalid" | "source.symlink-or-junction" | "source.root-missing";
  constructor(reasonCode: GitBoundaryError["reasonCode"], message: string) { super(message); this.name = "GitBoundaryError"; this.reasonCode = reasonCode; }
}

export function createNodeGitExecutor(): GitExecutor {
  return async (executable, args, options) => {
    if (executable !== "git" || !READ_ONLY_GIT_COMMANDS.has(args[0] ?? "")) throw new Error("Only approved read-only Git commands may execute.");
    const result = await execFileAsync(executable, [...args], { cwd: options.cwd, timeout: options.timeoutMs, shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}
function toPortablePath(path: string): string { return path.split(sep).join("/"); }
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

async function assertNoLinks(repositoryRoot: string, sourceRoot: string): Promise<void> {
  let cursor = repositoryRoot;
  for (const segment of relative(repositoryRoot, sourceRoot).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    let stats;
    try { stats = await lstat(cursor); }
    catch { throw new GitBoundaryError("source.root-missing", "The approved source root does not exist."); }
    if (stats.isSymbolicLink()) throw new GitBoundaryError("source.symlink-or-junction", "Symlink or junction traversal is not allowed.");
  }
}
async function collectFiles(root: string, repositoryRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new GitBoundaryError("source.symlink-or-junction", "Symlink or junction traversal is not allowed.");
      if (stats.isDirectory()) await visit(absolute);
      else if (stats.isFile()) files.push(toPortablePath(relative(repositoryRoot, absolute)));
    }
  }
  await visit(root);
  return files.sort((a, b) => a.localeCompare(b, "en-US"));
}
function parseStatus(status: string): string[] { return status.split("\0").filter(Boolean).map((entry) => entry.slice(3).replaceAll("\\", "/")).sort((a, b) => a.localeCompare(b, "en-US")); }

export async function captureGitSnapshot(options: GitSnapshotOptions): Promise<GitSnapshot> {
  const repositoryRoot = resolve(options.repositoryRoot);
  if (isAbsolute(options.allowedSourceRoot) || options.allowedSourceRoot.split(/[\\/]/u).includes("..")) throw new GitBoundaryError("source.path-invalid", "The source root must be repository-relative without traversal.");
  const sourceRoot = resolve(repositoryRoot, options.allowedSourceRoot);
  const relation = relative(repositoryRoot, sourceRoot);
  if (relation === "" || relation.startsWith(`..${sep}`) || relation === "..") throw new GitBoundaryError("source.path-invalid", "The source root must be a strict repository child.");
  await assertNoLinks(repositoryRoot, sourceRoot);
  const executor = options.executor ?? createNodeGitExecutor();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const run = (args: readonly string[]) => executor("git", args, { cwd: repositoryRoot, timeoutMs, shell: false });
  const pathspec = `:(top,literal)${toPortablePath(relation)}`;
  const [headResult, statusResult, diffResult] = await Promise.all([
    run(["rev-parse", "HEAD"]),
    run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", pathspec]),
    run(["diff", "HEAD", "--no-ext-diff", "--", pathspec]),
  ]);
  const fileHashes: Record<string, string> = {};
  for (const file of await collectFiles(sourceRoot, repositoryRoot)) fileHashes[file] = digest(await readFile(resolve(repositoryRoot, file)));
  const head = headResult.stdout.trim();
  const core = { head, status: statusResult.stdout, diff: diffResult.stdout, fileHashes };
  return { ...core, changedPaths: parseStatus(statusResult.stdout), snapshotDigest: digest(JSON.stringify(core)) };
}
export function detectGitDrift(before: GitSnapshot, after: GitSnapshot): { readonly drifted: boolean; readonly reasonCodes: readonly string[] } {
  const reasons: string[] = [];
  if (before.head !== after.head) reasons.push("source.head-drift");
  if (before.status !== after.status) reasons.push("source.status-drift");
  if (before.diff !== after.diff) reasons.push("source.diff-drift");
  if (JSON.stringify(before.fileHashes) !== JSON.stringify(after.fileHashes)) reasons.push("source.hash-drift");
  return { drifted: reasons.length > 0, reasonCodes: reasons };
}

export function extractGitTextChanges(snapshot: GitSnapshot): GitTextChangeSet {
  const changes: GitTextChange[] = [];
  const uncertainPaths: string[] = [];
  for (const path of snapshot.changedPaths) {
    const marker = `diff --git a/${path} b/${path}`;
    const start = snapshot.diff.indexOf(marker);
    if (start < 0) {
      if (/\.(?:tsx|css)$/u.test(path)) uncertainPaths.push(path);
      else changes.push({ path, before: "", after: "" });
      continue;
    }
    const next = snapshot.diff.indexOf("\ndiff --git ", start + marker.length);
    const block = snapshot.diff.slice(start, next < 0 ? undefined : next);
    const before: string[] = [];
    const after: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("@@")) continue;
      if (line.startsWith("-")) before.push(line.slice(1));
      else if (line.startsWith("+")) after.push(line.slice(1));
      else if (line.startsWith(" ")) { before.push(line.slice(1)); after.push(line.slice(1)); }
    }
    changes.push({ path, before: before.join("\n"), after: after.join("\n") });
  }
  return { changes, uncertainPaths: uncertainPaths.sort((a, b) => a.localeCompare(b, "en-US")) };
}

const BRANCH_REF = /^refs\/heads\/remo\/[a-z0-9][a-z0-9/-]{0,180}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

function commandIndex(args: readonly string[]): number {
  let index = 0;
  if (args[index] === "--no-optional-locks") index += 1;
  while (args[index] === "-c") index += 2;
  return index;
}

function createNodeBranchPreflightExecutor(): GitExecutor {
  const allowed = new Set(["cat-file", "config", "ls-files", "ls-tree", "rev-parse", "show-ref", "status", "symbolic-ref"]);
  return async (executable, args, options) => {
    const index = commandIndex(args);
    const command = args[index];
    if (executable !== "git" || command === undefined || !allowed.has(command)) throw new Error("Only finite read-only branch-preflight Git commands may execute.");
    if (command === "config" && !args.includes("--get") && !args.includes("--get-regexp")) throw new Error("Branch preflight may only read Git configuration.");
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.toLocaleUpperCase("en-US").startsWith("GIT_"))) as NodeJS.ProcessEnv;
    const result = await execFileAsync(executable, [...args], { cwd: options.cwd, timeout: options.timeoutMs, shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...inheritedEnvironment, ...options.env } });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function noLinkPath(path: string, stop: string): Promise<boolean> {
  let cursor = resolve(path);
  const boundary = resolve(stop);
  while (true) {
    if (await exists(cursor) && (await lstat(cursor)).isSymbolicLink()) return false;
    if (cursor === boundary) return true;
    const parent = dirname(cursor);
    if (parent === cursor || relative(boundary, cursor).startsWith("..")) return false;
    cursor = parent;
  }
}

function failedInspection(targetPathAbsent: boolean, reasonCode = "preflight.git-unavailable"): BranchPreflightRepositoryInspection {
  const unavailable = { state: "unavailable" as const, reasonCode };
  return {
    gitAvailable: false, sourceCommitExists: false, canonicalRootSafe: false, approvedSourceRootSafe: false, commonDirectorySafe: false,
    derivedWorktreeRootSafe: false, ownershipSafe: false, linksAbsent: false, targetRefAbsent: false, targetPathAbsent, activeGitOperation: false,
    checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: true, fsmonitorConfigured: false, fsmonitorNeutralized: true, unsafeConfigOrigin: false },
    reasonCodes: [reasonCode],
    originalFuture: { branchRef: "", head: "", statusDigest: "", indexDigest: "", approvedSourceDigest: "", availability: { status: unavailable, index: unavailable, approvedSource: unavailable, capture: unavailable } },
  };
}

export async function inspectBranchPreflightRepository(options: BranchPreflightRepositoryOptions): Promise<BranchPreflightRepositoryInspection> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const operationWorktreePath = resolve(options.operationWorktreePath);
  const targetPathAbsent = !(await exists(operationWorktreePath));
  if (!COMMIT.test(options.sourceCommit) || !BRANCH_REF.test(options.branchRef) || !isAbsolute(options.operationWorktreePath)) return failedInspection(targetPathAbsent);
  const relation = options.approvedSourceRoot.replaceAll("\\", "/");
  if (isAbsolute(options.approvedSourceRoot) || relation.split("/").includes("..") || relation === "") return failedInspection(targetPathAbsent);
  const approvedSourcePath = resolve(repositoryRoot, options.approvedSourceRoot);
  const executor = options.executor ?? createNodeBranchPreflightExecutor();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const safePrefix = ["--no-optional-locks", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=never"] as const;
  const fixedEnvironment = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } as const;
  const run = (args: readonly string[]) => executor("git", [...safePrefix, ...args], { cwd: repositoryRoot, timeoutMs, shell: false, env: fixedEnvironment });
  let rootResult;
  try { rootResult = await run(["rev-parse", "--show-toplevel"]); } catch (error) {
    const failure = error as { readonly code?: unknown; readonly message?: string };
    return failedInspection(targetPathAbsent, failure.code === "ENOENT" ? "preflight.git-unavailable" : failure.message?.includes("dubious ownership") === true ? "preflight.ownership-dubious" : "preflight.git-root-unavailable");
  }
  const comparable = (value: string): string => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  let canonicalRootSafe = false;
  let approvedSourceRootSafe = false;
  let commonDirectorySafe = false;
  let derivedWorktreeRootSafe = false;
  let linksAbsent = false;
  let commonDirectory = "";
  try {
    const canonicalRoot = await realpath(repositoryRoot);
    canonicalRootSafe = comparable(canonicalRoot) === comparable(repositoryRoot) && comparable(resolve(rootResult.stdout.trim())) === comparable(repositoryRoot) && !(await lstat(repositoryRoot)).isSymbolicLink();
    const canonicalSource = await realpath(approvedSourcePath);
    approvedSourceRootSafe = relative(repositoryRoot, canonicalSource) !== "" && !relative(repositoryRoot, canonicalSource).startsWith("..") && await noLinkPath(canonicalSource, repositoryRoot);
    const common = (await run(["rev-parse", "--git-common-dir"])).stdout.trim();
    commonDirectory = resolve(repositoryRoot, common);
    const canonicalCommon = await realpath(commonDirectory);
    commonDirectorySafe = comparable(canonicalCommon) === comparable(commonDirectory) && await noLinkPath(commonDirectory, repositoryRoot);
    const expectedWorktreeRoot = resolve(repositoryRoot, ".remo", "worktrees");
    const expectedChild = relative(expectedWorktreeRoot, operationWorktreePath);
    derivedWorktreeRootSafe = /^[a-z0-9][a-z0-9-]{0,180}$/u.test(expectedChild) && !expectedChild.includes(sep) && await noLinkPath(operationWorktreePath, repositoryRoot);
    linksAbsent = canonicalRootSafe && approvedSourceRootSafe && commonDirectorySafe && derivedWorktreeRootSafe;
  } catch { /* fail closed */ }
  const optional = async (args: readonly string[]): Promise<{ readonly ok: boolean; readonly stdout: string; readonly error?: unknown }> => {
    try { const value = await run(args); return { ok: true, stdout: value.stdout }; } catch (error) { return { ok: false, stdout: "", error }; }
  };
  const configPattern = "^(filter\\..*\\.(clean|smudge|process|required)|core\\.(hooksPath|fsmonitor)|extensions\\.worktreeConfig)$";
  // Security phase 1: only reads that cannot consult working-tree filters. A
  // status-like read is forbidden until configured executable drivers and
  // attribute sources have been inspected. This intentionally fails closed
  // on every configured clean/smudge/process driver, even when attributes do
  // not currently reference it.
  const [commit, targetRef, branch, head, gitDirectoryResult, localConfig, worktreeConfig, tree, treeNames] = await Promise.all([
    optional(["cat-file", "-e", `${options.sourceCommit}^{commit}`]), optional(["show-ref", "--verify", "--quiet", options.branchRef]),
    optional(["symbolic-ref", "--quiet", "HEAD"]), optional(["rev-parse", "HEAD"]), optional(["rev-parse", "--git-dir"]),
    optional(["config", "--local", "--show-origin", "--includes", "--get-regexp", configPattern]),
    optional(["config", "--worktree", "--show-origin", "--includes", "--get-regexp", configPattern]), optional(["ls-tree", "-r", "--full-tree", options.sourceCommit]),
    optional(["ls-tree", "-r", "--name-only", "-z", options.sourceCommit]),
  ]);
  const parseConfig = (output: string): readonly { readonly origin: string; readonly key: string; readonly value: string }[] => output.split("\n").filter(Boolean).map((line) => {
    const [origin = "", rest = ""] = line.split("\t", 2);
    const separator = rest.search(/\s/u);
    return { origin, key: (separator < 0 ? rest : rest.slice(0, separator)).toLocaleLowerCase("en-US"), value: separator < 0 ? "" : rest.slice(separator + 1).trim() };
  });
  const isNoMatch = (result: { readonly ok: boolean; readonly error?: unknown }): boolean => !result.ok && (result.error as { readonly code?: unknown } | undefined)?.code === 1;
  const configInspectionAvailable = (localConfig.ok || isNoMatch(localConfig)) && (worktreeConfig.ok || isNoMatch(worktreeConfig));
  const configs = [...parseConfig(localConfig.stdout), ...parseConfig(worktreeConfig.stdout)];
  const within = (parent: string, child: string): boolean => { const relation = relative(parent, child); return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation)); };
  const unsafeConfigOrigin = !configInspectionAvailable || configs.some(({ origin }) => {
    if (!origin.startsWith("file:")) return true;
    const path = resolve(repositoryRoot, origin.slice(5));
    return commonDirectory === "" || !within(commonDirectory, path);
  });
  const configuredExecutableFilters = new Set(configs.map(({ key }) => /^filter\.(.+)\.(?:clean|smudge|process)$/u.exec(key)?.[1]).filter((name): name is string => name !== undefined));
  const attributePaths = treeNames.ok ? treeNames.stdout.split("\0").filter((path) => path === ".gitattributes" || path.endsWith("/.gitattributes")) : [];
  let attributesUnsafe = !treeNames.ok || attributePaths.length > 64;
  const attributeTexts: string[] = [];
  for (const path of attributePaths.slice(0, 64)) {
    if (path.startsWith("-") || isAbsolute(path) || path.split("/").includes("..")) { attributesUnsafe = true; continue; }
    const content = await optional(["cat-file", "blob", `${options.sourceCommit}:${path}`]);
    if (!content.ok || Buffer.byteLength(content.stdout) > 1024 * 1024) attributesUnsafe = true;
    else attributeTexts.push(content.stdout);
  }
  const infoAttributesPath = resolve(commonDirectory, "info", "attributes");
  if (commonDirectorySafe && await exists(infoAttributesPath)) {
    const infoStats = await stat(infoAttributesPath);
    if (infoStats.size > 1024 * 1024 || (await lstat(infoAttributesPath)).isSymbolicLink()) attributesUnsafe = true;
    else attributeTexts.push(await readFile(infoAttributesPath, "utf8"));
  }
  const referencedFilters = new Set(attributeTexts.flatMap((text) => [...text.matchAll(/(?:^|\s)filter=([A-Za-z0-9._-]+)/gmu)].map((match) => match[1]!)));
  const referencedExecutableFilter = [...referencedFilters].some((name) => configuredExecutableFilters.has(name.toLocaleLowerCase("en-US")));
  const filtersActive = !configInspectionAvailable || attributesUnsafe || configuredExecutableFilters.size > 0;
  const configuredHooksPath = configs.filter(({ key }) => key === "core.hookspath").at(-1)?.value;
  const hookDirectory = configuredHooksPath === undefined || configuredHooksPath === "" ? resolve(commonDirectory, "hooks") : resolve(repositoryRoot, configuredHooksPath);
  let hooksActive = false;
  if (await exists(hookDirectory)) hooksActive ||= (await readdir(hookDirectory, { withFileTypes: true })).some((entry) => entry.isFile() && !entry.name.endsWith(".sample"));
  const gitDirectory = gitDirectoryResult.ok ? resolve(repositoryRoot, gitDirectoryResult.stdout.trim()) : "";
  const operationMarkers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock", "rebase-apply", "rebase-merge", "sequencer"];
  const operationRoots = [...new Set([commonDirectory, gitDirectory].filter(Boolean))];
  const activeGitOperation = operationRoots.length === 0 || (await Promise.all(operationRoots.flatMap((root) => operationMarkers.map((name) => exists(resolve(root, name)))))).some(Boolean);
  const fileHashes: Record<string, string> = {};
  let approvedSourceAvailable = false;
  if (approvedSourceRootSafe) {
    try {
      const files = await collectFiles(approvedSourcePath, repositoryRoot);
      for (const file of files) fileHashes[file] = digest(await readFile(resolve(repositoryRoot, file)));
      approvedSourceAvailable = true;
    } catch { /* explicit unavailable state below */ }
  }
  const indexPath = gitDirectory === "" ? "" : resolve(gitDirectory, "index");
  let indexDigest = "";
  let indexAvailable = false;
  if (indexPath !== "" && await exists(indexPath)) {
    try {
      const [bytes, metadata] = await Promise.all([readFile(indexPath), stat(indexPath)]);
      indexDigest = `sha256:${digest(JSON.stringify({ bytesDigest: digest(bytes), size: metadata.size, mtimeMs: metadata.mtimeMs, mode: metadata.mode }))}`;
      indexAvailable = true;
    } catch { /* explicit unavailable state below */ }
  }
  // Security phase 2: status may invoke a clean/process driver. It is reached
  // only after phase 1 proves there is no executable configured filter and no
  // indeterminate attribute/config source.
  const status = filtersActive
    ? { ok: false, stdout: "", error: new Error("status blocked by checkout-safety preflight") }
    : await optional(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  const unavailable = (reasonCode: string) => ({ state: "unavailable" as const, reasonCode });
  const available = { state: "available" as const };
  const statusAvailability = status.ok ? available : unavailable(configuredExecutableFilters.size > 0 ? "preflight.status-blocked-by-filter" : attributesUnsafe ? "preflight.status-blocked-by-attributes" : !configInspectionAvailable ? "preflight.status-blocked-by-config" : "preflight.status-unavailable");
  const indexAvailability = indexAvailable ? available : unavailable("preflight.index-unavailable");
  const approvedSourceAvailability = approvedSourceAvailable ? available : unavailable("preflight.approved-source-unavailable");
  const branchAndHeadAvailable = branch.ok && branch.stdout.trim().startsWith("refs/heads/") && head.ok && COMMIT.test(head.stdout.trim());
  const captureFailureReason = !branchAndHeadAvailable ? "preflight.original-ref-head-unavailable" : statusAvailability.state === "unavailable" ? statusAvailability.reasonCode : indexAvailability.state === "unavailable" ? indexAvailability.reasonCode : approvedSourceAvailability.state === "unavailable" ? approvedSourceAvailability.reasonCode : undefined;
  const captureAvailability = captureFailureReason === undefined ? available : unavailable(captureFailureReason);
  const originalFuture = {
    branchRef: branch.ok ? branch.stdout.trim() : "",
    head: head.ok ? head.stdout.trim() : "",
    statusDigest: status.ok ? `sha256:${digest(status.stdout)}` : "",
    indexDigest,
    approvedSourceDigest: approvedSourceAvailable ? `sha256:${digest(JSON.stringify(fileHashes))}` : "",
    availability: { status: statusAvailability, index: indexAvailability, approvedSource: approvedSourceAvailability, capture: captureAvailability },
  };
  const ownershipSafe = canonicalRootSafe;
  const fsmonitorConfigured = configs.some(({ key, value }) => key === "core.fsmonitor" && value.toLocaleLowerCase("en-US") !== "false");
  const externalWorktreeConfig = configs.some(({ key, value }) => key === "extensions.worktreeconfig" && value.toLocaleLowerCase("en-US") === "true");
  const checkoutSafety = { filtersActive, hooksActive, externalWorktreeConfig, submodulesRequired: tree.ok && tree.stdout.split("\n").some((line) => line.startsWith("160000 ")), unsafeOwnership: !ownershipSafe, fsmonitorConfigured, fsmonitorNeutralized: true as const, unsafeConfigOrigin };
  const targetRefAbsent = !targetRef.ok && (targetRef.error as { readonly code?: unknown } | undefined)?.code === 1;
  const reasonCodes = [
    ...(!commit.ok ? ["preflight.source-commit-missing"] : []), ...(!canonicalRootSafe ? ["preflight.repository-root-unsafe"] : []), ...(!approvedSourceRootSafe ? ["preflight.source-root-unsafe"] : []),
    ...(!commonDirectorySafe ? ["preflight.common-directory-unsafe"] : []), ...(!derivedWorktreeRootSafe ? ["preflight.worktree-root-unsafe"] : []), ...(!ownershipSafe ? ["preflight.ownership-unsafe"] : []),
    ...(!targetRefAbsent ? ["preflight.target-ref-present-or-indeterminate"] : []), ...(!targetPathAbsent ? ["preflight.target-path-present"] : []), ...(activeGitOperation ? ["preflight.git-operation-active"] : []),
    ...(!configInspectionAvailable ? ["preflight.config-inspection-unavailable"] : []), ...(filtersActive ? [attributesUnsafe ? "preflight.attributes-indeterminate" : referencedExecutableFilter ? "preflight.filter-active" : "preflight.filter-configured"] : []), ...(hooksActive ? ["preflight.hook-active"] : []), ...(externalWorktreeConfig ? ["preflight.worktree-config-active"] : []),
    ...(checkoutSafety.submodulesRequired ? ["preflight.submodule-required"] : []), ...(unsafeConfigOrigin ? ["preflight.config-origin-unsafe"] : []), ...(statusAvailability.state === "unavailable" ? [statusAvailability.reasonCode] : []), ...(!indexAvailable ? ["preflight.index-unavailable"] : []), ...(!approvedSourceAvailable ? ["preflight.approved-source-unavailable"] : []), ...(!branchAndHeadAvailable ? ["preflight.original-ref-head-unavailable"] : []),
  ];
  return { gitAvailable: true, sourceCommitExists: commit.ok, canonicalRootSafe, approvedSourceRootSafe, commonDirectorySafe, derivedWorktreeRootSafe, ownershipSafe, linksAbsent, targetRefAbsent, targetPathAbsent, activeGitOperation, checkoutSafety, reasonCodes, originalFuture };
}
