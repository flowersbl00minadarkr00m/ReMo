import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateTreePermissions, canonicalSerialize } from "@remo/storage-local";
import { assertPayloadNeutralDiagnosticEvent, type DiagnosticResult, type PayloadNeutralDiagnosticEvent } from "./diagnostic-event.js";
import { inspectOperationalDiagnosticsFile, MAX_OPERATIONAL_DIAGNOSTICS_BYTES, OperationalDiagnosticsUnsafePathError, operationalDiagnosticsPath } from "./operational-jsonl.js";

const MAX_INVENTORY_ENTRIES = 10_000;
const EMPTY = Object.freeze({});

interface DurableRow {
  readonly turn_id: string;
  readonly save_point_id: string;
  readonly manifest_digest: string;
  readonly manifest_path: string;
  readonly canonical_json: string;
  readonly receipt_json: string;
}

interface RevisionRow {
  readonly turn_id: string;
  readonly save_point_id: string;
  readonly manifest_digest: string;
  readonly manifest_path: string;
  readonly canonical_json: string;
  readonly receipt_json: string;
}

interface BlobRow {
  readonly save_point_id?: string;
  readonly turn_id?: string;
  readonly digest: string;
  readonly byte_size: number;
  readonly relative_path: string;
}

interface DatabaseInventory {
  readonly schemaVersion: number;
  readonly durable: readonly DurableRow[];
  readonly revisions: readonly RevisionRow[];
  readonly blobs: readonly BlobRow[];
  readonly candidateCount: number;
  readonly branchOperations: readonly { readonly operation_id: string; readonly state: string; readonly canonical_result: string | null }[];
  readonly integrityOk: boolean;
}

export interface SupportCommandOptions {
  readonly projectRoot: string;
  readonly probeLangfuse?: () => Promise<boolean>;
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function resultFor(reasons: readonly string[], degradedReasons: readonly string[] = []): DiagnosticResult {
  if (reasons.length === 0) return "pass";
  return reasons.every((reason) => degradedReasons.includes(reason)) ? "degraded" : "fail";
}

function event(input: Partial<PayloadNeutralDiagnosticEvent> & Pick<PayloadNeutralDiagnosticEvent, "operationId" | "result">): PayloadNeutralDiagnosticEvent {
  return {
    eventId: `vs001.${input.operationId}`,
    operationId: input.operationId,
    turnIds: input.turnIds ?? [],
    savePointIds: input.savePointIds ?? [],
    reasonCodes: input.reasonCodes ?? [],
    sizes: input.sizes ?? EMPTY,
    digests: input.digests ?? EMPTY,
    policyVersions: input.policyVersions ?? EMPTY,
    result: input.result,
  };
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !resolve(root, rel).startsWith(`..${sep}`);
}

function readDatabase(catalogPath: string): DatabaseInventory {
  const snapshotRoot = mkdtempSync(join(tmpdir(), "remo-support-db-"));
  const snapshotCatalog = join(snapshotRoot, "catalog.sqlite");
  copyFileSync(catalogPath, snapshotCatalog);
  for (const suffix of ["-wal", "-shm"] as const) {
    if (existsSync(`${catalogPath}${suffix}`)) copyFileSync(`${catalogPath}${suffix}`, `${snapshotCatalog}${suffix}`);
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(snapshotCatalog, { readOnly: true, timeout: 1_000 });
    database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    const integrity = database.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
    const schema = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const durable = database.prepare("SELECT turn_id, save_point_id, manifest_digest, manifest_path, canonical_json, receipt_json FROM save_points ORDER BY turn_id").all() as unknown as DurableRow[];
    const revisions = database.prepare("SELECT turn_id, save_point_id, manifest_digest, manifest_path, canonical_json, receipt_json FROM save_point_revisions ORDER BY save_point_id, revision").all() as unknown as RevisionRow[];
    const durableBlobs = database.prepare("SELECT save_point_id, digest, byte_size, relative_path FROM save_point_blobs ORDER BY save_point_id, role").all() as unknown as BlobRow[];
    const candidateBlobs = database.prepare("SELECT turn_id, digest, byte_size, relative_path FROM candidate_blobs ORDER BY turn_id, role").all() as unknown as BlobRow[];
    const candidates = database.prepare("SELECT COUNT(*) AS count FROM candidates").get() as { count: number };
    const branchOperations = schema.user_version >= 4 ? database.prepare("SELECT operation_id, state, canonical_result FROM branch_operations ORDER BY created_at, operation_id").all() as unknown as DatabaseInventory["branchOperations"] : [];
    return { schemaVersion: schema.user_version, durable, revisions, blobs: [...durableBlobs, ...candidateBlobs], candidateCount: candidates.count, branchOperations, integrityOk: integrity.length === 1 && integrity[0]?.integrity_check === "ok" };
  } finally {
    database?.close();
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

function manifestReasons(manifestsRoot: string, rows: readonly (DurableRow | RevisionRow)[]): { readonly reasons: string[]; readonly totalBytes: number } {
  const reasons = new Set<string>();
  let totalBytes = 0;
  for (const row of rows) {
    const path = resolve(row.manifest_path);
    if (!contained(manifestsRoot, path)) { reasons.add("manifest.path-outside-root"); continue; }
    if (!existsSync(path)) { reasons.add("manifest.missing"); continue; }
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) { reasons.add("manifest.invalid-entry"); continue; }
    const bytes = readFileSync(path);
    totalBytes += bytes.byteLength;
    try {
      const envelope = JSON.parse(bytes.toString("utf8")) as { manifest?: unknown; receipt?: { manifestDigest?: unknown } };
      if (sha256(row.canonical_json) !== row.manifest_digest
        || canonicalSerialize(envelope.manifest) !== row.canonical_json
        || envelope.receipt?.manifestDigest !== row.manifest_digest) reasons.add("manifest.digest-mismatch");
    } catch { reasons.add("manifest.invalid"); }
  }
  return { reasons: [...reasons].sort(), totalBytes };
}

function blobReasons(remoRoot: string, rows: readonly BlobRow[]): { readonly reasons: string[]; readonly totalBytes: number; readonly fileCount: number } {
  const reasons = new Set<string>();
  const observed = new Set<string>();
  let totalBytes = 0;
  for (const row of rows) {
    const path = resolve(remoRoot, row.relative_path);
    if (!contained(remoRoot, path)) { reasons.add("blob.path-outside-root"); continue; }
    if (!existsSync(path)) { reasons.add("blob.missing"); continue; }
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) { reasons.add("blob.invalid-entry"); continue; }
    if (observed.has(path)) continue;
    observed.add(path);
    const bytes = readFileSync(path);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength !== row.byte_size) reasons.add("blob.size-mismatch");
    if (sha256(bytes) !== row.digest) reasons.add("blob.digest-mismatch");
  }
  return { reasons: [...reasons].sort(), totalBytes, fileCount: observed.size };
}

function inventorySize(path: string): { readonly entries: number; readonly bytes: number; readonly reasonCodes: readonly string[] } {
  if (!existsSync(path)) return { entries: 0, bytes: 0, reasonCodes: ["staging.missing"] };
  const reasons = new Set<string>();
  let entries = 0;
  let bytes = 0;
  const visit = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_INVENTORY_ENTRIES) { reasons.add("staging.inventory-limit"); return; }
      const child = join(current, item.name);
      if (item.isSymbolicLink()) reasons.add("staging.reparse-entry");
      else if (item.isDirectory()) visit(child);
      else if (item.isFile()) bytes += statSync(child).size;
      else reasons.add("staging.invalid-entry");
    }
  };
  visit(path);
  if (entries > 0) reasons.add("staging.pending-or-orphaned");
  return { entries, bytes, reasonCodes: [...reasons].sort() };
}

function permissionsVerified(root: string): boolean {
  try {
    assertPrivateTreePermissions(root);
    return true;
  } catch {
    return false;
  }
}

function unavailableEvents(reasonCode: string): PayloadNeutralDiagnosticEvent[] {
  return ["support.database", "support.manifests", "support.blobs", "support.staging", "support.permissions", "support.branch-operations"].map((operationId) => event({ operationId, reasonCodes: [reasonCode], result: "fail" }));
}

function operationalLogEvent(projectRoot: string): PayloadNeutralDiagnosticEvent {
  const current = operationalDiagnosticsPath(projectRoot);
  const paths = [join(resolve(current, ".."), "vs001-operational.previous.jsonl"), current];
  const reasons = new Set<string>();
  let bytes = 0;
  let entries = 0;
  let files = 0;
  const allowedKeys = new Set(["eventId", "operationId", "operationInstanceId", "occurredAt", "turnIds", "savePointIds", "reasonCodes", "durationMs", "perTurnLatencyMs", "retryCount", "sizes", "digests", "policyVersions", "outcomes", "result"]);
  for (const path of paths) {
    let inspected: { readonly exists: boolean; readonly size: number };
    try {
      inspected = inspectOperationalDiagnosticsFile(projectRoot, path);
    } catch (error) {
      if (error instanceof OperationalDiagnosticsUnsafePathError) { reasons.add("operational.unsafe-path"); continue; }
      throw error;
    }
    if (!inspected.exists) continue;
    files += 1;
    const { size } = inspectOperationalDiagnosticsFile(projectRoot, path);
    bytes += size;
    if (size > MAX_OPERATIONAL_DIAGNOSTICS_BYTES) reasons.add("operational.file-too-large");
    inspectOperationalDiagnosticsFile(projectRoot, path);
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      entries += 1;
      try {
        const parsed = JSON.parse(line) as PayloadNeutralDiagnosticEvent;
        if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) reasons.add("operational.schema-not-payload-neutral");
        assertPayloadNeutralDiagnosticEvent(parsed);
      } catch { reasons.add("operational.invalid-event"); }
    }
  }
  if (files === 0 && reasons.size === 0) return event({ operationId: "support.operational-log", reasonCodes: ["operational.not-initialized"], result: "unavailable" });
  const reasonCodes = [...reasons].sort();
  return event({ operationId: "support.operational-log", reasonCodes, sizes: { operationalFiles: files, operationalEvents: entries, operationalBytes: bytes }, policyVersions: { operationalSchema: "vs001-operational-v1", operationalRetention: "two-generation-1mib" }, result: resultFor(reasonCodes) });
}

export async function runSupportCommand(options: SupportCommandOptions): Promise<readonly PayloadNeutralDiagnosticEvent[]> {
  const projectRoot = realpathSync.native(resolve(options.projectRoot));
  const remoRoot = join(projectRoot, ".remo");
  const catalogPath = join(remoRoot, "catalog.sqlite");
  const manifestsRoot = join(remoRoot, "manifests");
  const stagingRoot = join(remoRoot, "staging");
  let events: PayloadNeutralDiagnosticEvent[];
  if (!existsSync(remoRoot) || !existsSync(catalogPath)) {
    events = unavailableEvents("storage.not-initialized");
  } else {
    let inventory: DatabaseInventory;
    try { inventory = readDatabase(catalogPath); }
    catch { inventory = { schemaVersion: 0, durable: [], revisions: [], blobs: [], candidateCount: 0, branchOperations: [], integrityOk: false }; }
    const dbReasons = inventory.integrityOk ? [] : ["database.integrity-failed"];
    const manifest = manifestReasons(manifestsRoot, [...inventory.durable, ...inventory.revisions]);
    const blobs = blobReasons(remoRoot, inventory.blobs);
    const staging = inventorySize(stagingRoot);
    const permissions = permissionsVerified(remoRoot);
    const turnIds = [...new Set([...inventory.durable, ...inventory.revisions].map(({ turn_id }) => turn_id))].sort();
    const savePointIds = [...new Set([...inventory.durable, ...inventory.revisions].map(({ save_point_id }) => save_point_id))].sort();
    const pendingBranches = inventory.branchOperations.filter(({ state }) => state === "pending");
    const recoveryBranches = inventory.branchOperations.filter(({ state }) => state === "recovery-required");
    const unavailableBranches = recoveryBranches.filter(({ canonical_result }) => canonical_result?.includes('"state":"unavailable"') === true);
    const branchReasons = [...(pendingBranches.length === 0 ? [] : ["branch.pending"]), ...(recoveryBranches.length === 0 ? [] : ["branch.recovery-required"]), ...(unavailableBranches.length === 0 ? [] : ["branch.unavailable"])];
    events = [
      event({ operationId: "support.database", turnIds, savePointIds, reasonCodes: dbReasons, sizes: { durableRows: inventory.durable.length, revisionRows: inventory.revisions.length, candidateRows: inventory.candidateCount }, policyVersions: { storageSchema: String(inventory.schemaVersion) }, result: resultFor(dbReasons) }),
      event({ operationId: "support.manifests", turnIds, savePointIds, reasonCodes: manifest.reasons, sizes: { manifestFiles: inventory.durable.length + inventory.revisions.length, manifestBytes: manifest.totalBytes }, digests: { manifest: [...new Set([...inventory.durable, ...inventory.revisions].map(({ manifest_digest }) => manifest_digest))].sort() }, result: resultFor(manifest.reasons) }),
      event({ operationId: "support.blobs", savePointIds: [...new Set(inventory.blobs.flatMap(({ save_point_id }) => save_point_id === undefined ? [] : [save_point_id]))].sort(), turnIds: [...new Set(inventory.blobs.flatMap(({ turn_id }) => turn_id === undefined ? [] : [turn_id]))].sort(), reasonCodes: blobs.reasons, sizes: { blobFiles: blobs.fileCount, blobBytes: blobs.totalBytes }, digests: { blob: [...new Set(inventory.blobs.map(({ digest }) => digest))].sort() }, result: resultFor(blobs.reasons) }),
      event({ operationId: "support.staging", reasonCodes: staging.reasonCodes, sizes: { stagingEntries: staging.entries, stagingBytes: staging.bytes }, result: resultFor(staging.reasonCodes, ["staging.pending-or-orphaned"]) }),
      event({ operationId: "support.permissions", reasonCodes: permissions ? [] : ["permissions.not-owner-only"], policyVersions: { permissionModel: process.platform === "win32" ? "windows-acl-current-user-only" : "posix-owner-only" }, result: permissions ? "pass" : "fail" }),
      event({ operationId: "support.branch-operations", reasonCodes: branchReasons, sizes: { branchOperations: inventory.branchOperations.length, pendingBranches: pendingBranches.length, recoveryBranches: recoveryBranches.length, unavailableBranches: unavailableBranches.length }, policyVersions: { branchState: "remo.branch-result.v1" }, result: branchReasons.length === 0 ? "pass" : "degraded" }),
    ];
  }
  let adapterEvent: PayloadNeutralDiagnosticEvent;
  if (options.probeLangfuse === undefined) adapterEvent = event({ operationId: "support.langfuse-reachability", reasonCodes: ["adapter.langfuse.not-configured"], result: "unavailable" });
  else {
    try {
      const reachable = await options.probeLangfuse();
      adapterEvent = event({ operationId: "support.langfuse-reachability", reasonCodes: reachable ? [] : ["adapter.langfuse.unreachable"], result: reachable ? "pass" : "unavailable" });
    } catch { adapterEvent = event({ operationId: "support.langfuse-reachability", reasonCodes: ["adapter.langfuse.unreachable"], result: "unavailable" }); }
  }
  return [...events, operationalLogEvent(projectRoot), adapterEvent];
}
