import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalSavePointRepository,
  PromotionCrashError,
  type PromotionCrashPoint,
  type PromotionRequest,
  type ReconciliationCrashPoint,
} from "./index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "remo-storage-t5-"));
  roots.push(root);
  return root;
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory() ? filesUnder(join(root, entry.name)) : [join(root, entry.name)]));
  return nested.flat();
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function request(turnSuffix = "T5", saveSuffix = "S5"): PromotionRequest {
  const rrweb = Buffer.from(`masked rrweb ${turnSuffix}`);
  const screenshot = Buffer.from(`masked screenshot ${turnSuffix}`);
  return {
    operationId: `operation-${turnSuffix}`,
    turnId: `01J000000000000000000000${turnSuffix}`,
    savePointId: `01J000000000000000000000${saveSuffix}`,
    revision: 1,
    candidateRevision: 1,
    candidateManifestDigest: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-08-16T07:30:00.000Z",
    policyRevision: "remo.privacy.v1",
    bundle: { schemaVersion: "remo.bundle.v1", integrity: { state: "complete" }, evidence: ["safe"] },
    blobs: [
      { role: "rrweb", bytes: rrweb, expectedDigest: sha256(rrweb) },
      { role: "screenshot", bytes: screenshot, expectedDigest: sha256(screenshot) },
    ],
  };
}

const reconciledBundle = { schemaVersion: "remo.bundle.v1", savePointId: "01J000000000000000000000S5", correlation: { turnId: "01J000000000000000000000T5" }, integrity: { state: "incomplete" }, evidence: ["safe"] } as const;

function appendReconciliation(repository: LocalSavePointRepository) {
  const current = repository.getCurrentRevision(request().savePointId)!;
  return repository.appendReconciliation({
    savePointId: current.savePointId,
    turnId: current.turnId,
    expectedRevision: current.revision,
    expectedManifestDigest: current.manifestDigest,
    traceValidatedAt: "2026-08-16T08:04:00.000Z",
    bundle: reconciledBundle,
  });
}

async function createLegacyCatalog(root: string, version: 1 | 2): Promise<{ readonly turnId: string; readonly savePointId: string; readonly manifestDigest: string; readonly backupPath: string }> {
  const remoRoot = join(root, ".remo");
  await mkdir(remoRoot, { recursive: true });
  const catalogPath = join(remoRoot, "catalog.sqlite");
  const database = new DatabaseSync(catalogPath);
  const turnId = request().turnId;
  const savePointId = request().savePointId;
  const canonicalJson = JSON.stringify({ schemaVersion: "remo.durable-manifest.v1", savePointId, turnId, bundle: request().bundle });
  const manifestDigest = sha256(Buffer.from(canonicalJson));
  const manifestPath = join(remoRoot, "manifests", savePointId, "1.json");
  const receiptJson = JSON.stringify({ status: "durable", turnId, savePointId, revision: 1, candidateRevision: 1, candidateManifestDigest: request().candidateManifestDigest, manifestDigest, manifestPath, createdAt: request().createdAt, promotedAt: "2026-08-16T08:00:00.000Z", expiresAt: "2026-09-15T08:00:00.000Z", pinned: false, health: "complete", fidelity: "editable-eligible", reasonCodes: [] });
  database.exec(`
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
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${new Date(0).toISOString()}');
  `);
  if (version === 2) {
    database.exec(`
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
    `);
  }
  database.prepare("INSERT INTO save_points(turn_id, save_point_id, revision, candidate_revision, candidate_manifest_digest, manifest_digest, manifest_path, canonical_json, receipt_json, created_at, promoted_at, expires_at, pinned_at, materialized, health, fidelity, reasons_json) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'complete', 'editable-eligible', '[]')").run(
    turnId, savePointId, request().candidateManifestDigest, manifestDigest, manifestPath, canonicalJson, receiptJson, request().createdAt, "2026-08-16T08:00:00.000Z", "2026-09-15T08:00:00.000Z",
  );
  database.exec(`PRAGMA user_version=${version}`);
  database.close();
  return { turnId, savePointId, manifestDigest, backupPath: `${catalogPath}.pre-v4-v${version}.sqlite` };
}

describe("local SQLite/CAS repository", () => {
  it("creates schema v4 with WAL, foreign keys, defensive mode, private roots, and one immutable idempotent save", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z") });
    const first = repository.promote(request());
    const repeated = repository.promote(request());

    expect(repository.diagnostics()).toMatchObject({ schemaVersion: 4, journalMode: "wal", foreignKeys: true, defensive: true, permissionsVerified: true });
    expect(repeated).toEqual(first);
    expect(repository.countDurable()).toBe(1);
    expect(first).toMatchObject({ status: "durable", turnId: request().turnId, savePointId: request().savePointId, createdAt: "2026-08-16T07:30:00.000Z", promotedAt: "2026-08-16T08:00:00.000Z", expiresAt: "2026-09-15T08:00:00.000Z", pinned: false, health: "complete" });
    expect(first.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.parse(await readFile(first.manifestPath, "utf8"))).toMatchObject({ manifest: { savePointId: first.savePointId }, receipt: { manifestDigest: first.manifestDigest } });
    repository.close();
  });

  it("keeps other turns unchanged and marks missing or corrupt referenced evidence incomplete/degraded", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z") });
    const first = repository.promote(request("T5", "S5"));
    const other = repository.promote(request("T6", "S6"));
    const missing = repository.promote(request("T7", "S7"));
    const firstDigest = first.manifestDigest;
    await writeFile(repository.blobPath(request().blobs[0]!.expectedDigest), "corrupt");
    await rm(repository.blobPath(request("T7", "S7").blobs[1]!.expectedDigest));
    repository.close();

    const reopened = new LocalSavePointRepository({ projectRoot: root });
    const reconciliation = reopened.reconcileStartup();
    expect(reconciliation.find((item) => item.savePointId === first.savePointId)).toMatchObject({ health: "incomplete", fidelity: "degraded" });
    expect(reopened.getDurable(first.turnId)?.reasonCodes).toContain("blob.digest-mismatch");
    expect(reopened.getDurable(missing.turnId)?.reasonCodes).toContain("blob.missing");
    expect(reopened.promote(request("T5", "S5"))).toMatchObject({ health: "incomplete", reasonCodes: ["blob.digest-mismatch"] });
    expect(reopened.getDurable(other.turnId)).toMatchObject({ manifestDigest: other.manifestDigest, health: "complete" });
    expect(reopened.getDurable(first.turnId)?.manifestDigest).toBe(firstDigest);
    reopened.close();
  });

  it.each([1, 2] as const)("backs up and deterministically migrates a genuine v%i catalog to v4 without changing its durable save", async (version) => {
    const root = await projectRoot();
    const fixture = await createLegacyCatalog(root, version);
    const migrated = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:05:00.000Z") });
    expect(migrated.diagnostics().schemaVersion).toBe(4);
    expect(migrated.getDurable(fixture.turnId)).toMatchObject({ manifestDigest: fixture.manifestDigest, revision: 1 });
    expect(appendReconciliation(migrated)).toMatchObject({ revision: 2, predecessorRevision: 1, predecessorManifestDigest: fixture.manifestDigest });
    expect(migrated.countDurable()).toBe(1);
    migrated.close();

    const backupBytes = await readFile(fixture.backupPath);
    expect(backupBytes.byteLength).toBeGreaterThan(0);
    const backup = new DatabaseSync(fixture.backupPath, { readOnly: true });
    expect((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(version);
    expect((backup.prepare("SELECT COUNT(*) AS count FROM save_points").get() as { count: number }).count).toBe(1);
    backup.close();

    const reopened = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:05:00.000Z") });
    expect(reopened.diagnostics().schemaVersion).toBe(4);
    expect(reopened.countDurable()).toBe(1);
    reopened.close();
    const current = new DatabaseSync(join(root, ".remo", "catalog.sqlite"), { readOnly: true });
    expect((current.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as Array<{ version: number }>).map(({ version: migratedVersion }) => migratedVersion)).toEqual([1, 2, 3, 4]);
    current.close();
    await expect(readFile(fixture.backupPath)).resolves.toEqual(backupBytes);
  });

  it("reconstructs the latest immutable reconciliation revision after restart without changing the T5 manifest or durable count", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z") });
    const durable = repository.promote(request());
    const immutablePromotionBytes = await readFile(durable.manifestPath, "utf8");
    const revision = appendReconciliation(repository);
    const revisionBytes = JSON.parse(await readFile(revision.manifestPath, "utf8")) as { manifest: { predecessor: unknown; bundle: unknown }; receipt: { manifestDigest: string } };
    expect(revision).toMatchObject({ revision: 2, predecessorRevision: 1, predecessorManifestDigest: durable.manifestDigest, traceValidatedAt: "2026-08-16T08:04:00.000Z" });
    expect(revision.manifestDigest).not.toBe(durable.manifestDigest);
    expect(revisionBytes).toMatchObject({ manifest: { predecessor: { revision: 1, manifestDigest: durable.manifestDigest }, bundle: reconciledBundle }, receipt: { manifestDigest: revision.manifestDigest } });
    expect(appendReconciliation(repository)).toEqual(revision);
    repository.close();

    const reopened = new LocalSavePointRepository({ projectRoot: root });
    expect(reopened.getCurrentRevision(durable.savePointId)).toEqual(revision);
    expect(reopened.getDurable(durable.turnId)).toMatchObject({ revision: 1, manifestDigest: durable.manifestDigest });
    expect(reopened.countDurable()).toBe(1);
    await expect(readFile(durable.manifestPath, "utf8")).resolves.toBe(immutablePromotionBytes);
    reopened.close();
  });

  it("fails startup honestly when a committed current reconciliation revision is missing", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root });
    repository.promote(request());
    const revision = appendReconciliation(repository);
    repository.close();
    await rm(revision.manifestPath);
    expect(() => new LocalSavePointRepository({ projectRoot: root })).toThrow(/revision 2 is missing/u);
  });

  it("serializes ten sequential local saves without changing any prior durable identity", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z") });
    const receipts = Array.from({ length: 10 }, (_, index) => repository.promote(request(`T${index}`, `S${index}`)));
    expect(repository.countDurable()).toBe(10);
    expect(new Set(receipts.map((receipt) => receipt.savePointId)).size).toBe(10);
    for (const receipt of receipts) expect(repository.getDurable(receipt.turnId)).toEqual(receipt);
    repository.close();
  });

  it("enumerates only authoritative current durable rows across quarantine, deletion, and restart", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z") });
    const first = repository.promote(request("T1", "S1"));
    const second = repository.promote(request("T2", "S2"));
    const third = repository.promote(request("T3", "S3"));

    repository.quarantineDurable(second.savePointId, "quarantine-enumeration-S2");
    repository.deleteDurable(third.savePointId, "delete-enumeration-S3");
    const current = repository.listCurrentDurable();
    expect(current.map(({ receipt }) => receipt.savePointId)).toEqual([first.savePointId, second.savePointId]);
    expect(current.map(({ lifecycle }) => lifecycle.state)).toEqual(["active", "quarantined"]);
    expect(current[0]).toMatchObject({ revision: { savePointId: first.savePointId, turnId: first.turnId }, bundle: request("T1", "S1").bundle });
    expect(current.some(({ receipt }) => receipt.savePointId === third.savePointId)).toBe(false);
    repository.close();

    const reopened = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z") });
    expect(reopened.listCurrentDurable().map(({ receipt, lifecycle }) => ({ savePointId: receipt.savePointId, state: lifecycle.state }))).toEqual([
      { savePointId: first.savePointId, state: "active" },
      { savePointId: second.savePointId, state: "quarantined" },
    ]);
    reopened.close();
  });

  it("removes orphan staging on startup without inventing a durable record", async () => {
    const root = await projectRoot();
    const orphan = join(root, ".remo", "staging", "orphan-operation");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "unsafe.tmp"), "orphan");
    const repository = new LocalSavePointRepository({ projectRoot: root });
    expect(repository.reconcileStartup()).toEqual([]);
    expect(repository.countDurable()).toBe(0);
    await expect(readFile(join(orphan, "unsafe.tmp"))).rejects.toThrow();
    repository.close();
  });

  it("fails honestly when private project-local storage cannot be created", async () => {
    const root = await projectRoot();
    await writeFile(join(root, ".remo"), "not-a-directory");
    expect(() => new LocalSavePointRepository({ projectRoot: root })).toThrow();
  });

  it.runIf(process.platform !== "win32")("verifies POSIX owner-only modes for the private root, catalog, blobs, staging, and manifest", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root });
    const receipt = repository.promote(request());
    for (const path of [repository.remoRoot, repository.blobsRoot, repository.stagingRoot, dirname(receipt.manifestPath)]) expect((await stat(path)).mode & 0o077).toBe(0);
    for (const path of [repository.catalogPath, repository.blobPath(request().blobs[0]!.expectedDigest), receipt.manifestPath]) expect((await stat(path)).mode & 0o077).toBe(0);
    repository.close();
  });

  it.runIf(process.platform === "win32")("removes permissive inherited ACLs and verifies the current-user-only private boundary", async () => {
    const root = await projectRoot();
    const remo = join(root, ".remo");
    await mkdir(remo);
    execFileSync("C:\\Windows\\System32\\icacls.exe", [remo, "/grant", "*S-1-1-0:(OI)(CI)F"], { windowsHide: true });
    const repository = new LocalSavePointRepository({ projectRoot: root });
    expect(repository.diagnostics()).toMatchObject({ permissionsVerified: true, permissionModel: "windows-acl-current-user-only" });
    repository.promote(request());
    expect(repository.verifyPrivateStorage()).toEqual([]);
    repository.close();
  });

  it.runIf(process.platform === "win32")("verifies ACLs without implicit Security-module autoload from inherited PSModulePath", async () => {
    const root = await projectRoot();
    const hostileModulePath = join(root, "autoload-disabled");
    const shadowSecurityModule = join(hostileModulePath, "Microsoft.PowerShell.Security");
    await mkdir(shadowSecurityModule, { recursive: true });
    await writeFile(join(shadowSecurityModule, "Microsoft.PowerShell.Security.psd1"), `@{
      RootModule = 'missing-security-module.psm1'
      ModuleVersion = '1.0.0'
      GUID = '6a14167c-84f3-4b0f-86b3-f1e9cd977a8c'
      CmdletsToExport = @('Get-Acl')
      FunctionsToExport = @()
      AliasesToExport = @()
    }`);
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const implementation = await readFile(join(packageRoot, "src", "index.ts"), "utf8");
    expect(implementation).toContain("$PSModuleAutoLoadingPreference = 'None'");
    expect(implementation).toContain("Get-Command -Name 'Get-Item' -ErrorAction Stop");
    expect(implementation).toContain("Get-Command -Name 'Get-ChildItem' -ErrorAction Stop");
    expect(implementation).toContain("Get-Command -Name 'Get-Acl' -ErrorAction Stop");
    const tsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawnSync(process.execPath, [tsx, "src/acl-verification-child.ts", root], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, PSModulePath: hostileModulePath },
      windowsHide: true,
      timeout: 30_000,
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
  });

  it.runIf(process.platform === "win32")("rejects a nested junction/reparse escape before writing outside the private root", async () => {
    const root = await projectRoot();
    const outside = await projectRoot();
    await mkdir(join(root, ".remo"));
    await symlink(outside, join(root, ".remo", "blobs"), "junction");
    expect(() => new LocalSavePointRepository({ projectRoot: root })).toThrow(/reparse|symbolic|junction/iu);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("separate-process abrupt crash recovery", () => {
  it.each(["after-blob-rename", "after-transaction-commit"] as const)("recovers after abrupt termination at %s without candidate memory", async (crashPoint) => {
    const root = await projectRoot();
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawnSync(process.execPath, [tsx, "src/abrupt-crash-child.ts", root, crashPoint], { cwd: packageRoot, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(86);
    const reopened = new LocalSavePointRepository({ projectRoot: root });
    expect(await readdir(reopened.stagingRoot)).toEqual([]);
    if (crashPoint === "after-blob-rename") {
      expect(reopened.countDurable()).toBe(0);
      expect(await filesUnder(reopened.blobsRoot)).toEqual([]);
    } else {
      expect(reopened.countDurable()).toBe(1);
      const durable = reopened.getDurable(request().turnId);
      expect(durable).toMatchObject({ status: "durable", health: "complete", savePointId: request().savePointId });
      await expect(readFile(durable!.manifestPath, "utf8")).resolves.toContain(durable!.manifestDigest);
    }
    reopened.close();
  });
});

const reconciliationCrashPoints: readonly ReconciliationCrashPoint[] = [
  "before-revision-transaction-commit",
  "after-revision-transaction-commit",
  "before-revision-materialization",
  "after-revision-materialization",
];

describe.each(reconciliationCrashPoints)("abrupt reconciliation crash point %s", (crashPoint) => {
  it("recovers only committed append-only revisions and keeps one durable save", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z") });
    const durable = repository.promote(request());
    repository.close();
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawnSync(process.execPath, [tsx, "src/reconciliation/abrupt-crash-child.ts", root, crashPoint], { cwd: packageRoot, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(87);

    const reopened = new LocalSavePointRepository({ projectRoot: root });
    const current = reopened.getCurrentRevision(durable.savePointId)!;
    expect(current.revision).toBe(crashPoint === "before-revision-transaction-commit" ? 1 : 2);
    expect(reopened.countDurable()).toBe(1);
    const retried = appendReconciliation(reopened);
    expect(retried).toMatchObject({ revision: 2, predecessorRevision: 1, predecessorManifestDigest: durable.manifestDigest });
    expect(reopened.countDurable()).toBe(1);
    reopened.close();
  });
});

const crashPoints: readonly PromotionCrashPoint[] = [
  "before-staged-fsync",
  "after-staged-fsync",
  "before-blob-rename",
  "after-blob-rename",
  "before-transaction-commit",
  "after-transaction-commit",
  "before-manifest-materialization",
  "after-manifest-materialization",
];

describe.each(crashPoints)("crash point %s", (crashPoint) => {
  it("reconciles to no synthetic success, clean staging, or an honestly recoverable committed identity", async () => {
    const root = await projectRoot();
    const crashing = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T08:00:00.000Z"), crashPoint });
    expect(() => crashing.promote(request())).toThrow(PromotionCrashError);
    crashing.close();

    const reopened = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T09:00:00.000Z") });
    const reconciliation = reopened.reconcileStartup();
    const committed = reopened.getDurable(request().turnId);
    if (crashPoint === "after-transaction-commit" || crashPoint === "before-manifest-materialization") {
      expect(committed).toMatchObject({ health: "complete", reasonCodes: [] });
      expect(reconciliation).toHaveLength(1);
    } else if (crashPoint === "after-manifest-materialization") {
      expect(committed).toMatchObject({ status: "durable", health: "complete" });
    } else {
      expect(committed).toBeUndefined();
    }
    const recovered = reopened.promote(request());
    expect(recovered.status).toBe("durable");
    expect(reopened.countDurable()).toBe(1);
    expect(reopened.getDurable(request().turnId)?.savePointId).toBe(request().savePointId);
    reopened.close();
  });
});
