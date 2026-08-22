import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertBranchPreflightReceipt, assertDecisionRecord, canonicalSerialize, isEvidenceMediaRole, sha256Canonical, type EvidenceDescriptor, type EvidenceMediaReadRequest, type EvidenceMediaReadResult, type HistoryAnchor, type HistoryPage, type LineageRecord } from "@remo/domain";
export { canonicalSerialize } from "@remo/domain";
import { deterministicZip, zipSha256, type ZipEntry } from "./export/deterministic-zip.js";
import {
  CANDIDATE_RETENTION_MS,
  DURABLE_RETENTION_MS,
  LifecycleConfirmationRequiredError,
  LifecycleCrashError,
  LifecycleIdempotencyConflictError,
  LifecycleUnavailableError,
  MAX_EXPORT_BYTES,
  type CandidateRegistration,
  type DeletionReceipt,
  type DeletionReceiptState,
  type ExportExclusion,
  type ExportInventoryEntry,
  type ExportReceipt,
  type LifecycleCrashPoint,
  type LifecycleMutationResult,
  type LifecycleProjection,
  type SweepReceipt,
} from "./lifecycle/contracts.js";
import type {
  AppendReconciliationRequest,
  DurableManifestRevision,
  ReconciliationCrashPoint,
} from "./reconciliation/contracts.js";
import { FoundationConflictError, type BranchOperationCompletion, type BranchOperationIntent, type BranchOperationReceipt, type DecisionRevisionAppend, type DecisionRevisionRead, type DecisionRevisionReceipt, type ReplayFoundationStore } from "./foundations/contracts.js";

export type {
  AppendReconciliationRequest,
  DurableManifestRevision,
  ReconciliationCrashPoint,
} from "./reconciliation/contracts.js";
export { FoundationConflictError } from "./foundations/contracts.js";
export type { BranchOperationCompletion, BranchOperationIntent, BranchOperationReceipt, BranchOperationState, DecisionRevisionAppend, DecisionRevisionRead, DecisionRevisionReceipt, ReplayFoundationStore } from "./foundations/contracts.js";
export {
  CANDIDATE_RETENTION_MS,
  DURABLE_RETENTION_MS,
  LifecycleConfirmationRequiredError,
  LifecycleCrashError,
  LifecycleIdempotencyConflictError,
  LifecycleUnavailableError,
  MAX_EXPORT_BYTES,
} from "./lifecycle/contracts.js";
export type {
  CandidateRegistration,
  DeletionReceipt,
  DeletionReceiptState,
  ExportExclusion,
  ExportInventoryEntry,
  ExportReceipt,
  LifecycleCrashPoint,
  LifecycleMutationResult,
  LifecycleProjection,
  SweepReceipt,
} from "./lifecycle/contracts.js";

export const STORAGE_SCHEMA_VERSION = 4;
export const MAX_EVIDENCE_MEDIA_BYTES = 4 * 1024 * 1024;
const DURABLE_SCHEMA_VERSION = "remo.durable-manifest.v1";
const RECONCILED_SCHEMA_VERSION = "remo.reconciled-manifest.v1";

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decisionCanonicalDigest(value: unknown, canonical: string): string {
  if (typeof value === "object" && value !== null && (value as { readonly schemaVersion?: unknown }).schemaVersion === "remo.decision.v1") return assertDecisionRecord(value).digest;
  return sha256(canonical);
}

function withDecisionDescriptorDigest(bundle: unknown, decisionDigest: string): unknown {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) throw new FoundationConflictError("decision.revision-conflict", "Decision evidence requires a canonical bundle object.");
  const value = bundle as { readonly evidence?: unknown };
  if (!Array.isArray(value.evidence)) throw new FoundationConflictError("decision.revision-conflict", "Decision evidence requires a canonical evidence list.");
  let matched = 0;
  const evidenceEntries: readonly unknown[] = value.evidence;
  const evidence = evidenceEntries.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || (entry as { readonly componentType?: unknown }).componentType !== "decision") return entry;
    matched += 1;
    return { ...(entry as Record<string, unknown>), digest: decisionDigest };
  });
  if (matched !== 1) throw new FoundationConflictError("decision.revision-conflict", "Decision evidence requires exactly one decision descriptor.");
  return { ...(bundle as Record<string, unknown>), evidence };
}

function assertDigest(digest: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new TypeError("Expected a canonical SHA-256 digest");
}

function safeSegment(value: string, label: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(value)) throw new TypeError(`${label} is not a safe path segment`);
  return value;
}

interface FixtureHistoryIdentity { readonly sequenceNo: number; readonly label: string; }

function fixtureHistoryIdentity(bundle: unknown): FixtureHistoryIdentity | undefined {
  const evidence = (bundle as { readonly evidence?: unknown })?.evidence;
  if (!Array.isArray(evidence)) return undefined;
  const identities = new Map<string, FixtureHistoryIdentity>();
  for (const descriptor of evidence) {
    const fixtureId = (descriptor as { readonly claims?: { readonly fixtureId?: unknown } })?.claims?.fixtureId;
    if (typeof fixtureId !== "string") continue;
    const match = /^vs001-sequence:(\d+):(.+)$/u.exec(fixtureId);
    if (match === null) continue;
    const sequenceNo = Number(match[1]);
    if (!Number.isSafeInteger(sequenceNo) || sequenceNo < 1 || sequenceNo > 10 || match[2]!.length > 160) throw new Error("History fixture sequence is invalid.");
    identities.set(fixtureId, { sequenceNo, label: match[2]! });
  }
  if (identities.size === 0) return undefined;
  const values = [...identities.values()];
  if (new Set(values.map(({ sequenceNo }) => sequenceNo)).size !== 1 || new Set(values.map(({ label }) => label)).size !== 1) throw new Error("History fixture sequence is ambiguous.");
  return values[0];
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp`);
}

function isEvidenceDescriptorList(value: unknown): value is readonly EvidenceDescriptor[] {
  return Array.isArray(value) && value.every((item: unknown) => {
    if (item === null || typeof item !== "object") return false;
    const descriptor = item as Record<string, unknown>;
    return typeof descriptor.componentId === "string" && typeof descriptor.componentType === "string" && typeof descriptor.digest === "string" && typeof descriptor.availability === "string" && descriptor.correlation !== null && typeof descriptor.correlation === "object";
  });
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Private storage path cannot be a symbolic link or junction/reparse point: ${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  if (!statSync(path).isDirectory()) throw new Error(`Private storage path is not a directory: ${path}`);
}

function assertNoReparseWithin(projectRoot: string, target: string): void {
  const root = resolve(projectRoot);
  const relativeTarget = relative(root, resolve(target));
  if (relativeTarget.startsWith("..") || resolve(root, relativeTarget) !== resolve(target)) throw new Error("Private storage path escapes the canonical project root");
  let cursor = root;
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Private storage path contains a symbolic link, junction, or reparse point: ${cursor}`);
  }
}

const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$windowsPowerShellModules = [System.IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules')
$managementModule = [System.IO.Path]::Combine($windowsPowerShellModules, 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1')
$securityModule = [System.IO.Path]::Combine($windowsPowerShellModules, 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')
Import-Module -Name $managementModule -Force -ErrorAction Stop
Import-Module -Name $securityModule -Force -ErrorAction Stop
if ($PSModuleAutoLoadingPreference -ne 'None') { throw 'PowerShell module autoloading was not disabled' }
$getItemCommand = Get-Command -Name 'Get-Item' -ErrorAction Stop
$getChildItemCommand = Get-Command -Name 'Get-ChildItem' -ErrorAction Stop
$getAclCommand = Get-Command -Name 'Get-Acl' -ErrorAction Stop
if (-not [string]::Equals([System.IO.Path]::GetFullPath($getItemCommand.Module.Path), [System.IO.Path]::GetFullPath($managementModule), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Get-Item did not resolve from the trusted inbox Management module' }
if (-not [string]::Equals([System.IO.Path]::GetFullPath($getChildItemCommand.Module.Path), [System.IO.Path]::GetFullPath($managementModule), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Get-ChildItem did not resolve from the trusted inbox Management module' }
if (-not [string]::Equals([System.IO.Path]::GetFullPath($getAclCommand.Module.Path), [System.IO.Path]::GetFullPath($securityModule), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Get-Acl did not resolve from the trusted inbox Security module' }
$root = $env:REMO_PRIVATE_ROOT
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:REMO_PRIVATE_SID)
$items = @((Get-Item -LiteralPath $root)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse)
foreach ($item in $items) {
  $acl = Get-Acl -LiteralPath $item.FullName
  if ($item.FullName -eq $root -and -not $acl.AreAccessRulesProtected) { throw "Private boundary ACL inheritance remains enabled: $($item.FullName)" }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -lt 1) { throw "ACL has no current-user access rule: $($item.FullName)" }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow') { throw "ACL is not current-user-only: $($item.FullName)" }
  }
}
`;

function windowsCurrentSid(): string {
  const output = execFileSync("C:\\Windows\\System32\\whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const match = /"(S-[0-9-]+)"/u.exec(output);
  if (match?.[1] === undefined) throw new Error("Unable to verify the current Windows user SID");
  return match[1];
}

export function assertPrivateTreePermissions(root: string): void {
  if (process.platform === "win32") {
    const sid = windowsCurrentSid();
    const encoded = Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64");
    execFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: { ...process.env, REMO_PRIVATE_ROOT: root, REMO_PRIVATE_SID: sid },
      windowsHide: true,
      stdio: "pipe",
    });
    return;
  }
  const visit = (path: string): void => {
    const item = lstatSync(path);
    if (item.isSymbolicLink()) throw new Error(`Private storage contains a symbolic link: ${path}`);
    if ((statSync(path).mode & 0o077) !== 0) throw new Error(`Owner-only permissions could not be verified: ${path}`);
    if (item.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
}

function secureAndVerifyPrivateTree(root: string): void {
  // Preserve an already-private tree. Rewriting every descendant on restart can
  // change a stricter component-owned ACL (such as branch-git's protected
  // HOME/XDG directories) even though the storage boundary is already safe.
  try {
    assertPrivateTreePermissions(root);
    return;
  } catch {
    // Repair the complete tree below, then fail closed if verification still fails.
  }
  if (process.platform === "win32") {
    const sid = windowsCurrentSid();
    const icacls = "C:\\Windows\\System32\\icacls.exe";
    const common = { windowsHide: true, stdio: "pipe" as const };
    execFileSync(icacls, [root, "/reset", "/T", "/C", "/Q"], common);
    execFileSync(icacls, [root, "/inheritance:r", "/T", "/C", "/Q"], common);
    execFileSync(icacls, [root, "/grant:r", `*${sid}:(OI)(CI)F`, "/T", "/C", "/Q"], common);
  } else {
    const secure = (path: string): void => {
      const item = lstatSync(path);
      if (item.isSymbolicLink()) throw new Error(`Private storage contains a symbolic link: ${path}`);
      chmodSync(path, item.isDirectory() ? 0o700 : 0o600);
      if (item.isDirectory()) for (const entry of readdirSync(path)) secure(join(path, entry));
    };
    secure(root);
  }
  assertPrivateTreePermissions(root);
}

function fsyncDirectory(path: string): void {
  try {
    const handle = openSync(path, "r");
    try { fsyncSync(handle); } finally { closeSync(handle); }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function writeAndFsync(path: string, bytes: Buffer | string): void {
  const handle = openSync(path, "wx", 0o600);
  try {
    writeFileSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  chmodSync(path, 0o600);
}

export type PromotionCrashPoint =
  | "before-staged-fsync"
  | "after-staged-fsync"
  | "before-blob-rename"
  | "after-blob-rename"
  | "before-transaction-commit"
  | "after-transaction-commit"
  | "before-manifest-materialization"
  | "after-manifest-materialization";

export type StorageCrashPoint = PromotionCrashPoint | ReconciliationCrashPoint;

export class PromotionCrashError extends Error {
  constructor(readonly crashPoint: StorageCrashPoint) {
    super(`Injected promotion crash at ${crashPoint}`);
    this.name = "PromotionCrashError";
  }
}

export interface PromotionBlob {
  readonly role: string;
  readonly bytes: Buffer;
  readonly expectedDigest: string;
}

export interface PromotionRequest {
  readonly operationId: string;
  readonly turnId: string;
  readonly savePointId: string;
  readonly revision: number;
  readonly candidateRevision: number;
  readonly candidateManifestDigest: string;
  readonly createdAt: string;
  readonly policyRevision: string;
  readonly bundle: unknown;
  readonly blobs: readonly PromotionBlob[];
}

export interface DurableSaveReceipt {
  readonly status: "durable";
  readonly turnId: string;
  readonly savePointId: string;
  readonly revision: number;
  readonly candidateRevision: number;
  readonly candidateManifestDigest: string;
  readonly manifestDigest: string;
  readonly manifestPath: string;
  readonly createdAt: string;
  readonly promotedAt: string;
  readonly expiresAt: string;
  readonly pinned: boolean;
  readonly health: "complete" | "incomplete";
  readonly fidelity: "editable-eligible" | "degraded";
  readonly reasonCodes: readonly string[];
}

export interface CurrentDurableSavePoint {
  readonly receipt: DurableSaveReceipt;
  readonly revision: DurableManifestRevision;
  readonly lifecycle: LifecycleProjection;
  readonly bundle: unknown;
}

interface SavePointRow {
  turn_id: string;
  save_point_id: string;
  revision: number;
  manifest_digest: string;
  manifest_path: string;
  canonical_json: string;
  receipt_json: string;
  materialized: number;
  health: "complete" | "incomplete";
  fidelity: "editable-eligible" | "degraded";
  reasons_json: string;
  created_at: string;
  promoted_at: string;
  expires_at: string;
  pinned_at: string | null;
  quarantined_at: string | null;
}

interface BlobRow { role: string; digest: string; byte_size: number; relative_path: string; }

interface RevisionRow {
  save_point_id: string;
  turn_id: string;
  revision: number;
  predecessor_revision: number;
  predecessor_manifest_digest: string;
  manifest_digest: string;
  manifest_path: string;
  canonical_json: string;
  receipt_json: string;
  trace_validated_at: string | null;
  materialized: number;
}

interface CandidateRow {
  turn_id: string;
  save_point_id: string;
  revision: number;
  manifest_digest: string;
  canonical_json: string;
  created_at: string;
  expires_at: string;
  pinned_at: string | null;
  quarantined_at: string | null;
  policy_revision: string;
  source_save_point_id: string | null;
}

interface LifecycleReceiptRow {
  subject: "candidate" | "durable";
  target_id: string;
  action: string;
  result_json: string;
}

interface ExportRow { save_point_id: string; path: string; digest: string; result_json: string; }

interface HistoryRow {
  save_point_id: string;
  turn_id: string;
  sequence_no: number;
  lineage_id: string;
  parent_save_point_id: string | null;
  promoted_at: string | null;
  major_turn_label: string | null;
  nomination_reason: string | null;
  state: "active" | "quarantined" | "tombstone";
  lifecycle_receipt_id: string | null;
  provenance: "observed" | "fixture-contract" | "reconstructed-order";
  integrity: "complete" | "incomplete" | "quarantined" | "deleted";
  fidelity: "editable-eligible" | "degraded" | "unavailable";
}

interface BranchOperationRow {
  operation_id: string;
  intent_key: string;
  save_point_id: string;
  preflight_digest: string;
  original_future_digest: string;
  branch_ref: string;
  worktree_relative_path: string;
  state: "pending" | "succeeded" | "failed" | "recovery-required";
  canonical_result: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReconciliationResult {
  readonly turnId: string;
  readonly savePointId: string;
  readonly health: "complete" | "incomplete";
  readonly fidelity: "editable-eligible" | "degraded";
  readonly reasonCodes: readonly string[];
}

export interface SavePointRepository extends ReplayFoundationStore {
  promote(request: PromotionRequest): DurableSaveReceipt;
  getDurable(turnId: string): DurableSaveReceipt | undefined;
  listCurrentDurable(): readonly CurrentDurableSavePoint[];
  getCurrentRevision(savePointId: string): DurableManifestRevision | undefined;
  appendReconciliation(request: AppendReconciliationRequest): DurableManifestRevision;
  countDurable(): number;
  reconcileStartup(): readonly ReconciliationResult[];
  getLifecycle(savePointId: string): LifecycleProjection | undefined;
  close(): void;
}

export class LocalSavePointRepository implements SavePointRepository {
  readonly remoRoot: string;
  readonly catalogPath: string;
  readonly blobsRoot: string;
  readonly manifestsRoot: string;
  readonly stagingRoot: string;
  readonly exportsRoot: string;
  readonly receiptsRoot: string;
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private readonly crashPoint: StorageCrashPoint | undefined;
  private readonly crashAction: ((at: StorageCrashPoint) => void) | undefined;
  private readonly lifecycleCrashPoint: LifecycleCrashPoint | undefined;
  private active = false;
  private defensiveEnabled = false;

  constructor(options: { readonly projectRoot: string; readonly now?: () => Date; readonly crashPoint?: StorageCrashPoint; readonly crashAction?: (at: StorageCrashPoint) => void; readonly lifecycleCrashPoint?: LifecycleCrashPoint }) {
    const projectRoot = realpathSync.native(resolve(options.projectRoot));
    this.remoRoot = join(projectRoot, ".remo");
    this.catalogPath = join(this.remoRoot, "catalog.sqlite");
    this.blobsRoot = join(this.remoRoot, "blobs", "sha256");
    this.manifestsRoot = join(this.remoRoot, "manifests");
    this.stagingRoot = join(this.remoRoot, "staging");
    this.exportsRoot = join(this.remoRoot, "exports");
    this.receiptsRoot = join(this.remoRoot, "receipts");
    this.now = options.now ?? (() => new Date());
    this.crashPoint = options.crashPoint;
    this.crashAction = options.crashAction;
    this.lifecycleCrashPoint = options.lifecycleCrashPoint;
    assertNoReparseWithin(projectRoot, this.remoRoot);
    assertNoReparseWithin(projectRoot, this.blobsRoot);
    for (const path of [this.remoRoot, this.blobsRoot, this.manifestsRoot, this.stagingRoot, this.exportsRoot, this.receiptsRoot]) ensurePrivateDirectory(path);
    this.database = new DatabaseSync(this.catalogPath, { timeout: 1_000 });
    try {
      this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
      this.migrate();
      (this.database as DatabaseSync & { enableDefensive(active: boolean): void }).enableDefensive(true);
      this.defensiveEnabled = true;
      this.reconcileStartup();
      this.sweepExpired();
      secureAndVerifyPrivateTree(this.remoRoot);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private migrate(): void {
    const row = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > STORAGE_SCHEMA_VERSION) throw new Error(`Unsupported storage schema version ${row.user_version}`);
    if (row.user_version > 0 && row.user_version < STORAGE_SCHEMA_VERSION) this.backupBeforeMigration(row.user_version);
    if (row.user_version === 0) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE save_points(
          turn_id TEXT PRIMARY KEY,
          save_point_id TEXT NOT NULL UNIQUE,
          revision INTEGER NOT NULL CHECK(revision > 0),
          candidate_revision INTEGER NOT NULL CHECK(candidate_revision > 0),
          candidate_manifest_digest TEXT NOT NULL,
          manifest_digest TEXT NOT NULL,
          manifest_path TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          promoted_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          pinned_at TEXT,
          materialized INTEGER NOT NULL DEFAULT 0 CHECK(materialized IN (0, 1)),
          health TEXT NOT NULL CHECK(health IN ('complete', 'incomplete')),
          fidelity TEXT NOT NULL CHECK(fidelity IN ('editable-eligible', 'degraded')),
          reasons_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE save_point_blobs(
          save_point_id TEXT NOT NULL,
          role TEXT NOT NULL,
          digest TEXT NOT NULL,
          byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
          relative_path TEXT NOT NULL,
          PRIMARY KEY(save_point_id, role),
          FOREIGN KEY(save_point_id) REFERENCES save_points(save_point_id) ON DELETE CASCADE
        ) STRICT;
        CREATE TABLE save_point_revisions(
          save_point_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 1),
          predecessor_revision INTEGER NOT NULL CHECK(predecessor_revision > 0),
          predecessor_manifest_digest TEXT NOT NULL,
          manifest_digest TEXT NOT NULL,
          manifest_path TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          trace_validated_at TEXT,
          materialized INTEGER NOT NULL DEFAULT 0 CHECK(materialized IN (0, 1)),
          PRIMARY KEY(save_point_id, revision),
          UNIQUE(save_point_id, manifest_digest),
          FOREIGN KEY(save_point_id) REFERENCES save_points(save_point_id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${new Date(0).toISOString()}');
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, '${new Date(0).toISOString()}');
        PRAGMA user_version=2;
        COMMIT;
      `);
    } else if (row.user_version === 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE save_point_revisions(
          save_point_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 1),
          predecessor_revision INTEGER NOT NULL CHECK(predecessor_revision > 0),
          predecessor_manifest_digest TEXT NOT NULL,
          manifest_digest TEXT NOT NULL,
          manifest_path TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          trace_validated_at TEXT,
          materialized INTEGER NOT NULL DEFAULT 0 CHECK(materialized IN (0, 1)),
          PRIMARY KEY(save_point_id, revision),
          UNIQUE(save_point_id, manifest_digest),
          FOREIGN KEY(save_point_id) REFERENCES save_points(save_point_id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, '${new Date(0).toISOString()}');
        PRAGMA user_version=2;
        COMMIT;
      `);
    }
    const current = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (current.user_version === 2) {
      const savePointColumns = this.database.prepare("PRAGMA table_info(save_points)").all() as unknown as Array<{ name: string }>;
      const addQuarantineColumn = savePointColumns.some(({ name }) => name === "quarantined_at") ? "" : "ALTER TABLE save_points ADD COLUMN quarantined_at TEXT;";
      this.database.exec(`
        BEGIN IMMEDIATE;
        ${addQuarantineColumn}
        CREATE TABLE IF NOT EXISTS candidates(
          turn_id TEXT PRIMARY KEY,
          save_point_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0),
          manifest_digest TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          pinned_at TEXT,
          quarantined_at TEXT,
          policy_revision TEXT NOT NULL,
          source_save_point_id TEXT,
          UNIQUE(save_point_id, revision)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS candidate_blobs(
          turn_id TEXT NOT NULL,
          role TEXT NOT NULL,
          digest TEXT NOT NULL,
          byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
          relative_path TEXT NOT NULL,
          PRIMARY KEY(turn_id, role),
          FOREIGN KEY(turn_id) REFERENCES candidates(turn_id) ON DELETE CASCADE
        ) STRICT;
        CREATE TABLE IF NOT EXISTS lifecycle_receipts(
          operation_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL CHECK(subject IN ('candidate', 'durable')),
          target_id TEXT NOT NULL,
          action TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS exports(
          operation_id TEXT PRIMARY KEY,
          save_point_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          path TEXT NOT NULL,
          digest TEXT NOT NULL,
          byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, '${new Date(0).toISOString()}');
        PRAGMA user_version=3;
        COMMIT;
      `);
    }
    const versionThree = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (versionThree.user_version === 3) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE lineages(
          lineage_id TEXT PRIMARY KEY,
          parent_lineage_id TEXT,
          root_save_point_id TEXT,
          branch_operation_id TEXT UNIQUE,
          git_ref TEXT,
          worktree_relative_path TEXT,
          state TEXT NOT NULL CHECK(state IN ('original', 'active-alternate', 'recovery-required')),
          created_at TEXT NOT NULL,
          FOREIGN KEY(parent_lineage_id) REFERENCES lineages(lineage_id)
        ) STRICT;
        CREATE TABLE history_entries(
          save_point_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL UNIQUE,
          sequence_no INTEGER NOT NULL CHECK(sequence_no > 0),
          lineage_id TEXT NOT NULL,
          parent_save_point_id TEXT,
          promoted_at TEXT,
          major_turn_label TEXT,
          nomination_reason TEXT,
          state TEXT NOT NULL CHECK(state IN ('active', 'quarantined', 'tombstone')),
          lifecycle_receipt_id TEXT,
          provenance TEXT NOT NULL CHECK(provenance IN ('observed', 'fixture-contract', 'reconstructed-order')),
          integrity TEXT NOT NULL CHECK(integrity IN ('complete', 'incomplete', 'quarantined', 'deleted')),
          fidelity TEXT NOT NULL CHECK(fidelity IN ('editable-eligible', 'degraded', 'unavailable')),
          FOREIGN KEY(lineage_id) REFERENCES lineages(lineage_id),
          UNIQUE(lineage_id, sequence_no),
          CHECK(state <> 'tombstone' OR (lifecycle_receipt_id IS NOT NULL AND promoted_at IS NULL AND parent_save_point_id IS NULL AND major_turn_label IS NULL AND nomination_reason IS NULL))
        ) STRICT;
        CREATE INDEX history_entries_order_idx ON history_entries(lineage_id, sequence_no, save_point_id);
        CREATE INDEX history_entries_state_idx ON history_entries(state, lineage_id, sequence_no);
        CREATE TABLE decision_revisions(
          save_point_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0),
          predecessor_digest TEXT,
          canonical_digest TEXT NOT NULL UNIQUE,
          canonical_json TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          PRIMARY KEY(save_point_id, revision),
          UNIQUE(save_point_id, canonical_digest)
        ) STRICT;
        CREATE INDEX decision_revisions_predecessor_idx ON decision_revisions(save_point_id, predecessor_digest);
        CREATE TABLE branch_operations(
          operation_id TEXT PRIMARY KEY,
          intent_key TEXT NOT NULL UNIQUE,
          save_point_id TEXT NOT NULL,
          preflight_digest TEXT NOT NULL,
          original_future_digest TEXT NOT NULL,
          branch_ref TEXT NOT NULL UNIQUE,
          worktree_relative_path TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('pending', 'succeeded', 'failed', 'recovery-required')),
          canonical_result TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX branch_operations_state_idx ON branch_operations(state, created_at, operation_id);
        INSERT INTO lineages(lineage_id, parent_lineage_id, root_save_point_id, branch_operation_id, git_ref, worktree_relative_path, state, created_at)
          VALUES ('lineage:original', NULL, NULL, NULL, NULL, NULL, 'original', '${new Date(0).toISOString()}');
      `);
      try {
        this.backfillHistory();
        this.database.exec(`
          INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, '${new Date(0).toISOString()}');
          PRAGMA user_version=4;
          COMMIT;
        `);
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private backfillHistory(): void {
    const rows = this.database.prepare("SELECT * FROM save_points ORDER BY promoted_at, save_point_id").all() as unknown as SavePointRow[];
    const used = new Set<number>();
    const pending = rows.map((row) => {
      const manifest = JSON.parse(row.canonical_json) as { readonly bundle?: unknown };
      const fixture = fixtureHistoryIdentity(manifest.bundle);
      if (fixture !== undefined) {
        if (used.has(fixture.sequenceNo)) throw new Error("History fixture sequence is ambiguous.");
        used.add(fixture.sequenceNo);
      }
      return { row, bundle: manifest.bundle, fixture };
    });
    const deletionRows = this.database.prepare("SELECT operation_id, target_id, result_json FROM lifecycle_receipts WHERE subject = 'durable' AND action = 'delete' ORDER BY created_at, operation_id").all() as unknown as Array<{ operation_id: string; target_id: string; result_json: string }>;
    for (const deletion of deletionRows) {
      if (deletion.target_id !== "01J00000000000000000000S06") continue;
      const receipt = JSON.parse(deletion.result_json) as Partial<DeletionReceipt>;
      if (receipt.complete !== true || receipt.subject !== "durable" || receipt.targetId !== deletion.target_id || receipt.savePointId !== deletion.target_id) throw new Error("Turn-6 deletion receipt authority is invalid.");
      this.database.prepare(`INSERT OR IGNORE INTO history_entries(save_point_id, turn_id, sequence_no, lineage_id, parent_save_point_id, promoted_at, major_turn_label, nomination_reason, state, lifecycle_receipt_id, provenance, integrity, fidelity)
        VALUES (?, ?, 6, 'lineage:original', NULL, NULL, NULL, NULL, 'tombstone', ?, 'fixture-contract', 'deleted', 'unavailable')`)
        .run(deletion.target_id, "01J00000000000000000000T06", deletion.operation_id);
      used.add(6);
    }
    let reconstructed = 1;
    for (const item of pending) {
      while (used.has(reconstructed)) reconstructed += 1;
      const sequenceNo = item.fixture?.sequenceNo ?? reconstructed++;
      used.add(sequenceNo);
      const parent = this.database.prepare("SELECT save_point_id FROM history_entries WHERE lineage_id = 'lineage:original' AND sequence_no = ?").get(sequenceNo - 1) as { save_point_id: string } | undefined;
      this.database.prepare(`INSERT INTO history_entries(save_point_id, turn_id, sequence_no, lineage_id, parent_save_point_id, promoted_at, major_turn_label, nomination_reason, state, lifecycle_receipt_id, provenance, integrity, fidelity)
        VALUES (?, ?, ?, 'lineage:original', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
        .run(
          item.row.save_point_id,
          item.row.turn_id,
          sequenceNo,
          parent?.save_point_id ?? null,
          item.row.promoted_at,
          item.fixture?.label ?? null,
          null,
          item.row.quarantined_at === null ? "active" : "quarantined",
          item.fixture === undefined ? "reconstructed-order" : "fixture-contract",
          item.row.quarantined_at === null ? item.row.health : "quarantined",
          item.row.fidelity,
        );
    }

  }

  private insertHistoryAnchor(request: PromotionRequest, promotedAt: string, health: "complete" | "incomplete", fidelity: "editable-eligible" | "degraded"): void {
    const fixture = fixtureHistoryIdentity(request.bundle);
    const sequenceNo = fixture?.sequenceNo ?? Number((this.database.prepare("SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence_no FROM history_entries WHERE lineage_id = 'lineage:original'").get() as { sequence_no: number }).sequence_no);
    const parent = this.database.prepare("SELECT save_point_id FROM history_entries WHERE lineage_id = 'lineage:original' AND sequence_no = ?").get(sequenceNo - 1) as { save_point_id: string } | undefined;
    this.database.prepare(`INSERT INTO history_entries(save_point_id, turn_id, sequence_no, lineage_id, parent_save_point_id, promoted_at, major_turn_label, nomination_reason, state, lifecycle_receipt_id, provenance, integrity, fidelity)
      VALUES (?, ?, ?, 'lineage:original', ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`)
      .run(
        request.savePointId,
        request.turnId,
        sequenceNo,
        parent?.save_point_id ?? null,
        promotedAt,
        fixture?.label ?? null,
        null,
        fixture === undefined ? "reconstructed-order" : "fixture-contract",
        health,
        fidelity,
      );
  }

  private backupBeforeMigration(sourceVersion: number): void {
    const backupPath = `${this.catalogPath}.pre-v4-v${sourceVersion}.sqlite`;
    if (!existsSync(backupPath)) {
      const escaped = backupPath.replaceAll("'", "''");
      this.database.exec(`VACUUM INTO '${escaped}'`);
      chmodSync(backupPath, 0o600);
      const descriptor = openSync(backupPath, "r");
      try {
        try { fsyncSync(descriptor); } catch (error) { if (process.platform !== "win32") throw error; }
      } finally { closeSync(descriptor); }
      fsyncDirectory(dirname(backupPath));
    }
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const version = backup.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== sourceVersion) throw new Error("Existing pre-migration backup does not match the source schema version.");
    } finally { backup.close(); }
  }

  private crash(at: StorageCrashPoint): void {
    if (this.crashPoint === at) {
      if (this.crashAction !== undefined) { this.crashAction(at); return; }
      throw new PromotionCrashError(at);
    }
  }

  private serialize<T>(operation: () => T): T {
    if (this.active) throw new Error("Repository access is already active");
    this.active = true;
    try { return operation(); } finally { this.active = false; }
  }

  diagnostics(): { schemaVersion: number; journalMode: string; foreignKeys: boolean; defensive: boolean; permissionsVerified: true; permissionModel: "windows-acl-current-user-only" | "posix-owner-only" } {
    const schema = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    const journal = this.database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const foreignKeys = this.database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    return { schemaVersion: schema.user_version, journalMode: journal.journal_mode, foreignKeys: foreignKeys.foreign_keys === 1, defensive: this.defensiveEnabled, permissionsVerified: true, permissionModel: process.platform === "win32" ? "windows-acl-current-user-only" : "posix-owner-only" };
  }

  verifyPrivateStorage(): string[] {
    try { secureAndVerifyPrivateTree(this.remoRoot); return []; } catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  }

  blobPath(digest: string): string {
    assertDigest(digest);
    const hex = digest.slice("sha256:".length);
    return join(this.blobsRoot, hex.slice(0, 2), hex);
  }

  private manifestPath(savePointId: string, revision: number): string {
    return join(this.manifestsRoot, safeSegment(savePointId, "savePointId"), `${revision}.json`);
  }

  private row(turnId: string): SavePointRow | undefined {
    return this.database.prepare("SELECT * FROM save_points WHERE turn_id = ?").get(turnId) as SavePointRow | undefined;
  }

  private receipt(row: SavePointRow): DurableSaveReceipt {
    const stored = JSON.parse(row.receipt_json) as DurableSaveReceipt;
    return { ...stored, expiresAt: row.expires_at, pinned: row.pinned_at !== null, health: row.health, fidelity: row.fidelity, reasonCodes: JSON.parse(row.reasons_json) as string[] };
  }

  getDurable(turnId: string): DurableSaveReceipt | undefined {
    const row = this.row(turnId);
    return row === undefined || row.quarantined_at !== null || this.isElapsed(row.expires_at, row.pinned_at) ? undefined : this.receipt(row);
  }

  listCurrentDurable(): readonly CurrentDurableSavePoint[] {
    const rows = this.database.prepare("SELECT * FROM save_points ORDER BY promoted_at ASC, save_point_id ASC").all() as unknown as SavePointRow[];
    return rows.flatMap((row) => {
      if (this.isElapsed(row.expires_at, row.pinned_at)) return [];
      const revision = this.getCurrentRevisionRaw(row.save_point_id);
      if (revision === undefined || revision.turnId !== row.turn_id) throw new Error("Authoritative durable enumeration found an invalid current revision identity.");
      return [{ receipt: this.receipt(row), revision, lifecycle: this.durableProjection(row), bundle: this.readRevisionBundle(revision) }];
    });
  }

  private isElapsed(expiresAt: string, pinnedAt: string | null): boolean {
    return pinnedAt === null && Date.parse(expiresAt) <= this.now().getTime();
  }

  private saveRow(savePointId: string): SavePointRow | undefined {
    return this.database.prepare("SELECT * FROM save_points WHERE save_point_id = ?").get(savePointId) as SavePointRow | undefined;
  }

  private candidateRow(turnId: string): CandidateRow | undefined {
    return this.database.prepare("SELECT * FROM candidates WHERE turn_id = ?").get(turnId) as CandidateRow | undefined;
  }

  private operationResult<T>(operationId: string, subject: "candidate" | "durable", targetId: string, action: string): T | undefined {
    safeSegment(operationId, "operationId");
    const row = this.database.prepare("SELECT subject, target_id, action, result_json FROM lifecycle_receipts WHERE operation_id = ?").get(operationId) as LifecycleReceiptRow | undefined;
    if (row !== undefined) {
      if (row.subject !== subject || row.target_id !== targetId || row.action !== action) throw new LifecycleIdempotencyConflictError();
      return JSON.parse(row.result_json) as T;
    }
    const exported = this.database.prepare("SELECT save_point_id, path, digest, result_json FROM exports WHERE operation_id = ?").get(operationId) as ExportRow | undefined;
    if (exported === undefined) return undefined;
    if (subject !== "durable" || targetId !== exported.save_point_id || action !== "export") throw new LifecycleIdempotencyConflictError();
    return JSON.parse(exported.result_json) as T;
  }

  private recordOperation(operationId: string, subject: "candidate" | "durable", targetId: string, action: string, result: unknown): void {
    this.database.prepare("INSERT INTO lifecycle_receipts(operation_id, subject, target_id, action, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      operationId, subject, targetId, action, canonicalSerialize(result), this.now().toISOString(),
    );
  }

  private durableProjection(row: SavePointRow, state: "active" | "quarantined" = row.quarantined_at === null ? "active" : "quarantined"): LifecycleProjection {
    return {
      subject: "durable",
      id: row.save_point_id,
      turnId: row.turn_id,
      savePointId: row.save_point_id,
      revision: this.getCurrentRevisionRaw(row.save_point_id)?.revision ?? row.revision,
      state,
      createdAt: row.created_at,
      promotedAt: row.promoted_at,
      originalExpiresAt: row.expires_at,
      expiresAt: row.expires_at,
      pinned: row.pinned_at !== null,
      ...(row.pinned_at === null ? {} : { pinnedAt: row.pinned_at }),
    };
  }

  private candidateProjection(row: CandidateRow, state: "active" | "quarantined" = row.quarantined_at === null ? "active" : "quarantined"): LifecycleProjection {
    return {
      subject: "candidate",
      id: row.turn_id,
      turnId: row.turn_id,
      savePointId: row.save_point_id,
      revision: row.revision,
      state,
      createdAt: row.created_at,
      originalExpiresAt: row.expires_at,
      expiresAt: row.expires_at,
      pinned: row.pinned_at !== null,
      ...(row.pinned_at === null ? {} : { pinnedAt: row.pinned_at }),
      ...(row.source_save_point_id === null ? {} : { sourceSavePointId: row.source_save_point_id }),
    };
  }

  getLifecycle(savePointId: string): LifecycleProjection | undefined {
    const row = this.saveRow(savePointId);
    if (row === undefined || this.isElapsed(row.expires_at, row.pinned_at)) return undefined;
    return this.durableProjection(row);
  }

  getCandidateLifecycle(turnId: string): LifecycleProjection | undefined {
    const row = this.candidateRow(turnId);
    if (row === undefined || this.isElapsed(row.expires_at, row.pinned_at)) return undefined;
    return this.candidateProjection(row);
  }

  registerCandidate(request: CandidateRegistration): LifecycleProjection {
    return this.serialize(() => {
      safeSegment(request.operationId, "operationId");
      safeSegment(request.turnId, "turnId");
      safeSegment(request.savePointId, "savePointId");
      if (!Number.isSafeInteger(request.revision) || request.revision < 1) throw new TypeError("revision must be a positive safe integer");
      assertDigest(request.manifestDigest);
      if (!Number.isFinite(Date.parse(request.createdAt))) throw new TypeError("createdAt must be an ISO timestamp");
      const existing = this.candidateRow(request.turnId);
      if (existing !== undefined) {
        if (existing.save_point_id !== request.savePointId || existing.revision !== request.revision || existing.manifest_digest !== request.manifestDigest) throw new Error("Candidate identity already has different durable registration evidence.");
        return this.candidateProjection(existing);
      }
      const blobs = request.blobs.map((blob) => {
        const role = safeSegment(blob.role, "blob role");
        assertDigest(blob.expectedDigest);
        if (sha256(blob.bytes) !== blob.expectedDigest) throw new Error("Candidate safe blob digest mismatch.");
        const path = this.blobPath(blob.expectedDigest);
        ensurePrivateDirectory(dirname(path));
        if (existsSync(path)) {
          if (sha256(readFileSync(path)) !== blob.expectedDigest) throw new Error("Existing CAS blob is corrupt.");
        } else {
          writeAndFsync(path, blob.bytes);
          fsyncDirectory(dirname(path));
        }
        return { role, digest: blob.expectedDigest, byteSize: blob.bytes.byteLength, relativePath: relative(this.remoRoot, path).split(sep).join("/") };
      });
      const expiresAt = new Date(Date.parse(request.createdAt) + CANDIDATE_RETENTION_MS).toISOString();
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("INSERT INTO candidates(turn_id, save_point_id, revision, manifest_digest, canonical_json, created_at, expires_at, pinned_at, quarantined_at, policy_revision, source_save_point_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)").run(
          request.turnId, request.savePointId, request.revision, request.manifestDigest, canonicalSerialize(request.manifest), request.createdAt, expiresAt, request.policyRevision, request.sourceSavePointId ?? null,
        );
        const insert = this.database.prepare("INSERT INTO candidate_blobs(turn_id, role, digest, byte_size, relative_path) VALUES (?, ?, ?, ?, ?)");
        for (const blob of blobs) insert.run(request.turnId, blob.role, blob.digest, blob.byteSize, blob.relativePath);
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
      return this.candidateProjection(this.candidateRow(request.turnId)!);
    });
  }

  private revisionRow(savePointId: string): RevisionRow | undefined {
    return this.database.prepare("SELECT * FROM save_point_revisions WHERE save_point_id = ? ORDER BY revision DESC LIMIT 1").get(savePointId) as RevisionRow | undefined;
  }

  private revisionReceipt(row: RevisionRow): DurableManifestRevision {
    return {
      turnId: row.turn_id,
      savePointId: row.save_point_id,
      revision: row.revision,
      predecessorRevision: row.predecessor_revision,
      predecessorManifestDigest: row.predecessor_manifest_digest,
      manifestDigest: row.manifest_digest,
      manifestPath: row.manifest_path,
      ...(row.trace_validated_at === null ? {} : { traceValidatedAt: row.trace_validated_at }),
    };
  }

  private getCurrentRevisionRaw(savePointId: string): DurableManifestRevision | undefined {
    const revision = this.revisionRow(savePointId);
    if (revision !== undefined) return this.revisionReceipt(revision);
    const row = this.database.prepare("SELECT * FROM save_points WHERE save_point_id = ?").get(savePointId) as SavePointRow | undefined;
    if (row === undefined) return undefined;
    return {
      turnId: row.turn_id,
      savePointId: row.save_point_id,
      revision: row.revision,
      manifestDigest: row.manifest_digest,
      manifestPath: row.manifest_path,
    };
  }

  getCurrentRevision(savePointId: string): DurableManifestRevision | undefined {
    const row = this.saveRow(savePointId);
    if (row === undefined || row.quarantined_at !== null || this.isElapsed(row.expires_at, row.pinned_at)) return undefined;
    return this.getCurrentRevisionRaw(savePointId);
  }

  private readRevisionBundle(revision: DurableManifestRevision): unknown {
    let envelope: { readonly manifest?: { readonly bundle?: unknown } };
    try {
      envelope = JSON.parse(readFileSync(revision.manifestPath, "utf8")) as { readonly manifest?: { readonly bundle?: unknown } };
    } catch {
      throw new Error(`Authoritative manifest revision ${revision.revision} is missing or invalid.`);
    }
    if (envelope.manifest?.bundle === undefined) throw new Error(`Authoritative manifest revision ${revision.revision} has no bundle.`);
    return envelope.manifest.bundle;
  }

  private materializeRevision(row: RevisionRow): void {
    ensurePrivateDirectory(dirname(row.manifest_path));
    const envelope = canonicalSerialize({ manifest: JSON.parse(row.canonical_json) as unknown, receipt: JSON.parse(row.receipt_json) as unknown });
    if (existsSync(row.manifest_path)) {
      if (readFileSync(row.manifest_path, "utf8") !== envelope) throw new Error("Immutable reconciled manifest revision already exists with different bytes");
    } else {
      const temporary = `${row.manifest_path}.tmp-${process.pid}`;
      if (existsSync(temporary)) unlinkSync(temporary);
      this.crash("before-revision-manifest-write");
      writeAndFsync(temporary, envelope);
      this.crash("before-revision-manifest-rename");
      renameSync(temporary, row.manifest_path);
      fsyncDirectory(dirname(row.manifest_path));
    }
    this.crash("after-revision-materialization");
    this.database.prepare("UPDATE save_point_revisions SET materialized = 1 WHERE save_point_id = ? AND revision = ?").run(row.save_point_id, row.revision);
  }

  appendReconciliation(request: AppendReconciliationRequest): DurableManifestRevision {
    return this.serialize(() => {
      safeSegment(request.savePointId, "savePointId");
      safeSegment(request.turnId, "turnId");
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) throw new TypeError("expectedRevision must be a positive safe integer");
      assertDigest(request.expectedManifestDigest);
      if (request.traceValidatedAt !== undefined && !Number.isFinite(Date.parse(request.traceValidatedAt))) throw new TypeError("traceValidatedAt must be an ISO timestamp");
      const bundleIdentity = request.bundle as { readonly savePointId?: unknown; readonly correlation?: { readonly turnId?: unknown } };
      if (bundleIdentity?.savePointId !== request.savePointId || bundleIdentity.correlation?.turnId !== request.turnId) throw new Error("Reconciled bundle identity does not match the durable save and turn.");

      const promotion = this.database.prepare("SELECT * FROM save_points WHERE save_point_id = ?").get(request.savePointId) as SavePointRow | undefined;
      if (promotion === undefined) throw new Error("Save point is not durable in the local repository.");
      if (promotion.turn_id !== request.turnId) throw new Error("Reconciliation cannot replace the save or turn identity.");
      const current = this.getCurrentRevision(request.savePointId)!;
      if (current.revision !== request.expectedRevision || current.manifestDigest !== request.expectedManifestDigest) throw new Error("Save point revision changed during reconciliation.");
      const currentBundle = this.readRevisionBundle(current);
      if (canonicalSerialize(currentBundle) === canonicalSerialize(request.bundle) && current.traceValidatedAt === request.traceValidatedAt) return current;

      const revision = current.revision + 1;
      const path = this.manifestPath(request.savePointId, revision);
      const reconciledAt = this.now().toISOString();
      const manifest = {
        schemaVersion: RECONCILED_SCHEMA_VERSION,
        savePointId: request.savePointId,
        turnId: request.turnId,
        revision,
        predecessor: { revision: current.revision, manifestDigest: current.manifestDigest },
        reconciledAt,
        traceValidatedAt: request.traceValidatedAt ?? null,
        bundle: request.bundle,
      };
      const canonicalManifest = canonicalSerialize(manifest);
      const manifestDigest = sha256(canonicalManifest);
      const receipt = {
        status: "reconciled",
        savePointId: request.savePointId,
        turnId: request.turnId,
        revision,
        predecessorRevision: current.revision,
        predecessorManifestDigest: current.manifestDigest,
        manifestDigest,
        manifestPath: path,
        reconciledAt,
        traceValidatedAt: request.traceValidatedAt ?? null,
      };

      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare(`INSERT INTO save_point_revisions(save_point_id, turn_id, revision, predecessor_revision, predecessor_manifest_digest, manifest_digest, manifest_path, canonical_json, receipt_json, trace_validated_at, materialized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
          request.savePointId,
          request.turnId,
          revision,
          current.revision,
          current.manifestDigest,
          manifestDigest,
          path,
          canonicalManifest,
          canonicalSerialize(receipt),
          request.traceValidatedAt ?? null,
        );
        this.crash("before-revision-transaction-commit");
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
      this.crash("after-revision-transaction-commit");
      this.crash("before-revision-materialization");
      this.materializeRevision(this.revisionRow(request.savePointId)!);
      return this.getCurrentRevision(request.savePointId)!;
    });
  }

  pinDurable(savePointId: string, operationId: string): LifecycleMutationResult {
    return this.serialize(() => {
      const repeated = this.operationResult<LifecycleMutationResult>(operationId, "durable", savePointId, "pin");
      if (repeated !== undefined) return repeated;
      const row = this.saveRow(savePointId);
      if (row === undefined) throw new LifecycleUnavailableError("lifecycle.not-found", "The local save point was not found.");
      if (row.quarantined_at !== null) throw new LifecycleUnavailableError("lifecycle.quarantined", "Quarantined evidence cannot be changed by ordinary lifecycle actions.");
      if (this.isElapsed(row.expires_at, row.pinned_at)) throw new LifecycleUnavailableError("lifecycle.expired", "The local save point has expired.");
      const changed = row.pinned_at === null;
      if (changed) this.database.prepare("UPDATE save_points SET pinned_at = ? WHERE save_point_id = ?").run(this.now().toISOString(), savePointId);
      const result = { ...this.durableProjection(this.saveRow(savePointId)!), operationId, changed };
      this.recordOperation(operationId, "durable", savePointId, "pin", result);
      return result;
    });
  }

  unpinDurable(savePointId: string, operationId: string, confirmImmediateExpiry: boolean): LifecycleMutationResult {
    return this.serialize(() => {
      const repeated = this.operationResult<LifecycleMutationResult>(operationId, "durable", savePointId, "unpin");
      if (repeated !== undefined) return repeated;
      const row = this.saveRow(savePointId);
      if (row === undefined) throw new LifecycleUnavailableError("lifecycle.not-found", "The local save point was not found.");
      if (row.quarantined_at !== null) throw new LifecycleUnavailableError("lifecycle.quarantined", "Quarantined evidence cannot be changed by ordinary lifecycle actions.");
      if (row.pinned_at === null) {
        if (this.isElapsed(row.expires_at, null)) throw new LifecycleUnavailableError("lifecycle.expired", "The local save point has expired.");
        const unchanged = { ...this.durableProjection(row), operationId, changed: false };
        this.recordOperation(operationId, "durable", savePointId, "unpin", unchanged);
        return unchanged;
      }
      if (Date.parse(row.expires_at) <= this.now().getTime()) {
        if (!confirmImmediateExpiry) throw new LifecycleConfirmationRequiredError(row.expires_at);
        this.database.prepare("UPDATE save_points SET pinned_at = NULL WHERE save_point_id = ?").run(savePointId);
        const deletion = this.deleteDurableInternal(savePointId, `${operationId}-expiry`, "expire");
        const expired: LifecycleMutationResult = {
          subject: "durable", id: savePointId, turnId: row.turn_id, savePointId, revision: this.getCurrentRevisionRaw(savePointId)?.revision ?? row.revision,
          state: "expired", createdAt: row.created_at, promotedAt: row.promoted_at, originalExpiresAt: row.expires_at, expiresAt: row.expires_at,
          pinned: false, operationId, changed: true,
        };
        this.recordOperation(operationId, "durable", savePointId, "unpin", { ...expired, deletionOperationId: deletion.operationId });
        return expired;
      }
      this.database.prepare("UPDATE save_points SET pinned_at = NULL WHERE save_point_id = ?").run(savePointId);
      const result = { ...this.durableProjection(this.saveRow(savePointId)!), operationId, changed: true };
      this.recordOperation(operationId, "durable", savePointId, "unpin", result);
      return result;
    });
  }

  quarantineDurable(savePointId: string, operationId: string): LifecycleMutationResult {
    return this.serialize(() => {
      const repeated = this.operationResult<LifecycleMutationResult>(operationId, "durable", savePointId, "quarantine");
      if (repeated !== undefined) return repeated;
      const row = this.saveRow(savePointId);
      if (row === undefined) throw new LifecycleUnavailableError("lifecycle.not-found", "The local save point was not found.");
      if (this.isElapsed(row.expires_at, row.pinned_at)) throw new LifecycleUnavailableError("lifecycle.expired", "The local save point has expired.");
      const changed = row.quarantined_at === null;
      if (changed) {
        this.database.prepare("UPDATE save_points SET quarantined_at = ? WHERE save_point_id = ?").run(this.now().toISOString(), savePointId);
        this.database.prepare("UPDATE history_entries SET state = 'quarantined', integrity = 'quarantined', fidelity = 'degraded' WHERE save_point_id = ?").run(savePointId);
      }
      const result = { ...this.durableProjection(this.saveRow(savePointId)!, "quarantined"), operationId, changed };
      this.recordOperation(operationId, "durable", savePointId, "quarantine", result);
      return result;
    });
  }

  redactDurable(savePointId: string, operationId: string, options: { readonly redactedRoles: readonly string[] }): LifecycleMutationResult {
    return this.serialize(() => {
      const repeated = this.operationResult<LifecycleMutationResult>(operationId, "durable", savePointId, "redact");
      if (repeated !== undefined) return repeated;
      const row = this.saveRow(savePointId);
      if (row === undefined) throw new LifecycleUnavailableError("lifecycle.not-found", "The local save point was not found.");
      if (this.isElapsed(row.expires_at, row.pinned_at)) throw new LifecycleUnavailableError("lifecycle.expired", "The local save point has expired.");
      if (row.quarantined_at === null) throw new LifecycleUnavailableError("lifecycle.quarantined", "Redaction regeneration is available only for quarantined evidence.");
      const redacted = new Set(options.redactedRoles.map((role) => safeSegment(role, "redacted role")));
      const sourceBlobs = this.database.prepare("SELECT role, digest, byte_size, relative_path FROM save_point_blobs WHERE save_point_id = ? ORDER BY role").all(savePointId) as unknown as Array<BlobRow & { byte_size: number }>;
      const current = this.getCurrentRevisionRaw(savePointId)!;
      const candidateRevision = this.database.prepare("SELECT MAX(revision) AS revision FROM candidates WHERE source_save_point_id = ?").get(savePointId) as { revision: number | null };
      const revision = Math.max(current.revision, candidateRevision.revision ?? 0) + 1;
      const suffix = createHash("sha256").update(`${savePointId}:${operationId}`).digest("hex").slice(0, 20);
      const turnId = `redacted-${suffix}`;
      const createdAt = this.now().toISOString();
      const expiresAt = new Date(this.now().getTime() + CANDIDATE_RETENTION_MS).toISOString();
      const manifest = {
        schemaVersion: "remo.redacted-candidate.v1",
        sourceSavePointId: savePointId,
        sourceManifestDigest: current.manifestDigest,
        revision,
        createdAt,
        policyRevision: "remo.privacy.v1",
        redactedRoles: [...redacted].sort(),
        retainedEvidence: sourceBlobs.filter(({ role }) => !redacted.has(role)).map(({ role, digest, byte_size }) => ({ role, digest, byteSize: byte_size })),
      };
      const manifestDigest = sha256(canonicalSerialize(manifest));
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("INSERT INTO candidates(turn_id, save_point_id, revision, manifest_digest, canonical_json, created_at, expires_at, pinned_at, quarantined_at, policy_revision, source_save_point_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)").run(
          turnId, savePointId, revision, manifestDigest, canonicalSerialize(manifest), createdAt, expiresAt, "remo.privacy.v1", savePointId,
        );
        const insert = this.database.prepare("INSERT INTO candidate_blobs(turn_id, role, digest, byte_size, relative_path) VALUES (?, ?, ?, ?, ?)");
        for (const blob of sourceBlobs.filter(({ role }) => !redacted.has(role))) insert.run(turnId, blob.role, blob.digest, blob.byte_size, blob.relative_path);
        const result: LifecycleMutationResult = { ...this.candidateProjection(this.candidateRow(turnId)!), operationId, changed: true };
        this.recordOperation(operationId, "durable", savePointId, "redact", result);
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  exportDurable(savePointId: string, operationId: string): ExportReceipt {
    return this.serialize(() => {
      safeSegment(operationId, "operationId");
      const existing = this.operationResult<ExportReceipt>(operationId, "durable", savePointId, "export");
      if (existing !== undefined) return existing;
      const row = this.saveRow(savePointId);
      if (row === undefined) throw new LifecycleUnavailableError("lifecycle.not-found", "The local save point was not found.");
      if (row.quarantined_at !== null) throw new LifecycleUnavailableError("lifecycle.quarantined", "Quarantined evidence cannot be exported through ordinary viewing.");
      if (this.isElapsed(row.expires_at, row.pinned_at)) throw new LifecycleUnavailableError("lifecycle.expired", "The local save point has expired.");
      const revision = this.getCurrentRevisionRaw(savePointId)!;
      const manifestBytes = this.exportSafeJson(readFileSync(revision.manifestPath, "utf8"));
      const promotionReceipt = this.exportSafeJson(row.receipt_json);
      const lifecycleReceipts = this.database.prepare("SELECT subject, target_id, action, result_json FROM lifecycle_receipts WHERE target_id = ? ORDER BY operation_id").all(savePointId) as unknown as LifecycleReceiptRow[];
      const blobs = this.database.prepare("SELECT role, digest, relative_path FROM save_point_blobs WHERE save_point_id = ? ORDER BY role").all(savePointId) as unknown as BlobRow[];
      const decisions = this.database.prepare("SELECT revision, canonical_json FROM decision_revisions WHERE save_point_id = ? ORDER BY revision").all(savePointId) as unknown as Array<{ revision: number; canonical_json: string }>;
      const excluded: ExportExclusion[] = [
        { path: "external/git.json", reason: "external-authority", authority: "git" },
        { path: "external/langfuse.json", reason: "external-authority", authority: "langfuse" },
      ];
      const exportedAt = this.now().toISOString();
      const readme = [
        "ReMo bounded evidence export", "", `Save point: ${savePointId}`, `Revision: ${revision.revision}`, `Exported: ${exportedAt}`,
        "", "Included: canonical immutable manifest, local receipts, and privacy-cleared local evidence.",
        "Excluded: Git and Langfuse remain external authoritative records and are not copied or deleted by ReMo.",
        "Quarantined or policy-excluded evidence is named in inventory.json and is not included.", "",
      ].join("\n");
      const entries: ZipEntry[] = [
        { path: "README.txt", bytes: Buffer.from(readme) },
        { path: "manifest.json", bytes: manifestBytes },
        { path: "receipts/promotion.json", bytes: promotionReceipt },
        ...lifecycleReceipts.map((receipt, index) => ({ path: `receipts/lifecycle-${String(index + 1).padStart(3, "0")}.json`, bytes: this.exportSafeJson(receipt.result_json) })),
        ...decisions.map((decision) => ({ path: `decisions/revision-${String(decision.revision).padStart(3, "0")}.json`, bytes: this.exportSafeJson(decision.canonical_json) })),
        ...blobs.map((blob) => ({ path: `evidence/${blob.role}.bin`, bytes: readFileSync(resolve(this.remoRoot, blob.relative_path)) })),
      ];
      const inventory: ExportInventoryEntry[] = entries.map((entry) => ({ path: entry.path, byteSize: entry.bytes.byteLength, digest: sha256(entry.bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      entries.push({ path: "inventory.json", bytes: Buffer.from(canonicalSerialize({ schemaVersion: "remo.export-inventory.v1", included: inventory, excluded })) });
      this.assertNoPrivateExportBytes(entries);
      const zip = deterministicZip(entries, MAX_EXPORT_BYTES);
      const intent = createHash("sha256").update(operationId).digest("hex").slice(0, 20);
      const fileName = `${safeSegment(savePointId, "savePointId")}-r${revision.revision}-${intent}.zip`;
      const path = join(this.exportsRoot, fileName);
      const temporary = `${path}.tmp-${process.pid}`;
      if (existsSync(temporary)) unlinkSync(temporary);
      if (existsSync(path)) throw new Error("A distinct lifecycle export intent cannot overwrite an existing controlled export.");
      writeAndFsync(temporary, zip);
      renameSync(temporary, path);
      fsyncDirectory(this.exportsRoot);
      const receipt: ExportReceipt = { operationId, savePointId, revision: revision.revision, exportedAt, fileName, path, digest: zipSha256(zip), byteSize: zip.byteLength, inventory, excluded };
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("INSERT INTO exports(operation_id, save_point_id, revision, path, digest, byte_size, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          operationId, savePointId, revision.revision, path, receipt.digest, receipt.byteSize, canonicalSerialize(receipt), exportedAt,
        );
        this.recordOperation(operationId, "durable", savePointId, "export", receipt);
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        if (existsSync(path)) unlinkSync(path);
        throw error;
      }
      return receipt;
    });
  }

  private exportSafeJson(json: string): Buffer {
    const sanitize = (value: unknown): unknown => {
      if (typeof value === "string") {
        const normalizedRoot = this.remoRoot.replaceAll("\\", "/").toLowerCase();
        const normalized = value.replaceAll("\\", "/").toLowerCase();
        if (normalized.includes(normalizedRoot) || isAbsolute(value) || /[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || /^file:/iu.test(value)) return "[private-path-removed]";
        return value;
      }
      if (Array.isArray(value)) return value.map(sanitize);
      if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
      return value;
    };
    return Buffer.from(canonicalSerialize(sanitize(JSON.parse(json) as unknown)));
  }

  private assertNoPrivateExportBytes(entries: readonly ZipEntry[]): void {
    const variants = new Set([this.remoRoot, this.remoRoot.replaceAll("\\", "/"), this.remoRoot.replaceAll("/", "\\")]);
    for (const entry of entries) {
      for (const privateRoot of variants) {
        if (entry.bytes.includes(Buffer.from(privateRoot))) throw new Error(`Export entry ${entry.path} still contains a controlled private path.`);
      }
    }
  }

  private removeFileState(path: string, kind: "blob" | "manifest" | "render" | "export", details: { readonly digest?: string; readonly role?: string } = {}): DeletionReceiptState {
    if (!existsSync(path)) return { state: "missing", kind, ...details };
    unlinkSync(path);
    return { state: "removed", kind, ...details };
  }

  private pendingDeletionPath(operationId: string): string {
    safeSegment(operationId, "operationId");
    return join(this.stagingRoot, `delete-pending-${createHash("sha256").update(operationId).digest("hex")}.json`);
  }

  private deleteDurableInternal(savePointId: string, operationId: string, action: "delete" | "expire" = "delete"): DeletionReceipt {
    const pendingPath = this.pendingDeletionPath(operationId);
    const repeated = this.operationResult<DeletionReceipt>(operationId, "durable", savePointId, action);
    if (repeated !== undefined) {
      if (existsSync(pendingPath)) unlinkSync(pendingPath);
      return repeated;
    }
    const row = this.saveRow(savePointId);
    if (row === undefined) throw new LifecycleUnavailableError("lifecycle.not-found", "The local save point was not found.");
    const pending = canonicalSerialize({ schemaVersion: "remo.pending-deletion.v1", operationId, savePointId, action });
    if (existsSync(pendingPath)) {
      if (readFileSync(pendingPath, "utf8") !== pending) throw new Error("Pending deletion intent does not match the requested action and target.");
    } else {
      writeAndFsync(pendingPath, pending);
      fsyncDirectory(this.stagingRoot);
    }
    const states: DeletionReceiptState[] = [];
    const blobs = this.database.prepare("SELECT role, digest, relative_path FROM save_point_blobs WHERE save_point_id = ? ORDER BY role").all(savePointId) as unknown as BlobRow[];
    for (const blob of blobs) {
      const otherDurable = this.database.prepare("SELECT COUNT(*) AS count FROM save_point_blobs WHERE digest = ? AND save_point_id <> ?").get(blob.digest, savePointId) as { count: number };
      const candidates = this.database.prepare("SELECT COUNT(*) AS count FROM candidate_blobs WHERE digest = ?").get(blob.digest) as { count: number };
      if (Number(otherDurable.count) + Number(candidates.count) > 0) states.push({ state: "shared", kind: blob.role === "screenshot" ? "render" : "blob", role: blob.role, digest: blob.digest });
      else states.push(this.removeFileState(resolve(this.remoRoot, blob.relative_path), blob.role === "screenshot" ? "render" : "blob", { role: blob.role, digest: blob.digest }));
    }
    const revisions = this.database.prepare("SELECT manifest_path FROM save_point_revisions WHERE save_point_id = ? ORDER BY revision").all(savePointId) as unknown as Array<{ manifest_path: string }>;
    for (const revision of [{ manifest_path: row.manifest_path }, ...revisions]) states.push(this.removeFileState(revision.manifest_path, "manifest"));
    const exports = this.database.prepare("SELECT save_point_id, path, digest, result_json FROM exports WHERE save_point_id = ? ORDER BY operation_id").all(savePointId) as unknown as ExportRow[];
    for (const exported of exports) states.push(this.removeFileState(exported.path, "export", { digest: exported.digest }));
    states.push({ state: "external", kind: "authority", authority: "git", identifier: "authoritative-source-record-not-controlled" });
    states.push({ state: "external", kind: "authority", authority: "langfuse", identifier: "authoritative-trace-record-not-controlled" });
    if (this.lifecycleCrashPoint === "after-local-remove-before-catalog-commit") throw new LifecycleCrashError(this.lifecycleCrashPoint);
    const deletedAt = this.now().toISOString();
    const receipt: DeletionReceipt = { operationId, subject: "durable", targetId: savePointId, savePointId, deletedAt, states: [...states, { state: "removed", kind: "catalog" }], complete: true };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM exports WHERE save_point_id = ?").run(savePointId);
      this.database.prepare("DELETE FROM lifecycle_receipts WHERE target_id = ?").run(savePointId);
      this.database.prepare("DELETE FROM decision_revisions WHERE save_point_id = ?").run(savePointId);
      this.database.prepare(`UPDATE history_entries SET parent_save_point_id = NULL, promoted_at = NULL, major_turn_label = NULL, nomination_reason = NULL, state = 'tombstone', lifecycle_receipt_id = ?, integrity = 'deleted', fidelity = 'unavailable' WHERE save_point_id = ?`).run(operationId, savePointId);
      this.database.prepare("DELETE FROM save_points WHERE save_point_id = ?").run(savePointId);
      this.recordOperation(operationId, "durable", savePointId, action, receipt);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    const receiptPath = join(this.receiptsRoot, `${safeSegment(operationId, "operationId")}.json`);
    if (!existsSync(receiptPath)) writeAndFsync(receiptPath, canonicalSerialize(receipt));
    if (existsSync(pendingPath)) unlinkSync(pendingPath);
    fsyncDirectory(this.stagingRoot);
    return receipt;
  }

  deleteDurable(savePointId: string, operationId: string): DeletionReceipt {
    return this.serialize(() => this.deleteDurableInternal(savePointId, operationId));
  }

  private deleteCandidateInternal(turnId: string, operationId: string, action: "deleted" | "expired" = "deleted"): DeletionReceipt {
    const repeated = this.operationResult<DeletionReceipt>(operationId, "candidate", turnId, action);
    if (repeated !== undefined) return repeated;
    const row = this.candidateRow(turnId);
    if (row === undefined) throw new LifecycleUnavailableError("lifecycle.not-found", "The local candidate was not found.");
    const states: DeletionReceiptState[] = [];
    const blobs = this.database.prepare("SELECT role, digest, relative_path FROM candidate_blobs WHERE turn_id = ? ORDER BY role").all(turnId) as unknown as BlobRow[];
    for (const blob of blobs) {
      const durable = this.database.prepare("SELECT COUNT(*) AS count FROM save_point_blobs WHERE digest = ?").get(blob.digest) as { count: number };
      const candidates = this.database.prepare("SELECT COUNT(*) AS count FROM candidate_blobs WHERE digest = ? AND turn_id <> ?").get(blob.digest, turnId) as { count: number };
      if (Number(durable.count) + Number(candidates.count) > 0) states.push({ state: "shared", kind: blob.role === "screenshot" ? "render" : "blob", role: blob.role, digest: blob.digest });
      else states.push(this.removeFileState(resolve(this.remoRoot, blob.relative_path), blob.role === "screenshot" ? "render" : "blob", { role: blob.role, digest: blob.digest }));
    }
    const deletedAt = this.now().toISOString();
    const receipt: DeletionReceipt = { operationId, subject: "candidate", targetId: turnId, savePointId: row.save_point_id, deletedAt, states: [...states, { state: "removed", kind: "catalog" }], complete: true };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM decision_revisions WHERE save_point_id = ? AND turn_id = ?").run(row.save_point_id, turnId);
      this.database.prepare("DELETE FROM candidates WHERE turn_id = ?").run(turnId);
      this.recordOperation(operationId, "candidate", turnId, action, receipt);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    return receipt;
  }

  sweepExpired(): SweepReceipt {
    return this.serialize(() => {
      const now = this.now();
      const stamp = now.toISOString();
      const candidates = (this.database.prepare("SELECT turn_id FROM candidates WHERE pinned_at IS NULL AND expires_at <= ? ORDER BY turn_id").all(stamp) as unknown as Array<{ turn_id: string }>).map(({ turn_id }) => turn_id);
      const durableSavePoints = (this.database.prepare("SELECT save_point_id FROM save_points WHERE pinned_at IS NULL AND expires_at <= ? ORDER BY save_point_id").all(stamp) as unknown as Array<{ save_point_id: string }>).map(({ save_point_id }) => save_point_id);
      for (const turnId of candidates) this.deleteCandidateInternal(turnId, `expire-candidate-${createHash("sha256").update(turnId).digest("hex").slice(0, 24)}`, "expired");
      for (const savePointId of durableSavePoints) this.deleteDurableInternal(savePointId, `expire-durable-${createHash("sha256").update(savePointId).digest("hex").slice(0, 24)}`, "expire");
      return { sweptAt: stamp, candidates, durableSavePoints };
    });
  }

  countDurable(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM save_points").get() as { count: number };
    return Number(row.count);
  }

  private materialize(row: SavePointRow): void {
    const path = row.manifest_path;
    ensurePrivateDirectory(dirname(path));
    const envelope = canonicalSerialize({ manifest: JSON.parse(row.canonical_json) as unknown, receipt: JSON.parse(row.receipt_json) as unknown });
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== envelope) throw new Error("Immutable durable manifest already exists with different bytes");
    } else {
      const temporary = `${path}.tmp-${process.pid}`;
      if (existsSync(temporary)) unlinkSync(temporary);
      writeAndFsync(temporary, envelope);
      renameSync(temporary, path);
    }
    this.database.prepare("UPDATE save_points SET materialized = 1, health = 'complete', fidelity = 'editable-eligible', reasons_json = '[]' WHERE turn_id = ?").run(row.turn_id);
  }

  promote(request: PromotionRequest): DurableSaveReceipt {
    return this.serialize(() => {
      safeSegment(request.operationId, "operationId");
      safeSegment(request.turnId, "turnId");
      safeSegment(request.savePointId, "savePointId");
      if (!Number.isSafeInteger(request.revision) || request.revision < 1) throw new TypeError("revision must be a positive safe integer");
      if (!Number.isSafeInteger(request.candidateRevision) || request.candidateRevision < 1) throw new TypeError("candidateRevision must be a positive safe integer");
      assertDigest(request.candidateManifestDigest);
      if (!Number.isFinite(Date.parse(request.createdAt))) throw new TypeError("createdAt must be an ISO timestamp");
      const pendingDecision = this.database.prepare("SELECT canonical_digest FROM decision_revisions WHERE save_point_id = ? ORDER BY revision DESC LIMIT 1").get(request.savePointId) as { canonical_digest: string } | undefined;
      const promotedBundle = pendingDecision === undefined ? request.bundle : withDecisionDescriptorDigest(request.bundle, pendingDecision.canonical_digest);
      fixtureHistoryIdentity(promotedBundle);

      const candidate = this.candidateRow(request.turnId);
      if (candidate !== undefined && candidate.quarantined_at !== null) throw new LifecycleUnavailableError("lifecycle.quarantined", "Quarantined candidate evidence cannot be promoted.");
      if (candidate !== undefined && this.isElapsed(candidate.expires_at, candidate.pinned_at)) throw new LifecycleUnavailableError("lifecycle.expired", "The candidate has expired.");
      const existing = this.row(request.turnId);
      if (existing !== undefined) {
        if (existing.quarantined_at !== null) throw new LifecycleUnavailableError("lifecycle.quarantined", "Quarantined evidence cannot be promoted or replaced.");
        if (this.isElapsed(existing.expires_at, existing.pinned_at)) throw new LifecycleUnavailableError("lifecycle.expired", "The durable save point has expired.");
        const receipt = this.receipt(existing);
        if (existing.save_point_id !== request.savePointId || existing.revision !== request.revision || receipt.candidateRevision !== request.candidateRevision || receipt.candidateManifestDigest !== request.candidateManifestDigest) throw new Error("Turn already has a different durable candidate binding");
        const reconciled = this.reconcileRow(existing);
        if (reconciled.reasonCodes.length === 1 && reconciled.reasonCodes[0] === "manifest.missing") this.materialize(this.row(request.turnId)!);
        return this.receipt(this.row(request.turnId)!);
      }

      const operationRoot = join(this.stagingRoot, request.operationId);
      const committedBlobs = request.blobs.map((blob, index) => {
        assertDigest(blob.expectedDigest);
        const actualDigest = sha256(blob.bytes);
        if (actualDigest !== blob.expectedDigest) throw new Error(`Safe blob digest mismatch for ${blob.role}`);
        const role = safeSegment(blob.role, "blob role");
        const destination = this.blobPath(actualDigest);
        const staged = join(operationRoot, `${index}-${role}.blob`);
        return { role, bytes: blob.bytes, digest: actualDigest, byteSize: blob.bytes.byteLength, staged, destination };
      });

      const promotedAt = this.now().toISOString();
      const expiresAt = new Date(Date.parse(promotedAt) + DURABLE_RETENTION_MS).toISOString();
      const path = this.manifestPath(request.savePointId, request.revision);
      const manifest = {
        schemaVersion: DURABLE_SCHEMA_VERSION,
        revision: request.revision,
        savePointId: request.savePointId,
        turnId: request.turnId,
        candidateRevision: request.candidateRevision,
        candidateManifestDigest: request.candidateManifestDigest,
        createdAt: request.createdAt,
        promotedAt,
        expiresAt,
        pinnedAt: null,
        policyRevision: request.policyRevision,
        bundle: promotedBundle,
        blobs: committedBlobs.map(({ role, digest, byteSize, destination }) => ({ role, digest, byteSize, path: relative(this.remoRoot, destination).split(sep).join("/") })),
      };
      const canonicalManifest = canonicalSerialize(manifest);
      const manifestDigest = sha256(canonicalManifest);
      const receipt: DurableSaveReceipt = { status: "durable", turnId: request.turnId, savePointId: request.savePointId, revision: request.revision, candidateRevision: request.candidateRevision, candidateManifestDigest: request.candidateManifestDigest, manifestDigest, manifestPath: path, createdAt: request.createdAt, promotedAt, expiresAt, pinned: false, health: "complete", fidelity: "editable-eligible", reasonCodes: [] };

      ensurePrivateDirectory(operationRoot);
      for (const blob of committedBlobs) {
        writeFileSync(blob.staged, blob.bytes, { flag: "wx", mode: 0o600 });
        this.crash("before-staged-fsync");
        const handle = openSync(blob.staged, "r+");
        try { fsyncSync(handle); } finally { closeSync(handle); }
        this.crash("after-staged-fsync");
      }

      this.crash("before-blob-rename");
      for (const blob of committedBlobs) {
        ensurePrivateDirectory(dirname(blob.destination));
        if (existsSync(blob.destination)) {
          if (sha256(readFileSync(blob.destination)) !== blob.digest) throw new Error(`Existing CAS blob is corrupt: ${blob.digest}`);
          unlinkSync(blob.staged);
        } else {
          renameSync(blob.staged, blob.destination);
          chmodSync(blob.destination, 0o600);
          fsyncDirectory(dirname(blob.destination));
        }
      }
      this.crash("after-blob-rename");

      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare(`INSERT INTO save_points(turn_id, save_point_id, revision, candidate_revision, candidate_manifest_digest, manifest_digest, manifest_path, canonical_json, receipt_json, created_at, promoted_at, expires_at, pinned_at, materialized, health, fidelity, reasons_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'incomplete', 'degraded', '["manifest.missing"]')`).run(request.turnId, request.savePointId, request.revision, request.candidateRevision, request.candidateManifestDigest, manifestDigest, path, canonicalManifest, canonicalSerialize(receipt), request.createdAt, promotedAt, expiresAt);
        const insertBlob = this.database.prepare("INSERT INTO save_point_blobs(save_point_id, role, digest, byte_size, relative_path) VALUES (?, ?, ?, ?, ?)");
        for (const blob of committedBlobs) insertBlob.run(request.savePointId, blob.role, blob.digest, blob.byteSize, relative(this.remoRoot, blob.destination).split(sep).join("/"));
        this.insertHistoryAnchor(request, promotedAt, "complete", "editable-eligible");
        this.database.prepare("DELETE FROM candidates WHERE turn_id = ?").run(request.turnId);
        this.crash("before-transaction-commit");
        this.database.exec("COMMIT");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
      this.crash("after-transaction-commit");
      this.crash("before-manifest-materialization");
      this.materialize(this.row(request.turnId)!);
      this.crash("after-manifest-materialization");
      rmSync(operationRoot, { recursive: true, force: true });
      return this.receipt(this.row(request.turnId)!);
    });
  }

  private reconcileRow(row: SavePointRow): ReconciliationResult {
    const reasons = new Set<string>();
    const blobs = this.database.prepare("SELECT role, digest, relative_path FROM save_point_blobs WHERE save_point_id = ? ORDER BY role").all(row.save_point_id) as unknown as BlobRow[];
    for (const blob of blobs) {
      const path = resolve(this.remoRoot, blob.relative_path);
      if (!path.startsWith(`${this.remoRoot}${sep}`) || !existsSync(path)) reasons.add("blob.missing");
      else if (sha256(readFileSync(path)) !== blob.digest) reasons.add("blob.digest-mismatch");
    }
    if (!existsSync(row.manifest_path)) reasons.add("manifest.missing");
    else {
      try {
        const envelope = JSON.parse(readFileSync(row.manifest_path, "utf8")) as { manifest?: unknown; receipt?: { manifestDigest?: string } };
        if (canonicalSerialize(envelope.manifest) !== row.canonical_json || sha256(row.canonical_json) !== row.manifest_digest || envelope.receipt?.manifestDigest !== row.manifest_digest) reasons.add("manifest.digest-mismatch");
      } catch { reasons.add("manifest.invalid"); }
    }
    const reasonCodes = [...reasons].sort();
    const health = reasonCodes.length === 0 ? "complete" : "incomplete";
    const fidelity = health === "complete" ? "editable-eligible" : "degraded";
    this.database.prepare("UPDATE save_points SET materialized = ?, health = ?, fidelity = ?, reasons_json = ? WHERE turn_id = ?").run(health === "complete" ? 1 : 0, health, fidelity, canonicalSerialize(reasonCodes), row.turn_id);
    return { turnId: row.turn_id, savePointId: row.save_point_id, health, fidelity, reasonCodes };
  }

  listHistory(limit = 10): HistoryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new TypeError("History limit must be an integer from 1 to 10.");
    const rows = this.database.prepare("SELECT * FROM history_entries ORDER BY lineage_id = 'lineage:original' DESC, lineage_id, sequence_no, save_point_id LIMIT ?").all(limit + 1) as unknown as HistoryRow[];
    const anchors: HistoryAnchor[] = rows.slice(0, limit).map((row) => ({
      savePointId: row.save_point_id,
      turnId: row.turn_id,
      sequenceNo: row.sequence_no,
      lineageId: row.lineage_id,
      ...(row.parent_save_point_id === null ? {} : { parentSavePointId: row.parent_save_point_id }),
      ...(row.promoted_at === null ? {} : { promotedAt: row.promoted_at }),
      ...(row.major_turn_label === null ? {} : { majorTurnLabel: row.major_turn_label }),
      ...(row.nomination_reason === null ? {} : { nominationReason: row.nomination_reason }),
      state: row.state,
      ...(row.lifecycle_receipt_id === null ? {} : { lifecycleReceiptId: row.lifecycle_receipt_id }),
      provenance: row.provenance,
      integrity: row.integrity,
      fidelity: row.fidelity,
    }));
    const lineageRows = this.database.prepare("SELECT lineage_id, parent_lineage_id, root_save_point_id, branch_operation_id, git_ref, worktree_relative_path, state FROM lineages WHERE state IN ('original', 'active-alternate') ORDER BY state = 'original' DESC, lineage_id LIMIT 2").all() as Array<{ lineage_id: string; parent_lineage_id: string | null; root_save_point_id: string | null; branch_operation_id: string | null; git_ref: string | null; worktree_relative_path: string | null; state: LineageRecord["state"] }>;
    const lineageProjection: LineageRecord[] = lineageRows.map((row) => ({ lineageId: row.lineage_id, ...(row.parent_lineage_id === null ? {} : { parentLineageId: row.parent_lineage_id }), ...(row.root_save_point_id === null ? {} : { rootSavePointId: row.root_save_point_id }), ...(row.branch_operation_id === null ? {} : { branchOperationId: row.branch_operation_id }), ...(row.git_ref === null ? {} : { gitRef: row.git_ref }), ...(row.worktree_relative_path === null ? {} : { worktreeRelativePath: row.worktree_relative_path }), state: row.state }));
    return { anchors, lineages: lineageProjection, limit, truncated: rows.length > limit };
  }

  readEvidenceMedia(request: EvidenceMediaReadRequest): EvidenceMediaReadResult {
    if (!isEvidenceMediaRole(String(request.role))) return { status: "unavailable", reasonCode: "media.invalid-role" };
    const row = this.saveRow(request.savePointId);
    if (row === undefined) {
      const history = this.database.prepare("SELECT state FROM history_entries WHERE save_point_id = ?").get(request.savePointId) as { state: string } | undefined;
      return { status: "unavailable", reasonCode: history?.state === "tombstone" ? "media.lifecycle-unavailable" : "media.save-not-found" };
    }
    if (row.quarantined_at !== null) return { status: "unavailable", reasonCode: "media.quarantined" };
    if (this.isElapsed(row.expires_at, row.pinned_at)) return { status: "unavailable", reasonCode: "media.lifecycle-unavailable" };
    const revision = this.getCurrentRevisionRaw(request.savePointId);
    if (revision === undefined || revision.revision !== request.expectedRevision || revision.manifestDigest !== request.expectedManifestDigest) return { status: "unavailable", reasonCode: "media.stale-binding" };
    let bundle: { readonly savePointId?: unknown; readonly correlation?: { readonly turnId?: unknown }; readonly evidence?: unknown };
    try { bundle = this.readRevisionBundle(revision) as typeof bundle; } catch { return { status: "unavailable", reasonCode: "media.component-mismatch" }; }
    if (bundle.savePointId !== request.savePointId || bundle.correlation?.turnId !== row.turn_id || !isEvidenceDescriptorList(bundle.evidence)) return { status: "unavailable", reasonCode: "media.component-mismatch" };
    const component = bundle.evidence.find(({ componentId }) => componentId === request.componentId);
    if (component === undefined) return { status: "unavailable", reasonCode: "media.component-missing" };
    if (component.componentType !== request.role || component.correlation.turnId !== row.turn_id || component.digest !== request.expectedDigest || component.availability !== "available") return { status: "unavailable", reasonCode: "media.component-mismatch" };
    const catalog = this.database.prepare("SELECT role, digest, byte_size, relative_path FROM save_point_blobs WHERE save_point_id = ? AND role = ?").get(request.savePointId, request.role) as BlobRow | undefined;
    if (catalog === undefined) return { status: "unavailable", reasonCode: "media.catalog-missing" };
    if (catalog.role !== request.role || catalog.digest !== request.expectedDigest) return { status: "unavailable", reasonCode: "media.catalog-mismatch" };
    if (catalog.byte_size > MAX_EVIDENCE_MEDIA_BYTES) return { status: "unavailable", reasonCode: "media.oversized" };
    if (isAbsolute(catalog.relative_path) || catalog.relative_path.split(/[\\/]/u).some((part) => part === "..")) return { status: "unavailable", reasonCode: "media.path-invalid" };
    const path = resolve(this.remoRoot, catalog.relative_path);
    const relativePath = relative(this.remoRoot, path);
    if (relativePath.startsWith("..") || resolve(this.remoRoot, relativePath) !== path) return { status: "unavailable", reasonCode: "media.path-invalid" };
    try { assertNoReparseWithin(this.remoRoot, path); } catch { return { status: "unavailable", reasonCode: "media.link-rejected" }; }
    if (!existsSync(path)) return { status: "unavailable", reasonCode: "media.missing" };
    let descriptor: number;
    try { descriptor = openSync(path, "r"); } catch { return { status: "unavailable", reasonCode: "media.missing" }; }
    try {
      const actual = fstatSync(descriptor);
      if (!actual.isFile()) return { status: "unavailable", reasonCode: "media.path-invalid" };
      if (actual.size > MAX_EVIDENCE_MEDIA_BYTES) return { status: "unavailable", reasonCode: "media.oversized" };
      if (actual.size !== catalog.byte_size) return { status: "unavailable", reasonCode: "media.size-mismatch" };
      const bounded = Buffer.allocUnsafe(catalog.byte_size + 1);
      let byteCount = 0;
      while (byteCount < bounded.byteLength) {
        const read = readSync(descriptor, bounded, byteCount, bounded.byteLength - byteCount, null);
        if (read === 0) break;
        byteCount += read;
      }
      if (byteCount !== catalog.byte_size) return { status: "unavailable", reasonCode: byteCount > MAX_EVIDENCE_MEDIA_BYTES ? "media.oversized" : "media.size-mismatch" };
      const bytes = bounded.subarray(0, byteCount);
      if (sha256(bytes) !== catalog.digest) return { status: "unavailable", reasonCode: "media.digest-mismatch" };
      return { status: "available", savePointId: request.savePointId, componentId: request.componentId, role: request.role, digest: catalog.digest, byteSize: bytes.byteLength, contentType: request.role === "screenshot" ? "image/png" : "application/json", bytes };
    } finally { closeSync(descriptor); }
  }

  appendDecisionRevision(request: DecisionRevisionAppend): DecisionRevisionReceipt {
    return this.serialize(() => {
      safeSegment(request.savePointId, "savePointId"); safeSegment(request.turnId, "turnId");
      if (!Number.isSafeInteger(request.revision) || request.revision < 1) throw new TypeError("Decision revision must be a positive safe integer.");
      assertIsoTimestamp(request.recordedAt, "recordedAt"); assertDigest(request.expectedDigest);
      const history = this.database.prepare("SELECT turn_id FROM history_entries WHERE save_point_id = ?").get(request.savePointId) as { turn_id: string } | undefined;
      const candidate = this.database.prepare("SELECT turn_id FROM candidates WHERE save_point_id = ?").get(request.savePointId) as { turn_id: string } | undefined;
      if (history?.turn_id !== request.turnId && candidate?.turn_id !== request.turnId) throw new FoundationConflictError("decision.revision-conflict", "Decision identity is not bound to the candidate or durable history.");
      const canonical = canonicalSerialize(request.canonicalRecord);
      if (decisionCanonicalDigest(request.canonicalRecord, canonical) !== request.expectedDigest) throw new FoundationConflictError("decision.revision-conflict", "Decision digest does not match canonical bytes.");
      const existing = this.database.prepare("SELECT turn_id, predecessor_digest, canonical_digest, recorded_at FROM decision_revisions WHERE save_point_id = ? AND revision = ?").get(request.savePointId, request.revision) as { turn_id: string; predecessor_digest: string | null; canonical_digest: string; recorded_at: string } | undefined;
      const receipt = { savePointId: request.savePointId, turnId: request.turnId, revision: request.revision, ...(request.predecessorDigest === undefined ? {} : { predecessorDigest: request.predecessorDigest }), digest: request.expectedDigest, recordedAt: request.recordedAt };
      if (existing !== undefined) {
        if (existing.turn_id === request.turnId && existing.predecessor_digest === (request.predecessorDigest ?? null) && existing.canonical_digest === request.expectedDigest && existing.recorded_at === request.recordedAt) {
          const pending = (this.database.prepare("SELECT * FROM save_point_revisions WHERE save_point_id = ? AND materialized = 0 ORDER BY revision").all(request.savePointId) as unknown as RevisionRow[]).filter((row) => {
            const manifest = JSON.parse(row.canonical_json) as { readonly bundle?: { readonly evidence?: readonly { readonly componentType?: unknown; readonly digest?: unknown }[] } };
            return manifest.bundle?.evidence?.some((descriptor) => descriptor.componentType === "decision" && descriptor.digest === request.expectedDigest) === true;
          });
          if (pending.length > 1) throw new FoundationConflictError("decision.revision-conflict", "Decision retry found multiple pending manifest revisions.");
          if (pending[0] !== undefined) this.materializeRevision(pending[0]);
          return receipt;
        }
        throw new FoundationConflictError("decision.revision-conflict", "Decision revision is already bound to different canonical evidence.");
      }
      const predecessor = this.database.prepare("SELECT revision, canonical_digest FROM decision_revisions WHERE save_point_id = ? ORDER BY revision DESC LIMIT 1").get(request.savePointId) as { revision: number; canonical_digest: string } | undefined;
      if (request.revision === 1 ? predecessor !== undefined || request.predecessorDigest !== undefined : predecessor?.revision !== request.revision - 1 || predecessor.canonical_digest !== request.predecessorDigest) throw new FoundationConflictError("decision.revision-conflict", "Decision predecessor evidence does not match.");
      let durableManifest: RevisionRow | undefined;
      if (history !== undefined) {
        const current = this.getCurrentRevision(request.savePointId);
        if (current === undefined) throw new FoundationConflictError("decision.revision-conflict", "The durable manifest revision is unavailable.");
        const revision = current.revision + 1;
        const manifestPath = this.manifestPath(request.savePointId, revision);
        const manifest = {
          schemaVersion: RECONCILED_SCHEMA_VERSION,
          savePointId: request.savePointId,
          turnId: request.turnId,
          revision,
          predecessor: { revision: current.revision, manifestDigest: current.manifestDigest },
          reconciledAt: request.recordedAt,
          traceValidatedAt: current.traceValidatedAt ?? null,
          bundle: withDecisionDescriptorDigest(this.readRevisionBundle(current), request.expectedDigest),
        };
        const canonicalManifest = canonicalSerialize(manifest);
        const manifestDigest = sha256(canonicalManifest);
        const manifestReceipt = {
          status: "reconciled",
          savePointId: request.savePointId,
          turnId: request.turnId,
          revision,
          predecessorRevision: current.revision,
          predecessorManifestDigest: current.manifestDigest,
          manifestDigest,
          manifestPath,
          reconciledAt: request.recordedAt,
          traceValidatedAt: current.traceValidatedAt ?? null,
        };
        durableManifest = { save_point_id: request.savePointId, turn_id: request.turnId, revision, predecessor_revision: current.revision, predecessor_manifest_digest: current.manifestDigest, manifest_digest: manifestDigest, manifest_path: manifestPath, canonical_json: canonicalManifest, receipt_json: canonicalSerialize(manifestReceipt), trace_validated_at: current.traceValidatedAt ?? null, materialized: 0 };
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("INSERT INTO decision_revisions(save_point_id, turn_id, revision, predecessor_digest, canonical_digest, canonical_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(request.savePointId, request.turnId, request.revision, request.predecessorDigest ?? null, request.expectedDigest, canonical, request.recordedAt);
        if (durableManifest !== undefined) this.database.prepare(`INSERT INTO save_point_revisions(save_point_id, turn_id, revision, predecessor_revision, predecessor_manifest_digest, manifest_digest, manifest_path, canonical_json, receipt_json, trace_validated_at, materialized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(durableManifest.save_point_id, durableManifest.turn_id, durableManifest.revision, durableManifest.predecessor_revision, durableManifest.predecessor_manifest_digest, durableManifest.manifest_digest, durableManifest.manifest_path, durableManifest.canonical_json, durableManifest.receipt_json, durableManifest.trace_validated_at);
        this.database.exec("COMMIT");
      } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
      if (durableManifest !== undefined) this.materializeRevision(durableManifest);
      return receipt;
    });
  }

  readDecisionRevisions(savePointId: string): readonly DecisionRevisionRead[] {
    safeSegment(savePointId, "savePointId");
    const rows = this.database.prepare("SELECT save_point_id, turn_id, revision, predecessor_digest, canonical_digest, canonical_json, recorded_at FROM decision_revisions WHERE save_point_id = ? ORDER BY revision").all(savePointId) as unknown as Array<{ save_point_id: string; turn_id: string; revision: number; predecessor_digest: string | null; canonical_digest: string; canonical_json: string; recorded_at: string }>;
    return rows.map((row) => ({ savePointId: row.save_point_id, turnId: row.turn_id, revision: row.revision, ...(row.predecessor_digest === null ? {} : { predecessorDigest: row.predecessor_digest }), digest: row.canonical_digest, recordedAt: row.recorded_at, canonicalRecord: JSON.parse(row.canonical_json) as unknown }));
  }

  readLatestDecisionRevision(savePointId: string): DecisionRevisionRead | undefined {
    return this.readDecisionRevisions(savePointId).at(-1);
  }

  private branchIntentPath(operationId: string): string { return join(this.stagingRoot, `branch-${safeSegment(operationId, "operationId")}.json`); }

  private validateBranchIntent(value: unknown): BranchOperationIntent {
    const input = value as Partial<BranchOperationIntent> & { readonly schemaVersion?: unknown };
    if (input.schemaVersion !== undefined && input.schemaVersion !== "remo.branch-intent.v1") throw new Error("Malformed branch intent: unsupported schema version.");
    const { operationId, intentKey, savePointId, preflightDigest, originalFutureDigest, branchRef, worktreeRelativePath, createdAt } = input;
    if (typeof operationId !== "string" || typeof intentKey !== "string" || typeof savePointId !== "string" || typeof preflightDigest !== "string" || typeof originalFutureDigest !== "string" || typeof branchRef !== "string" || typeof worktreeRelativePath !== "string" || typeof createdAt !== "string") throw new Error("Malformed branch intent: every identity and binding field is required.");
    safeSegment(operationId, "operationId"); safeSegment(intentKey, "intentKey"); safeSegment(savePointId, "savePointId");
    assertDigest(preflightDigest); assertDigest(originalFutureDigest); assertIsoTimestamp(createdAt, "createdAt");
    if (!/^refs\/heads\/remo\/[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/u.test(branchRef) || branchRef.includes("..")) throw new Error("Malformed branch intent: branch ref is outside the ReMo namespace.");
    if (worktreeRelativePath !== `.remo/worktrees/${operationId}`) throw new Error("Malformed branch intent: worktree path is not the derived locked location.");
    let execution: BranchOperationIntent["execution"];
    if (input.execution !== undefined) {
      if (typeof input.execution !== "object" || input.execution === null || Array.isArray(input.execution)) throw new Error("Malformed branch intent: execution evidence is invalid.");
      const candidate = input.execution;
      if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(["displayLabel", "freshPreflightReceipt", "originalFuture", "savePointRevision", "sourceCommit"])) throw new Error("Malformed branch intent: execution evidence fields are invalid.");
      const receipt = assertBranchPreflightReceipt(candidate.freshPreflightReceipt);
      if (!Number.isSafeInteger(candidate.savePointRevision) || candidate.savePointRevision < 1 || !/^[0-9a-f]{40}$/u.test(candidate.sourceCommit) || typeof candidate.displayLabel !== "string" || candidate.displayLabel.length < 1 || candidate.displayLabel.length > 80 || [...candidate.displayLabel].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; })) throw new Error("Malformed branch intent: execution evidence values are invalid.");
      if (receipt.savePointId !== savePointId || receipt.savePointRevision !== candidate.savePointRevision || receipt.sourceCommit !== candidate.sourceCommit || receipt.target.operationId !== operationId || receipt.target.branchRef !== branchRef || receipt.target.worktreeRelativePath !== worktreeRelativePath || receipt.originalFutureDigest !== originalFutureDigest || sha256Canonical(candidate.originalFuture) !== originalFutureDigest) throw new Error("Malformed branch intent: execution evidence does not match its durable identity.");
      execution = candidate;
    }
    return { operationId, intentKey, savePointId, preflightDigest, originalFutureDigest, branchRef, worktreeRelativePath, createdAt, ...(execution === undefined ? {} : { execution }) };
  }

  private branchReceipt(row: BranchOperationRow): BranchOperationReceipt {
    const intentPath = this.branchIntentPath(row.operation_id);
    let execution: BranchOperationIntent["execution"];
    if (existsSync(intentPath)) {
      try { execution = this.validateBranchIntent(JSON.parse(readFileSync(intentPath, "utf8")) as unknown).execution; } catch { execution = undefined; }
    }
    return { operationId: row.operation_id, intentKey: row.intent_key, savePointId: row.save_point_id, preflightDigest: row.preflight_digest, originalFutureDigest: row.original_future_digest, branchRef: row.branch_ref, worktreeRelativePath: row.worktree_relative_path, createdAt: row.created_at, ...(execution === undefined ? {} : { execution }), state: row.state, ...(row.canonical_result === null ? {} : { canonicalResult: JSON.parse(row.canonical_result) as unknown }), updatedAt: row.updated_at };
  }

  beginBranchOperation(request: BranchOperationIntent): BranchOperationReceipt {
    return this.serialize(() => {
      const intent = this.validateBranchIntent(request);
      const path = this.branchIntentPath(intent.operationId);
      const bytes = canonicalSerialize({ schemaVersion: "remo.branch-intent.v1", ...intent });
      const existing = this.database.prepare("SELECT * FROM branch_operations WHERE operation_id = ? OR intent_key = ?").get(intent.operationId, intent.intentKey) as BranchOperationRow | undefined;
      if (existing !== undefined) {
        const receipt = this.branchReceipt(existing);
        const durableIntent = { operationId: receipt.operationId, intentKey: receipt.intentKey, savePointId: receipt.savePointId, preflightDigest: receipt.preflightDigest, originalFutureDigest: receipt.originalFutureDigest, branchRef: receipt.branchRef, worktreeRelativePath: receipt.worktreeRelativePath, createdAt: receipt.createdAt, ...(receipt.execution === undefined ? {} : { execution: receipt.execution }) };
        if (existing.operation_id !== intent.operationId || canonicalSerialize(durableIntent) !== canonicalSerialize(intent)) throw new FoundationConflictError("branch.intent-conflict", "Branch intent key is already bound to different evidence.");
        return receipt;
      }
      const blocking = this.database.prepare("SELECT operation_id, state FROM branch_operations WHERE state IN ('pending', 'succeeded', 'recovery-required') ORDER BY created_at, operation_id LIMIT 1").get() as { operation_id: string; state: string } | undefined;
      if (blocking !== undefined) throw new FoundationConflictError("branch.state-conflict", `Branch operation ${blocking.operation_id} is ${blocking.state}; exactly one alternate lineage is permitted.`);
      if (existsSync(path) && readFileSync(path, "utf8") !== bytes) throw new FoundationConflictError("branch.intent-conflict", "Branch staging intent contains different canonical evidence.");
      if (!existsSync(path)) { writeAndFsync(path, bytes); fsyncDirectory(this.stagingRoot); }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("INSERT INTO branch_operations(operation_id, intent_key, save_point_id, preflight_digest, original_future_digest, branch_ref, worktree_relative_path, state, canonical_result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)").run(intent.operationId, intent.intentKey, intent.savePointId, intent.preflightDigest, intent.originalFutureDigest, intent.branchRef, intent.worktreeRelativePath, intent.createdAt, intent.createdAt);
        this.database.exec("COMMIT");
      } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
      return this.branchReceipt(this.database.prepare("SELECT * FROM branch_operations WHERE operation_id = ?").get(intent.operationId) as unknown as BranchOperationRow);
    });
  }

  appendBranchOperationReceipt(request: BranchOperationCompletion): BranchOperationReceipt {
    return this.serialize(() => {
      safeSegment(request.operationId, "operationId"); assertIsoTimestamp(request.updatedAt, "updatedAt");
      const current = this.database.prepare("SELECT * FROM branch_operations WHERE operation_id = ?").get(request.operationId) as BranchOperationRow | undefined;
      if (current === undefined) throw new FoundationConflictError("branch.state-conflict", "Branch operation has no durable intent.");
      if (request.state === "succeeded") {
        if (request.lineage === undefined || request.lineage.state !== "active-alternate" || request.lineage.branchOperationId !== request.operationId || request.lineage.rootSavePointId !== current.save_point_id) {
          throw new FoundationConflictError("branch.state-conflict", "A successful branch operation requires matching active-alternate lineage evidence.");
        }
      } else if (request.lineage !== undefined) {
        throw new FoundationConflictError("branch.state-conflict", "Only a successful branch operation may append lineage evidence.");
      }
      const result = canonicalSerialize(request.canonicalResult);
      if (current.state !== "pending") {
        if (current.state === request.state && current.canonical_result === result && current.updated_at === request.updatedAt) return this.branchReceipt(current);
        throw new FoundationConflictError("branch.state-conflict", "Branch operation is already finalized with different evidence.");
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (request.lineage !== undefined) {
          const lineage = request.lineage;
          const active = this.database.prepare("SELECT lineage_id FROM lineages WHERE state = 'active-alternate' AND branch_operation_id <> ? LIMIT 1").get(request.operationId) as { lineage_id: string } | undefined;
          if (active !== undefined) throw new FoundationConflictError("branch.state-conflict", `Active alternate lineage ${active.lineage_id} already exists.`);
          this.database.prepare("INSERT INTO lineages(lineage_id, parent_lineage_id, root_save_point_id, branch_operation_id, git_ref, worktree_relative_path, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(lineage.lineageId, lineage.parentLineageId ?? null, lineage.rootSavePointId ?? null, lineage.branchOperationId ?? null, lineage.gitRef ?? null, lineage.worktreeRelativePath ?? null, lineage.state, request.updatedAt);
        }
        this.database.prepare("UPDATE branch_operations SET state = ?, canonical_result = ?, updated_at = ? WHERE operation_id = ? AND state = 'pending'").run(request.state, result, request.updatedAt, request.operationId);
        this.database.exec("COMMIT");
      } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
      const receipt = this.branchReceipt(this.database.prepare("SELECT * FROM branch_operations WHERE operation_id = ?").get(request.operationId) as unknown as BranchOperationRow);
      writeAndFsync(join(this.receiptsRoot, `branch-${safeSegment(request.operationId, "operationId")}.json`), canonicalSerialize(receipt));
      const intentPath = this.branchIntentPath(request.operationId); if (existsSync(intentPath)) unlinkSync(intentPath);
      fsyncDirectory(this.receiptsRoot); fsyncDirectory(this.stagingRoot);
      return receipt;
    });
  }

  listPendingBranchOperations(): readonly BranchOperationReceipt[] {
    return (this.database.prepare("SELECT * FROM branch_operations WHERE state = 'pending' ORDER BY created_at, operation_id").all() as unknown as BranchOperationRow[]).map((row) => this.branchReceipt(row));
  }

  listJournaledBranchIntents(): readonly BranchOperationIntent[] {
    const intents: BranchOperationIntent[] = [];
    for (const entry of readdirSync(this.stagingRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith("branch-") || !entry.name.endsWith(".json")) continue;
      const path = join(this.stagingRoot, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error("Private staging contains a symbolic-link branch intent.");
      let decoded: unknown;
      try { decoded = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new Error("Private staging contains a malformed branch intent."); }
      const intent = this.validateBranchIntent(decoded);
      if (entry.name !== `branch-${intent.operationId}.json`) throw new Error("Private staging branch intent filename does not match its operation identity.");
      intents.push(intent);
    }
    return intents.sort((left, right) => left.createdAt.localeCompare(right.createdAt, "en-US") || left.operationId.localeCompare(right.operationId, "en-US"));
  }

  listBranchOperations(): readonly BranchOperationReceipt[] {
    return (this.database.prepare("SELECT * FROM branch_operations ORDER BY created_at, operation_id").all() as unknown as BranchOperationRow[]).map((row) => this.branchReceipt(row));
  }

  readBranchOperationByIntentKey(intentKey: string): BranchOperationReceipt | undefined {
    safeSegment(intentKey, "intentKey");
    const row = this.database.prepare("SELECT * FROM branch_operations WHERE intent_key = ?").get(intentKey) as BranchOperationRow | undefined;
    return row === undefined ? undefined : this.branchReceipt(row);
  }

  markBranchOperationUnavailable(request: { readonly operationId: string; readonly canonicalResult: unknown; readonly updatedAt: string }): BranchOperationReceipt {
    return this.serialize(() => {
      safeSegment(request.operationId, "operationId"); assertIsoTimestamp(request.updatedAt, "updatedAt");
      const current = this.database.prepare("SELECT * FROM branch_operations WHERE operation_id = ?").get(request.operationId) as BranchOperationRow | undefined;
      if (current === undefined || current.state !== "succeeded") throw new FoundationConflictError("branch.state-conflict", "Only a succeeded branch operation may become unavailable.");
      const result = canonicalSerialize(request.canonicalResult);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("UPDATE lineages SET state = 'recovery-required' WHERE branch_operation_id = ? AND state = 'active-alternate'").run(request.operationId);
        this.database.prepare("UPDATE branch_operations SET state = 'recovery-required', canonical_result = ?, updated_at = ? WHERE operation_id = ? AND state = 'succeeded'").run(result, request.updatedAt, request.operationId);
        this.database.exec("COMMIT");
      } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
      const receipt = this.branchReceipt(this.database.prepare("SELECT * FROM branch_operations WHERE operation_id = ?").get(request.operationId) as unknown as BranchOperationRow);
      writeAndFsync(join(this.receiptsRoot, `branch-${safeSegment(request.operationId, "operationId")}-unavailable.json`), canonicalSerialize(receipt));
      fsyncDirectory(this.receiptsRoot);
      return receipt;
    });
  }

  reconcileStartup(): readonly ReconciliationResult[] {
    return this.serialize(() => {
      for (const entry of readdirSync(this.stagingRoot, { withFileTypes: true })) {
        const path = join(this.stagingRoot, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Private staging contains a symbolic link or reparse point: ${path}`);
        if (entry.isFile() && entry.name.startsWith("delete-pending-") && entry.name.endsWith(".json")) {
          const pending = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; operationId?: unknown; savePointId?: unknown; action?: unknown };
          if (pending.schemaVersion !== "remo.pending-deletion.v1" || typeof pending.operationId !== "string" || typeof pending.savePointId !== "string" || (pending.action !== "delete" && pending.action !== "expire")) throw new Error("Private staging contains an invalid pending deletion intent.");
          this.deleteDurableInternal(pending.savePointId, pending.operationId, pending.action);
        } else if (entry.isFile() && entry.name.startsWith("branch-") && entry.name.endsWith(".json")) {
          let decoded: unknown;
          try { decoded = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new Error("Private staging contains a malformed branch intent."); }
          const intent = this.validateBranchIntent(decoded);
          if (entry.name !== `branch-${intent.operationId}.json`) throw new Error("Private staging branch intent filename does not match its operation identity.");
          const durable = this.database.prepare("SELECT * FROM branch_operations WHERE operation_id = ?").get(intent.operationId) as BranchOperationRow | undefined;
          if (durable !== undefined) {
            const receipt = this.branchReceipt(durable);
            const durableIntent = { operationId: receipt.operationId, intentKey: receipt.intentKey, savePointId: receipt.savePointId, preflightDigest: receipt.preflightDigest, originalFutureDigest: receipt.originalFutureDigest, branchRef: receipt.branchRef, worktreeRelativePath: receipt.worktreeRelativePath, createdAt: receipt.createdAt, ...(receipt.execution === undefined ? {} : { execution: receipt.execution }) };
            if (canonicalSerialize(durableIntent) !== canonicalSerialize(intent)) throw new Error("Private staging branch intent conflicts with its durable operation record.");
            if (durable.state !== "pending") {
              const receiptPath = join(this.receiptsRoot, `branch-${safeSegment(intent.operationId, "operationId")}.json`);
              const receiptBytes = canonicalSerialize(receipt);
              if (existsSync(receiptPath)) {
                const receiptStat = lstatSync(receiptPath);
                if (receiptStat.isSymbolicLink() || !receiptStat.isFile() || readFileSync(receiptPath, "utf8") !== receiptBytes) throw new Error("Private branch receipt conflicts with its durable operation record.");
              } else writeAndFsync(receiptPath, receiptBytes);
              fsyncDirectory(this.receiptsRoot);
              unlinkSync(path);
              fsyncDirectory(this.stagingRoot);
            }
          }
        } else rmSync(path, { recursive: true, force: true });
      }
      const rows = this.database.prepare("SELECT * FROM save_points ORDER BY turn_id").all() as unknown as SavePointRow[];
      const results = rows.map((row) => {
        const result = this.reconcileRow(row);
        if (result.reasonCodes.length === 1 && result.reasonCodes[0] === "manifest.missing") {
          this.materialize(this.row(row.turn_id)!);
          return this.reconcileRow(this.row(row.turn_id)!);
        }
        return result;
      });
      const revisionRows = this.database.prepare("SELECT * FROM save_point_revisions ORDER BY save_point_id, revision").all() as unknown as RevisionRow[];
      for (const revision of revisionRows) {
        const predecessor = revision.revision === 2
          ? this.database.prepare("SELECT revision, manifest_digest FROM save_points WHERE save_point_id = ?").get(revision.save_point_id) as { revision: number; manifest_digest: string } | undefined
          : this.database.prepare("SELECT revision, manifest_digest FROM save_point_revisions WHERE save_point_id = ? AND revision = ?").get(revision.save_point_id, revision.revision - 1) as { revision: number; manifest_digest: string } | undefined;
        if (predecessor?.revision !== revision.predecessor_revision || predecessor.manifest_digest !== revision.predecessor_manifest_digest) throw new Error(`Reconciled manifest revision ${revision.revision} has corrupt predecessor evidence.`);
        if (sha256(revision.canonical_json) !== revision.manifest_digest) throw new Error(`Reconciled manifest revision ${revision.revision} has a corrupt catalog digest.`);
        if (revision.materialized === 0) {
          this.materializeRevision(revision);
        } else if (!existsSync(revision.manifest_path)) {
          throw new Error(`Authoritative reconciled manifest revision ${revision.revision} is missing.`);
        } else {
          const envelope = canonicalSerialize({ manifest: JSON.parse(revision.canonical_json) as unknown, receipt: JSON.parse(revision.receipt_json) as unknown });
          if (readFileSync(revision.manifest_path, "utf8") !== envelope) throw new Error(`Authoritative reconciled manifest revision ${revision.revision} is corrupt.`);
        }
      }
      const historyRows = this.database.prepare("SELECT * FROM history_entries ORDER BY lineage_id, sequence_no, save_point_id").all() as unknown as HistoryRow[];
      const historyBySlot = new Map(historyRows.map((row) => [`${row.lineage_id}\u0000${row.sequence_no}`, row]));
      for (const history of historyRows) {
        if (history.state === "tombstone") {
          if (history.lifecycle_receipt_id === null || history.parent_save_point_id !== null || history.promoted_at !== null || history.major_turn_label !== null || history.nomination_reason !== null) throw new Error("History tombstone contains unsupported or unauthoritative fields.");
          continue;
        }
        const predecessor = historyBySlot.get(`${history.lineage_id}\u0000${history.sequence_no - 1}`);
        if ((predecessor?.save_point_id ?? null) !== history.parent_save_point_id) throw new Error("History predecessor evidence is inconsistent.");
      }
      const decisions = this.database.prepare("SELECT save_point_id, revision, predecessor_digest, canonical_digest, canonical_json FROM decision_revisions ORDER BY save_point_id, revision").all() as unknown as Array<{ save_point_id: string; revision: number; predecessor_digest: string | null; canonical_digest: string; canonical_json: string }>;
      const decisionDigests = new Map<string, string>();
      for (const decision of decisions) {
        const previous = decisionDigests.get(`${decision.save_point_id}\u0000${decision.revision - 1}`) ?? null;
        const canonicalRecord = JSON.parse(decision.canonical_json) as unknown;
        if (decision.predecessor_digest !== previous || decisionCanonicalDigest(canonicalRecord, decision.canonical_json) !== decision.canonical_digest) throw new Error("Decision predecessor or digest evidence is inconsistent.");
        decisionDigests.set(`${decision.save_point_id}\u0000${decision.revision}`, decision.canonical_digest);
      }
      const referencedRows = this.database.prepare("SELECT relative_path FROM save_point_blobs UNION SELECT relative_path FROM candidate_blobs").all() as unknown as { relative_path: string }[];
      const referenced = new Set(referencedRows.map(({ relative_path }) => resolve(this.remoRoot, relative_path)));
      const sweep = (path: string): void => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isSymbolicLink()) throw new Error(`CAS contains a symbolic link or reparse point: ${child}`);
          if (entry.isDirectory()) {
            sweep(child);
            if (readdirSync(child).length === 0) rmdirSync(child);
          } else if (!referenced.has(resolve(child))) unlinkSync(child);
        }
      };
      sweep(this.blobsRoot);
      return results;
    });
  }

  close(): void { this.database.close(); }
}
