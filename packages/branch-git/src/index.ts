import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  assertBranchPreflightReceipt,
  deriveBranchPreflightIdentity,
  sha256Canonical,
  type BranchPreflightOriginalFuture,
  type BranchPreflightReceipt,
} from "@remo/domain";

const execFileAsync = promisify(execFile);
const COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_RELATIVE_ROOT = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const FIXED_LOCK_REASON = "ReMo isolated alternate lineage";
const FIXED_HOOKS_DIRECTORY = "empty-git-hooks-v1";
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_SAFE_DERIVED_WORKTREE_PATH = 240;

export interface BranchGitAdapterOptions {
  readonly repositoryRoot: string;
  readonly approvedSourceRoot: string;
  readonly timeoutMs?: number;
}

export interface CreateLockedBranchWorktreeRequest {
  readonly preflightReceipt: BranchPreflightReceipt;
  readonly originalFuture: BranchPreflightOriginalFuture;
}

export interface ObserveExistingBranchTargetRequest {
  readonly savePointId: string;
  readonly savePointRevision: number;
  readonly sourceCommit: string;
  readonly originalFuture: BranchPreflightOriginalFuture;
}

export interface ObservedGitCommand {
  readonly executable: "git";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly shell: false;
}

export interface ObservedBranchGitEvidence {
  readonly sourceCommit: string;
  readonly branchRef: string;
  readonly shortBranch: string;
  readonly worktreePath: string;
  readonly hooksDirectory: string;
  readonly lockReason: typeof FIXED_LOCK_REASON;
  readonly refCommit: string;
  readonly worktreeCommit: string;
  readonly worktreeBranchRef: string;
  readonly worktreeClean: boolean;
  readonly worktreeStatus: string;
  readonly canonicalCommonDirectory: string;
  readonly worktreeCommonDirectory: string;
  readonly locked: boolean;
  readonly observedLockReason: string;
  readonly exactRefDelta: boolean;
  readonly exactWorktreeDelta: boolean;
  readonly originalFutureBefore: BranchPreflightOriginalFuture;
  readonly originalFutureAfter: BranchPreflightOriginalFuture;
  readonly originalFutureEqual: boolean;
  readonly creationCommand: ObservedGitCommand;
}

export type BranchGitResult =
  | { readonly outcome: "succeeded"; readonly evidence: ObservedBranchGitEvidence }
  | { readonly outcome: "blocked"; readonly reasonCodes: readonly string[]; readonly observed?: Partial<ObservedBranchGitEvidence> }
  | { readonly outcome: "failed-no-effect" | "recovery-required"; readonly reasonCodes: readonly string[]; readonly observed: Partial<ObservedBranchGitEvidence>; readonly processError?: { readonly code?: string; readonly message: string } };

export interface ObservedExistingBranchTargetEvidence {
  readonly operationId: string;
  readonly sourceCommit: string;
  readonly branchRef: string;
  readonly worktreePath: string;
  readonly refCommit: string;
  readonly worktreeCommit: string;
  readonly worktreeBranchRef: string;
  readonly worktreeClean: boolean;
  readonly worktreeStatus: string;
  readonly canonicalCommonDirectory: string;
  readonly worktreeCommonDirectory: string;
  readonly locked: boolean;
  readonly observedLockReason: string;
  readonly targetIdentityExact: boolean;
  readonly originalFutureExpected: BranchPreflightOriginalFuture;
  readonly originalFutureObserved: BranchPreflightOriginalFuture;
  readonly originalFutureEqual: boolean;
}

export type ExistingBranchTargetObservation =
  | { readonly outcome: "exact-success"; readonly evidence: ObservedExistingBranchTargetEvidence }
  | { readonly outcome: "absent"; readonly reasonCodes: readonly ["git.existing-target-absent"]; readonly observed: { readonly operationId: string; readonly branchRef: string; readonly worktreePath: string } }
  | { readonly outcome: "recovery-required"; readonly reasonCodes: readonly string[]; readonly observed: Partial<ObservedExistingBranchTargetEvidence> & { readonly operationId: string; readonly branchRef: string; readonly worktreePath: string }; readonly processError?: { readonly code?: string; readonly message: string } };

interface GitResult { readonly stdout: string; readonly stderr: string }
interface WorktreeRecord { readonly path: string; readonly head: string; readonly branchRef?: string; readonly locked: boolean; readonly reason?: string }
interface RepositoryObservation {
  readonly commonDirectory: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly worktrees: readonly WorktreeRecord[];
  readonly originalFuture: BranchPreflightOriginalFuture;
  readonly reasonCodes: readonly string[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptBody(receipt: BranchPreflightReceipt): unknown {
  return Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "digest"));
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertExistingPathHasNoLinks(root: string, target: string): Promise<boolean> {
  if (!isWithin(root, target)) return false;
  let cursor = root;
  const relation = relative(root, target);
  for (const segment of relation.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!(await exists(cursor))) continue;
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) return false;
    const actual = await realpath(cursor);
    if (comparable(actual) !== comparable(resolve(cursor))) return false;
  }
  return true;
}

function inheritedEnvironmentValue(name: string): string | undefined {
  const entry = Object.entries(process.env).find(([key, value]) => value !== undefined && key.toLocaleUpperCase("en-US") === name.toLocaleUpperCase("en-US"));
  return entry?.[1];
}

function controlledEnvironment(hooksDirectory: string, readOnly = false): NodeJS.ProcessEnv {
  const privateRoot = resolve(hooksDirectory, "..");
  const environmentRoot = join(privateRoot, "git-environment-v1");
  const clean: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"] as const) {
    const value = inheritedEnvironmentValue(name);
    if (value !== undefined) clean[name] = value;
  }
  return {
    ...clean,
    HOME: join(environmentRoot, "home"),
    XDG_CONFIG_HOME: join(environmentRoot, "xdg"),
    LANG: "C",
    LC_ALL: "C",
    GCM_INTERACTIVE: "Never",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...(readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
  };
}

function fixedGitPrefix(hooksDirectory: string): readonly string[] {
  return ["-c", `core.hooksPath=${hooksDirectory}`, "-c", "core.fsmonitor=false"];
}

async function runGit(
  repositoryRoot: string,
  hooksDirectory: string,
  timeoutMs: number,
  args: readonly string[],
): Promise<GitResult> {
  const result = await execFileAsync("git", [...fixedGitPrefix(hooksDirectory), ...args], {
    cwd: repositoryRoot,
    timeout: timeoutMs,
    shell: false,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: controlledEnvironment(hooksDirectory, true),
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function optionalGit(
  repositoryRoot: string,
  hooksDirectory: string,
  timeoutMs: number,
  args: readonly string[],
): Promise<{ readonly ok: true; readonly value: GitResult } | { readonly ok: false; readonly error: unknown }> {
  try {
    return { ok: true, value: await runGit(repositoryRoot, hooksDirectory, timeoutMs, args) };
  } catch (error) {
    return { ok: false, error };
  }
}

function processFailure(error: unknown): { readonly code?: string; readonly message: string } {
  const candidate = error as { readonly code?: unknown; readonly message?: unknown; readonly stderr?: unknown };
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
  const message = stderr || (typeof candidate.message === "string" ? candidate.message : "Git process failed.");
  return typeof candidate.code === "string" ? { code: candidate.code, message } : { message };
}

function hasProcessExitCode(error: unknown, exitCode: number): boolean {
  const code = (error as { readonly code?: unknown }).code;
  return code === exitCode || code === String(exitCode);
}

async function observePathPresence(path: string): Promise<"present" | "absent" | "indeterminate"> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    return (error as { readonly code?: unknown }).code === "ENOENT" ? "absent" : "indeterminate";
  }
}

// Frozen T7/T8 interop: this finite mutation package reimplements the accepted
// evidence-git observation primitives instead of importing its executor API.
// Keep portable-path digest ordering and checkout-hazard semantics aligned with
// T7's originalFuture/checkoutSafety contract whenever that contract changes.
async function collectApprovedSourceDigest(repositoryRoot: string, sourceRoot: string): Promise<string> {
  const files: string[] = [];
  const hashes: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error("link");
      if (metadata.isDirectory()) await visit(absolute);
      else if (metadata.isFile()) files.push(relative(repositoryRoot, absolute).split(sep).join("/"));
      else throw new Error("unsupported-node");
    }
  }
  await visit(sourceRoot);
  for (const file of files.sort((a, b) => a.localeCompare(b, "en-US"))) hashes[file] = sha256(await readFile(resolve(repositoryRoot, file)));
  return `sha256:${sha256(JSON.stringify(hashes))}`;
}

function parseRefs(output: string): Readonly<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const [ref, commit] = line.split("\0");
    if (ref !== undefined && commit !== undefined) refs[ref] = commit;
  }
  return refs;
}

function parseWorktrees(output: string): readonly WorktreeRecord[] {
  return output.trim().split(/\r?\n\r?\n/u).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/u);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "";
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length) ?? "";
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    const lockLine = lines.find((line) => line === "locked" || line.startsWith("locked "));
    return {
      path: resolve(path),
      head,
      ...(branchRef === undefined ? {} : { branchRef }),
      locked: lockLine !== undefined,
      ...(lockLine === undefined || lockLine === "locked" ? {} : { reason: lockLine.slice("locked ".length) }),
    };
  });
}

function parseConfig(output: string): readonly { readonly origin: string; readonly key: string; readonly value: string }[] {
  return output.split(/\r?\n/u).filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const origin = tab < 0 ? "" : line.slice(0, tab);
    const body = tab < 0 ? line : line.slice(tab + 1);
    const separator = body.search(/\s/u);
    return {
      origin,
      key: (separator < 0 ? body : body.slice(0, separator)).toLocaleLowerCase("en-US"),
      value: separator < 0 ? "" : body.slice(separator + 1).trim(),
    };
  });
}

function configNoMatch(result: { readonly ok: boolean; readonly error?: unknown }): boolean {
  return !result.ok && (result.error as { readonly code?: unknown } | undefined)?.code === 1;
}

async function inspectCheckoutHazards(
  repositoryRoot: string,
  commonDirectory: string,
  hooksDirectory: string,
  timeoutMs: number,
  sourceCommit: string,
): Promise<readonly string[]> {
  const pattern = "^(alias\\..+|filter\\..+\\.(clean|smudge|process|required)|core\\.(hookspath|fsmonitor)|extensions\\.worktreeconfig|include(if\\..+)?\\.path)$";
  const local = await optionalGit(repositoryRoot, hooksDirectory, timeoutMs, ["config", "--local", "--show-origin", "--includes", "--get-regexp", pattern]);
  if (!local.ok && !configNoMatch(local)) return ["git.config-inspection-unavailable"];
  // Per-worktree config cannot exist unless extensions.worktreeConfig is true;
  // that extension is itself forbidden below, so local/common inspection is
  // both sufficient and avoids enabling or consulting the rejected surface.
  const configs = parseConfig(local.ok ? local.value.stdout : "");
  const reasons = new Set<string>();
  for (const config of configs) {
    if (!config.origin.startsWith("file:")) reasons.add("git.config-origin-unsafe");
    else {
      const originPath = resolve(repositoryRoot, config.origin.slice(5));
      if (!isWithin(commonDirectory, originPath)) reasons.add("git.config-origin-unsafe");
    }
    if (config.key.startsWith("alias.")) reasons.add("git.alias-configured");
    if (config.key.startsWith("filter.")) reasons.add("git.filter-configured");
    if (config.key === "core.hookspath") reasons.add("git.hooks-configured");
    if (config.key === "extensions.worktreeconfig" && config.value.toLocaleLowerCase("en-US") === "true") reasons.add("git.external-worktree-config");
    if (config.key.startsWith("include") && config.key.endsWith(".path")) reasons.add("git.config-include");
  }

  const defaultHooks = join(commonDirectory, "hooks");
  if (await exists(defaultHooks)) {
    const entries = await readdir(defaultHooks, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && !entry.name.endsWith(".sample"))) reasons.add("git.hook-present");
  }

  const tree = await optionalGit(repositoryRoot, hooksDirectory, timeoutMs, ["ls-tree", "-r", "--full-tree", "-z", sourceCommit]);
  if (!tree.ok) return [...reasons, "git.source-tree-unavailable"].sort();
  const attributePaths: string[] = [];
  for (const record of tree.value.stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const metadata = tab < 0 ? record : record.slice(0, tab);
    const path = tab < 0 ? "" : record.slice(tab + 1);
    const mode = metadata.split(" ")[0];
    if (mode === "160000") reasons.add("git.submodule-gitlink");
    if (mode === "120000") reasons.add("git.source-link");
    if (path === ".gitattributes" || path.endsWith("/.gitattributes")) attributePaths.push(path);
  }
  if (attributePaths.length > 64) reasons.add("git.attributes-indeterminate");
  for (const path of attributePaths.slice(0, 64)) {
    if (path.startsWith("-") || path.split("/").includes("..")) {
      reasons.add("git.attributes-indeterminate");
      continue;
    }
    const content = await optionalGit(repositoryRoot, hooksDirectory, timeoutMs, ["cat-file", "blob", `${sourceCommit}:${path}`]);
    if (!content.ok || Buffer.byteLength(content.value.stdout) > 1024 * 1024) reasons.add("git.attributes-indeterminate");
    else if (/(?:^|\s)(?:filter(?:=|\s)|-filter(?:\s|$)|!filter(?:\s|$))/mu.test(content.value.stdout)) reasons.add("git.filter-attribute");
  }
  const infoAttributes = join(commonDirectory, "info", "attributes");
  if (await exists(infoAttributes)) {
    const metadata = await lstat(infoAttributes);
    if (metadata.isSymbolicLink() || metadata.size > 1024 * 1024) reasons.add("git.attributes-indeterminate");
    else if (/(?:^|\s)(?:filter(?:=|\s)|-filter(?:\s|$)|!filter(?:\s|$))/mu.test(await readFile(infoAttributes, "utf8"))) reasons.add("git.filter-attribute");
  }
  return [...reasons].sort();
}

async function observeRepository(
  repositoryRoot: string,
  approvedSourceRoot: string,
  targetPath: string,
  branchRef: string,
  sourceCommit: string,
  hooksDirectory: string,
  timeoutMs: number,
  requireTargetAbsent: boolean,
): Promise<RepositoryObservation> {
  const reasons = new Set<string>();
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(repositoryRoot);
    if (comparable(canonicalRoot) !== comparable(repositoryRoot) || (await lstat(repositoryRoot)).isSymbolicLink()) reasons.add("git.repository-root-unsafe");
  } catch {
    throw new Error("git.repository-root-unavailable");
  }
  if (!(await assertExistingPathHasNoLinks(repositoryRoot, resolve(repositoryRoot, approvedSourceRoot)))) reasons.add("git.approved-source-link");
  if (!(await assertExistingPathHasNoLinks(repositoryRoot, targetPath))) reasons.add("git.worktree-path-link");

  const root = await runGit(repositoryRoot, hooksDirectory, timeoutMs, ["rev-parse", "--show-toplevel"]);
  if (comparable(resolve(root.stdout.trim())) !== comparable(repositoryRoot)) reasons.add("git.repository-root-mismatch");
  const common = await runGit(repositoryRoot, hooksDirectory, timeoutMs, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = await realpath(resolve(repositoryRoot, common.stdout.trim()));
  if (!(await assertExistingPathHasNoLinks(repositoryRoot, commonDirectory))) reasons.add("git.common-directory-unsafe");
  if (!isWithin(repositoryRoot, commonDirectory)) reasons.add("git.common-directory-unsafe");

  const hazardReasons = await inspectCheckoutHazards(repositoryRoot, commonDirectory, hooksDirectory, timeoutMs, sourceCommit);
  for (const reason of hazardReasons) reasons.add(reason);

  const commit = await optionalGit(repositoryRoot, hooksDirectory, timeoutMs, ["cat-file", "-e", `${sourceCommit}^{commit}`]);
  if (!commit.ok) reasons.add("git.source-commit-missing");
  const targetRef = await optionalGit(repositoryRoot, hooksDirectory, timeoutMs, ["show-ref", "--verify", "--quiet", branchRef]);
  if (requireTargetAbsent && (targetRef.ok || (targetRef.error as { readonly code?: unknown }).code !== 1)) reasons.add("git.target-ref-collision");
  if (requireTargetAbsent && await exists(targetPath)) reasons.add("git.target-path-collision");

  const operationMarkers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock", "rebase-apply", "rebase-merge", "sequencer"];
  if ((await Promise.all(operationMarkers.map((name) => exists(join(commonDirectory, name))))).some(Boolean)) reasons.add("git.operation-active");

  if (reasons.size > 0) {
    const [refsResult, worktreesResult] = await Promise.all([
      runGit(repositoryRoot, hooksDirectory, timeoutMs, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"]),
      runGit(repositoryRoot, hooksDirectory, timeoutMs, ["worktree", "list", "--porcelain"]),
    ]);
    const unavailable = { state: "unavailable" as const, reasonCode: "git.preflight-blocked" };
    return {
      commonDirectory,
      refs: parseRefs(refsResult.stdout),
      worktrees: parseWorktrees(worktreesResult.stdout),
      originalFuture: {
        branchRef: "",
        head: "",
        statusDigest: "",
        indexDigest: "",
        approvedSourceDigest: "",
        availability: { status: unavailable, index: unavailable, approvedSource: unavailable, capture: unavailable },
      },
      reasonCodes: [...reasons].sort(),
    };
  }

  const [branch, head, statusResult, refsResult, worktreesResult, gitDirectoryResult] = await Promise.all([
    runGit(repositoryRoot, hooksDirectory, timeoutMs, ["symbolic-ref", "--quiet", "HEAD"]),
    runGit(repositoryRoot, hooksDirectory, timeoutMs, ["rev-parse", "HEAD"]),
    runGit(repositoryRoot, hooksDirectory, timeoutMs, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
    runGit(repositoryRoot, hooksDirectory, timeoutMs, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"]),
    runGit(repositoryRoot, hooksDirectory, timeoutMs, ["worktree", "list", "--porcelain"]),
    runGit(repositoryRoot, hooksDirectory, timeoutMs, ["rev-parse", "--git-dir"]),
  ]);
  const gitDirectory = resolve(repositoryRoot, gitDirectoryResult.stdout.trim());
  const indexPath = join(gitDirectory, "index");
  const [indexBytes, indexMetadata, approvedSourceDigest] = await Promise.all([
    readFile(indexPath),
    stat(indexPath),
    collectApprovedSourceDigest(repositoryRoot, resolve(repositoryRoot, approvedSourceRoot)),
  ]);
  const originalFuture: BranchPreflightOriginalFuture = {
    branchRef: branch.stdout.trim(),
    head: head.stdout.trim(),
    statusDigest: `sha256:${sha256(statusResult.stdout)}`,
    indexDigest: `sha256:${sha256(JSON.stringify({ bytesDigest: sha256(indexBytes), size: indexMetadata.size, mtimeMs: indexMetadata.mtimeMs, mode: indexMetadata.mode }))}`,
    approvedSourceDigest,
    availability: {
      status: { state: "available" },
      index: { state: "available" },
      approvedSource: { state: "available" },
      capture: { state: "available" },
    },
  };
  return {
    commonDirectory,
    refs: parseRefs(refsResult.stdout),
    worktrees: parseWorktrees(worktreesResult.stdout),
    originalFuture,
    reasonCodes: [...reasons].sort(),
  };
}

async function currentWindowsUserSid(): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const whoami = join(systemRoot, "System32", "whoami.exe");
  const identity = await execFileAsync(whoami, ["/user", "/fo", "csv", "/nh"], { shell: false, encoding: "utf8", windowsHide: true });
  const sid = /"(S-1-[0-9-]+)"/u.exec(identity.stdout)?.[1];
  if (sid === undefined) throw new Error("git.current-user-sid-unavailable");
  return sid;
}

async function setWindowsCurrentUserOnly(directory: string, currentUserSid: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const icacls = join(systemRoot, "System32", "icacls.exe");
  await execFileAsync(icacls, [directory, "/inheritance:r", "/grant:r", `*${currentUserSid}:(OI)(CI)F`], { shell: false, encoding: "utf8", windowsHide: true });
}

async function verifyWindowsCurrentUserOnly(directory: string, currentUserSid: string, unsafeReason: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const accessEvidence = [
    "$acl = Get-Acl -LiteralPath $env:REMO_ACL_PATH",
    "Write-Output ('PROTECTED=' + $acl.AreAccessRulesProtected)",
    "$acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { Write-Output ($_.IdentityReference.Value + '|' + $_.AccessControlType) }",
  ].join("; ");
  const result = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", accessEvidence], {
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    env: { SYSTEMROOT: systemRoot, REMO_ACL_PATH: directory },
  });
  const [protection, ...rules] = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (protection?.toLowerCase() !== "protected=true" || rules.length === 0) throw new Error(unsafeReason);
  if (rules.some((rule) => {
    const [trustee, accessType, ...unexpected] = rule.split("|");
    return unexpected.length !== 0 || comparable(trustee ?? "") !== comparable(currentUserSid) || accessType?.toLowerCase() !== "allow";
  })) throw new Error(unsafeReason);
}

async function verifyEmptyPrivateHooksDirectory(repositoryRoot: string, hooksDirectory: string): Promise<void> {
  if (!(await assertExistingPathHasNoLinks(repositoryRoot, hooksDirectory))) throw new Error("git.hooks-directory-link");
  const metadata = await lstat(hooksDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("git.hooks-directory-link");
  if ((await readdir(hooksDirectory)).length !== 0) throw new Error("git.hooks-directory-not-empty");
  if (process.platform === "win32") await verifyWindowsCurrentUserOnly(hooksDirectory, await currentWindowsUserSid(), "git.hooks-directory-acl-not-current-user-only");
  else if ((metadata.mode & 0o077) !== 0) throw new Error("git.hooks-directory-mode-unsafe");
  if ((await readdir(hooksDirectory)).length !== 0) throw new Error("git.hooks-directory-not-empty");
}

async function verifyEmptyPrivateEnvironment(repositoryRoot: string, environmentRoot: string): Promise<void> {
  const home = join(environmentRoot, "home");
  const xdg = join(environmentRoot, "xdg");
  for (const directory of [environmentRoot, home, xdg]) {
    if (!(await assertExistingPathHasNoLinks(repositoryRoot, directory))) throw new Error("git.private-environment-link");
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("git.private-environment-shape-unsafe");
  }
  const rootEntries = (await readdir(environmentRoot)).sort((a, b) => a.localeCompare(b, "en-US"));
  if (JSON.stringify(rootEntries) !== JSON.stringify(["home", "xdg"])) throw new Error("git.private-environment-shape-unsafe");
  if ((await readdir(home)).length !== 0 || (await readdir(xdg)).length !== 0) throw new Error("git.private-environment-shape-unsafe");
  for (const directory of [environmentRoot, home, xdg]) {
    const metadata = await lstat(directory);
    if (process.platform === "win32") await verifyWindowsCurrentUserOnly(directory, await currentWindowsUserSid(), "git.private-environment-acl-not-current-user-only");
    else if ((metadata.mode & 0o077) !== 0) throw new Error("git.private-environment-mode-unsafe");
  }
}

async function validatePrivateGitStateBeforeObservation(repositoryRoot: string): Promise<void> {
  const privateRoot = join(repositoryRoot, ".remo", "private");
  const hooksDirectory = join(privateRoot, FIXED_HOOKS_DIRECTORY);
  const environmentRoot = join(privateRoot, "git-environment-v1");
  if (!(await assertExistingPathHasNoLinks(repositoryRoot, privateRoot))) throw new Error("git.private-state-link");
  const environmentPresence = await observePathPresence(environmentRoot);
  if (environmentPresence === "indeterminate") throw new Error("git.private-environment-unavailable");
  if (environmentPresence === "present") await verifyEmptyPrivateEnvironment(repositoryRoot, environmentRoot);
  const hooksPresence = await observePathPresence(hooksDirectory);
  if (hooksPresence === "indeterminate") throw new Error("git.hooks-directory-unavailable");
  if (hooksPresence === "present") await verifyEmptyPrivateHooksDirectory(repositoryRoot, hooksDirectory);
}

async function preparePrivateGitState(repositoryRoot: string): Promise<void> {
  const privateRoot = join(repositoryRoot, ".remo", "private");
  const hooksDirectory = join(privateRoot, FIXED_HOOKS_DIRECTORY);
  const environmentRoot = join(privateRoot, "git-environment-v1");
  if (!(await assertExistingPathHasNoLinks(repositoryRoot, privateRoot))) throw new Error("git.private-state-link");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  if (!(await assertExistingPathHasNoLinks(repositoryRoot, privateRoot))) throw new Error("git.private-state-link");

  const environmentPresence = await observePathPresence(environmentRoot);
  if (environmentPresence === "indeterminate") throw new Error("git.private-environment-unavailable");
  if (environmentPresence === "absent") {
    await mkdir(environmentRoot, { mode: 0o700 });
    if (process.platform === "win32") await setWindowsCurrentUserOnly(environmentRoot, await currentWindowsUserSid());
    else await chmod(environmentRoot, 0o700);
    for (const directory of [join(environmentRoot, "home"), join(environmentRoot, "xdg")]) {
      await mkdir(directory, { mode: 0o700 });
      if (process.platform === "win32") await setWindowsCurrentUserOnly(directory, await currentWindowsUserSid());
      else await chmod(directory, 0o700);
    }
  }
  await verifyEmptyPrivateEnvironment(repositoryRoot, environmentRoot);

  const hooksPresence = await observePathPresence(hooksDirectory);
  if (hooksPresence === "indeterminate") throw new Error("git.hooks-directory-unavailable");
  if (hooksPresence === "absent") {
    await mkdir(hooksDirectory, { mode: 0o700 });
    if (process.platform === "win32") await setWindowsCurrentUserOnly(hooksDirectory, await currentWindowsUserSid());
    else await chmod(hooksDirectory, 0o700);
  }
  await verifyEmptyPrivateHooksDirectory(repositoryRoot, hooksDirectory);
}

function sameOriginalFuture(left: BranchPreflightOriginalFuture, right: BranchPreflightOriginalFuture): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function exactRefDelta(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>, branchRef: string, sourceCommit: string): boolean {
  const expected = { ...before, [branchRef]: sourceCommit };
  return JSON.stringify(Object.entries(after).sort()) === JSON.stringify(Object.entries(expected).sort());
}

function exactWorktreeDelta(before: readonly WorktreeRecord[], after: readonly WorktreeRecord[], targetPath: string): boolean {
  const targetRecords = after.filter(({ path }) => comparable(path) === comparable(targetPath));
  if (targetRecords.length !== 1 || before.some(({ path }) => comparable(path) === comparable(targetPath)) || after.length !== before.length + 1) return false;
  const canonical = (record: WorktreeRecord) => ({
    path: comparable(record.path),
    head: record.head,
    branchRef: record.branchRef ?? "",
    locked: record.locked,
    reason: record.reason ?? "",
  });
  const sortRecords = (records: readonly WorktreeRecord[]) => records.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"));
  const remaining = after.filter(({ path }) => comparable(path) !== comparable(targetPath));
  return JSON.stringify(sortRecords(remaining)) === JSON.stringify(sortRecords(before));
}

export class BranchGitAdapter {
  readonly #repositoryRoot: string;
  readonly #approvedSourceRoot: string;
  readonly #timeoutMs: number;

  constructor(options: BranchGitAdapterOptions) {
    if (!isAbsolute(options.repositoryRoot) || resolve(options.repositoryRoot) !== options.repositoryRoot) throw new TypeError("repositoryRoot must be an exact absolute path.");
    const approved = options.approvedSourceRoot.replaceAll("\\", "/");
    if (!SAFE_RELATIVE_ROOT.test(approved) || approved.split("/").includes("..") || approved === "." || approved.startsWith(".remo") || approved.startsWith(".git")) throw new TypeError("approvedSourceRoot must be a safe repository-relative source directory.");
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 60_000)) throw new TypeError("timeoutMs must be between 1000 and 60000.");
    this.#repositoryRoot = options.repositoryRoot;
    this.#approvedSourceRoot = approved;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async createLockedWorktree(request: CreateLockedBranchWorktreeRequest): Promise<BranchGitResult> {
    const requestKeys = Reflect.ownKeys(request).map(String).sort();
    if (JSON.stringify(requestKeys) !== JSON.stringify(["originalFuture", "preflightReceipt"])) return { outcome: "blocked", reasonCodes: ["git.request-fields-invalid"] };
    let receipt: BranchPreflightReceipt;
    try {
      receipt = assertBranchPreflightReceipt(request.preflightReceipt);
    } catch {
      return { outcome: "blocked", reasonCodes: ["git.preflight-malformed"] };
    }
    const expectedIdentity = deriveBranchPreflightIdentity(receipt.savePointId, receipt.savePointRevision);
    if (JSON.stringify(receipt.target) !== JSON.stringify(expectedIdentity)) return { outcome: "blocked", reasonCodes: ["git.derived-identity-mismatch"] };
    if (!receipt.ready || receipt.checks.some(({ state }) => state !== "pass")) return { outcome: "blocked", reasonCodes: ["git.preflight-blocked"] };
    if (Date.now() >= Date.parse(receipt.expiresAt)) return { outcome: "blocked", reasonCodes: ["git.preflight-expired"] };
    if (!COMMIT.test(receipt.sourceCommit)) return { outcome: "blocked", reasonCodes: ["git.source-commit-invalid"] };
    if (sha256Canonical(receiptBody(receipt)) !== receipt.digest) return { outcome: "blocked", reasonCodes: ["git.preflight-digest-mismatch"] };
    if (sha256Canonical(request.originalFuture) !== receipt.originalFutureDigest) return { outcome: "blocked", reasonCodes: ["git.original-future-digest-mismatch"] };

    const targetPath = resolve(this.#repositoryRoot, ...receipt.target.worktreeRelativePath.split("/"));
    const expectedTarget = join(this.#repositoryRoot, ".remo", "worktrees", receipt.target.operationId);
    if (comparable(targetPath) !== comparable(expectedTarget) || !isWithin(this.#repositoryRoot, targetPath)) return { outcome: "blocked", reasonCodes: ["git.worktree-path-invalid"] };
    if (targetPath.length > MAX_SAFE_DERIVED_WORKTREE_PATH) return { outcome: "blocked", reasonCodes: ["git.worktree-path-too-long"] };
    const shortBranch = receipt.target.branchRef.slice("refs/heads/".length);
    const hooksDirectory = join(this.#repositoryRoot, ".remo", "private", FIXED_HOOKS_DIRECTORY);
    const environmentRoot = join(this.#repositoryRoot, ".remo", "private", "git-environment-v1");

    try {
      // This validation is read-only: absent derived paths are safe, while any
      // pre-existing HOME/XDG/hooks must already have the exact trusted shape
      // before the first Git child receives those pinned paths.
      await validatePrivateGitStateBeforeObservation(this.#repositoryRoot);
    } catch (error) {
      return { outcome: "blocked", reasonCodes: [processFailure(error).message] };
    }

    let before: RepositoryObservation;
    try {
      before = await observeRepository(this.#repositoryRoot, this.#approvedSourceRoot, targetPath, receipt.target.branchRef, receipt.sourceCommit, hooksDirectory, this.#timeoutMs, true);
    } catch (error) {
      const failure = processFailure(error);
      return { outcome: "blocked", reasonCodes: [failure.message.includes("dubious ownership") ? "git.ownership-unsafe" : failure.code === "ENOENT" ? "git.process-unavailable" : "git.preflight-observation-failed"] };
    }
    if (before.reasonCodes.length > 0) return { outcome: "blocked", reasonCodes: before.reasonCodes };
    if (!sameOriginalFuture(before.originalFuture, request.originalFuture)) return { outcome: "blocked", reasonCodes: ["git.original-future-stale"], observed: { originalFutureBefore: before.originalFuture } };

    try {
      await preparePrivateGitState(this.#repositoryRoot);
      await verifyEmptyPrivateEnvironment(this.#repositoryRoot, environmentRoot);
      // This is deliberately the final awaited check before constructing and
      // executing the fixed creation argv. A same-user process can still race
      // external state after this boundary; post-create verification exposes
      // that as recovery-required rather than relaxing or cleaning up.
      await verifyEmptyPrivateHooksDirectory(this.#repositoryRoot, hooksDirectory);
    } catch (error) {
      return { outcome: "blocked", reasonCodes: [processFailure(error).message] };
    }
    const creationArgs = [
      ...fixedGitPrefix(hooksDirectory),
      "worktree", "add", "--lock", "--reason", FIXED_LOCK_REASON,
      "-b", shortBranch, targetPath, receipt.sourceCommit,
    ] as const;
    const creationCommand: ObservedGitCommand = { executable: "git", argv: creationArgs, cwd: this.#repositoryRoot, shell: false };
    try {
      await execFileAsync("git", [...creationArgs], {
        cwd: this.#repositoryRoot,
        timeout: this.#timeoutMs,
        shell: false,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        env: controlledEnvironment(hooksDirectory),
      });
    } catch (error) {
      const processError = processFailure(error);
      const ref = await optionalGit(this.#repositoryRoot, hooksDirectory, this.#timeoutMs, ["show-ref", "--verify", "--quiet", receipt.target.branchRef]);
      const pathPresence = await observePathPresence(targetPath);
      const refProvenAbsent = !ref.ok && hasProcessExitCode(ref.error, 1);
      const effectIndeterminate = (!ref.ok && !refProvenAbsent) || pathPresence === "indeterminate";
      const noEffect = refProvenAbsent && pathPresence === "absent";
      return {
        outcome: noEffect ? "failed-no-effect" : "recovery-required",
        reasonCodes: [noEffect ? "git.creation-process-failed-no-effect" : effectIndeterminate ? "git.creation-process-failed-effect-indeterminate" : "git.creation-process-failed-partial"],
        observed: { branchRef: receipt.target.branchRef, worktreePath: targetPath, hooksDirectory, creationCommand },
        processError,
      };
    }

    let after: RepositoryObservation;
    try {
      after = await observeRepository(this.#repositoryRoot, this.#approvedSourceRoot, targetPath, receipt.target.branchRef, receipt.sourceCommit, hooksDirectory, this.#timeoutMs, false);
    } catch (error) {
      return {
        outcome: "recovery-required",
        reasonCodes: ["git.post-create-observation-failed"],
        observed: { branchRef: receipt.target.branchRef, worktreePath: targetPath, hooksDirectory, creationCommand },
        processError: processFailure(error),
      };
    }
    const refCommit = after.refs[receipt.target.branchRef] ?? "";
    const record = after.worktrees.find(({ path }) => comparable(path) === comparable(targetPath));
    let worktreeCommit = "";
    let worktreeBranchRef = "";
    let worktreeCommonDirectory = "";
    let worktreeStatus = "verification-unavailable";
    try {
      worktreeCommit = (await runGit(targetPath, hooksDirectory, this.#timeoutMs, ["rev-parse", "HEAD"])).stdout.trim();
      worktreeBranchRef = (await runGit(targetPath, hooksDirectory, this.#timeoutMs, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
      worktreeCommonDirectory = await realpath(resolve(targetPath, (await runGit(targetPath, hooksDirectory, this.#timeoutMs, ["rev-parse", "--git-common-dir"])).stdout.trim()));
      worktreeStatus = (await runGit(targetPath, hooksDirectory, this.#timeoutMs, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).stdout;
    } catch {
      // Empty observed fields fail verification below.
    }
    const originalFutureEqual = sameOriginalFuture(before.originalFuture, after.originalFuture);
    const evidence: ObservedBranchGitEvidence = {
      sourceCommit: receipt.sourceCommit,
      branchRef: receipt.target.branchRef,
      shortBranch,
      worktreePath: targetPath,
      hooksDirectory,
      lockReason: FIXED_LOCK_REASON,
      refCommit,
      worktreeCommit,
      worktreeBranchRef,
      worktreeClean: worktreeStatus === "",
      worktreeStatus,
      canonicalCommonDirectory: after.commonDirectory,
      worktreeCommonDirectory,
      locked: record?.locked === true,
      observedLockReason: record?.reason ?? "",
      exactRefDelta: exactRefDelta(before.refs, after.refs, receipt.target.branchRef, receipt.sourceCommit),
      exactWorktreeDelta: exactWorktreeDelta(before.worktrees, after.worktrees, targetPath),
      originalFutureBefore: before.originalFuture,
      originalFutureAfter: after.originalFuture,
      originalFutureEqual,
      creationCommand,
    };
    const verified = after.reasonCodes.length === 0
      && refCommit === receipt.sourceCommit
      && worktreeCommit === receipt.sourceCommit
      && worktreeBranchRef === receipt.target.branchRef
      && evidence.worktreeClean
      && comparable(after.commonDirectory) === comparable(worktreeCommonDirectory)
      && evidence.locked
      && evidence.observedLockReason === FIXED_LOCK_REASON
      && evidence.exactRefDelta
      && evidence.exactWorktreeDelta
      && evidence.originalFutureEqual;
    return verified
      ? { outcome: "succeeded", evidence }
      : { outcome: "recovery-required", reasonCodes: [...after.reasonCodes, "git.post-create-verification-failed"], observed: evidence };
  }

  async observeExistingTarget(request: ObserveExistingBranchTargetRequest): Promise<ExistingBranchTargetObservation> {
    const requestKeys = Reflect.ownKeys(request).map(String).sort();
    if (JSON.stringify(requestKeys) !== JSON.stringify(["originalFuture", "savePointId", "savePointRevision", "sourceCommit"])) {
      return { outcome: "recovery-required", reasonCodes: ["git.existing-target-request-fields-invalid"], observed: { operationId: "unavailable", branchRef: "unavailable", worktreePath: "unavailable" } };
    }
    let target: ReturnType<typeof deriveBranchPreflightIdentity>;
    try {
      target = deriveBranchPreflightIdentity(request.savePointId, request.savePointRevision);
    } catch {
      return { outcome: "recovery-required", reasonCodes: ["git.existing-target-identity-invalid"], observed: { operationId: "unavailable", branchRef: "unavailable", worktreePath: "unavailable" } };
    }
    const targetPath = resolve(this.#repositoryRoot, ...target.worktreeRelativePath.split("/"));
    const expectedTarget = join(this.#repositoryRoot, ".remo", "worktrees", target.operationId);
    const observedIdentity = { operationId: target.operationId, branchRef: target.branchRef, worktreePath: targetPath };
    if (!COMMIT.test(request.sourceCommit) || comparable(targetPath) !== comparable(expectedTarget) || !isWithin(this.#repositoryRoot, targetPath) || targetPath.length > MAX_SAFE_DERIVED_WORKTREE_PATH) {
      return { outcome: "recovery-required", reasonCodes: ["git.existing-target-identity-invalid"], observed: observedIdentity };
    }
    const hooksDirectory = join(this.#repositoryRoot, ".remo", "private", FIXED_HOOKS_DIRECTORY);
    try {
      await validatePrivateGitStateBeforeObservation(this.#repositoryRoot);
    } catch (error) {
      return { outcome: "recovery-required", reasonCodes: ["git.existing-target-private-state-indeterminate", processFailure(error).message], observed: observedIdentity, processError: processFailure(error) };
    }

    const pathPresence = await observePathPresence(targetPath);
    if (pathPresence === "indeterminate") return { outcome: "recovery-required", reasonCodes: ["git.existing-target-path-indeterminate"], observed: observedIdentity };
    let repository: RepositoryObservation;
    try {
      repository = await observeRepository(this.#repositoryRoot, this.#approvedSourceRoot, targetPath, target.branchRef, request.sourceCommit, hooksDirectory, this.#timeoutMs, false);
    } catch (error) {
      const failure = processFailure(error);
      return { outcome: "recovery-required", reasonCodes: ["git.existing-target-observation-indeterminate"], observed: observedIdentity, processError: failure };
    }
    const refCommit = repository.refs[target.branchRef];
    const records = repository.worktrees.filter(({ path }) => comparable(path) === comparable(targetPath));
    if (refCommit === undefined && pathPresence === "absent" && records.length === 0) {
      return { outcome: "absent", reasonCodes: ["git.existing-target-absent"], observed: observedIdentity };
    }

    const partialReasons = new Set(repository.reasonCodes);
    if (refCommit === undefined) partialReasons.add("git.existing-target-ref-absent");
    if (pathPresence === "absent") partialReasons.add("git.existing-target-path-absent");
    if (records.length !== 1) partialReasons.add(records.length === 0 ? "git.existing-target-worktree-unregistered" : "git.existing-target-worktree-ambiguous");
    if (refCommit === undefined || pathPresence !== "present" || records.length !== 1) {
      return { outcome: "recovery-required", reasonCodes: [...partialReasons].sort(), observed: { ...observedIdentity, ...(refCommit === undefined ? {} : { refCommit }) } };
    }

    const record = records[0]!;
    let worktreeCommit = "";
    let worktreeBranchRef = "";
    let worktreeCommonDirectory = "";
    let worktreeStatus = "verification-unavailable";
    try {
      worktreeCommit = (await runGit(targetPath, hooksDirectory, this.#timeoutMs, ["rev-parse", "HEAD"])).stdout.trim();
      worktreeBranchRef = (await runGit(targetPath, hooksDirectory, this.#timeoutMs, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
      worktreeCommonDirectory = await realpath(resolve(targetPath, (await runGit(targetPath, hooksDirectory, this.#timeoutMs, ["rev-parse", "--git-common-dir"])).stdout.trim()));
      worktreeStatus = (await runGit(targetPath, hooksDirectory, this.#timeoutMs, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).stdout;
    } catch (error) {
      return { outcome: "recovery-required", reasonCodes: ["git.existing-target-worktree-observation-indeterminate"], observed: { ...observedIdentity, refCommit }, processError: processFailure(error) };
    }
    const originalFutureEqual = sameOriginalFuture(request.originalFuture, repository.originalFuture);
    const targetIdentityExact = record.path !== "" && comparable(record.path) === comparable(targetPath);
    const evidence: ObservedExistingBranchTargetEvidence = {
      ...observedIdentity,
      sourceCommit: request.sourceCommit,
      refCommit,
      worktreeCommit,
      worktreeBranchRef,
      worktreeClean: worktreeStatus === "",
      worktreeStatus,
      canonicalCommonDirectory: repository.commonDirectory,
      worktreeCommonDirectory,
      locked: record.locked,
      observedLockReason: record.reason ?? "",
      targetIdentityExact,
      originalFutureExpected: request.originalFuture,
      originalFutureObserved: repository.originalFuture,
      originalFutureEqual,
    };
    if (refCommit !== request.sourceCommit) partialReasons.add("git.existing-target-ref-head-mismatch");
    if (worktreeCommit !== request.sourceCommit) partialReasons.add("git.existing-target-worktree-head-mismatch");
    if (worktreeBranchRef !== target.branchRef) partialReasons.add("git.existing-target-worktree-branch-mismatch");
    if (!evidence.worktreeClean) partialReasons.add("git.existing-target-worktree-dirty");
    if (comparable(repository.commonDirectory) !== comparable(worktreeCommonDirectory)) partialReasons.add("git.existing-target-common-directory-mismatch");
    if (!record.locked) partialReasons.add("git.existing-target-unlocked");
    if (record.reason !== FIXED_LOCK_REASON) partialReasons.add("git.existing-target-lock-reason-mismatch");
    if (!targetIdentityExact) partialReasons.add("git.existing-target-identity-mismatch");
    if (!originalFutureEqual) partialReasons.add("git.existing-target-original-future-drift");
    return partialReasons.size === 0
      ? { outcome: "exact-success", evidence }
      : { outcome: "recovery-required", reasonCodes: [...partialReasons].sort(), observed: evidence };
  }
}

export const BRANCH_GIT_FIXED_PROFILE = Object.freeze({
  hooksDirectoryName: FIXED_HOOKS_DIRECTORY,
  lockReason: FIXED_LOCK_REASON,
  maxDerivedWorktreePath: MAX_SAFE_DERIVED_WORKTREE_PATH,
  configKeys: ["core.hooksPath", "core.fsmonitor"] as const,
  creationForm: ["worktree", "add", "--lock", "--reason", "-b"] as const,
});
