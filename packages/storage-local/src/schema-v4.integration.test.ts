import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSerialize } from "@remo/domain";
import { LocalSavePointRepository, MAX_EVIDENCE_MEDIA_BYTES, STORAGE_SCHEMA_VERSION, type PromotionRequest } from "./index.js";

const roots: string[] = [];
const stamp = "2026-08-16T08:00:00.000Z";
const digest = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const ids = (turn: number) => ({ turnId: `01J00000000000000000000T${String(turn).padStart(2, "0")}`, savePointId: `01J00000000000000000000S${String(turn).padStart(2, "0")}` });
const root = (): string => { const value = mkdtempSync(join(tmpdir(), "remo-schema-v4-")); roots.push(value); return value; };

function promotion(turn: number, extraFixtureId?: string): PromotionRequest & { readonly screenshot: Buffer; readonly rrweb: Buffer } {
  const identity = ids(turn);
  const screenshot = Buffer.from(`png-turn-${turn}`);
  const rrweb = Buffer.from(JSON.stringify([{ type: 4, timestamp: turn }]));
  const fixtureId = `vs001-sequence:${turn}:scenario-${turn}`;
  const correlation = { projectId: "remo", turnId: identity.turnId, captureWindowId: `window-${turn}`, boundaryRevision: "capture-v2" };
  const evidence = [
    { componentId: `${identity.turnId}:source`, componentType: "source", authority: "git", correlation, capturedAt: stamp, digest: digest(`source-${turn}`), availability: "available", provenance: "observed", policyRevision: "policy-v1", claims: { fixtureId } },
    { componentId: `${identity.turnId}:screenshot`, componentType: "screenshot", authority: "remo", correlation, capturedAt: stamp, digest: digest(screenshot), availability: "available", provenance: "observed", policyRevision: "policy-v1", claims: { fixtureId } },
    { componentId: `${identity.turnId}:rrweb`, componentType: "rrweb", authority: "rrweb", correlation, capturedAt: stamp, digest: digest(rrweb), availability: "available", provenance: "observed", policyRevision: "policy-v1", claims: { fixtureId } },
    { componentId: `${identity.turnId}:decision`, componentType: "decision", authority: "remo", correlation, capturedAt: stamp, digest: digest(`decision-${turn}`), availability: "available", provenance: "user-supplied", policyRevision: "policy-v1", claims: { fixtureId } },
    ...(extraFixtureId === undefined ? [] : [{ componentId: `${identity.turnId}:ambiguous`, componentType: "decision", authority: "fixture", correlation, capturedAt: stamp, digest: digest("ambiguous"), availability: "available", provenance: "user-supplied", policyRevision: "policy-v1", claims: { fixtureId: extraFixtureId } }]),
  ];
  const bundle = { schemaVersion: "remo.bundle.v1", savePointId: identity.savePointId, correlation, evidence };
  return { operationId: `promote-${turn}`, ...identity, revision: 1, candidateRevision: 1, candidateManifestDigest: digest(`candidate-${turn}`), createdAt: stamp, policyRevision: "policy-v1", bundle, blobs: [{ role: "screenshot", bytes: screenshot, expectedDigest: digest(screenshot) }, { role: "rrweb", bytes: rrweb, expectedDigest: digest(rrweb) }], screenshot, rrweb };
}

function stripBytes(request: ReturnType<typeof promotion>): PromotionRequest {
  return request;
}

function downgradeToV3(projectRoot: string): string {
  const catalog = join(projectRoot, ".remo", "catalog.sqlite");
  const database = new DatabaseSync(catalog);
  database.exec("DROP TABLE history_entries; DROP TABLE lineages; DROP TABLE decision_revisions; DROP TABLE branch_operations; DELETE FROM schema_migrations WHERE version = 4; PRAGMA user_version=3;");
  database.close();
  return catalog;
}

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("schema v4 history and migration", () => {
  it("creates exact v4 tables/indexes and preserves ten ordered anchors with a two-source turn-6 tombstone across restart", () => {
    const projectRoot = root();
    let repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    for (let turn = 1; turn <= 10; turn += 1) repository.promote(stripBytes(promotion(turn)));
    expect(repository.diagnostics().schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    const before = repository.listHistory();
    expect(before.anchors.map(({ sequenceNo }) => sequenceNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    repository.deleteDurable(ids(6).savePointId, "delete-turn-06");
    const after = repository.listHistory();
    expect(after.anchors).toHaveLength(10);
    expect(after.anchors[5]).toEqual({ savePointId: ids(6).savePointId, turnId: ids(6).turnId, sequenceNo: 6, lineageId: "lineage:original", state: "tombstone", lifecycleReceiptId: "delete-turn-06", provenance: "fixture-contract", integrity: "deleted", fidelity: "unavailable" });
    expect(repository.readEvidenceMedia({ savePointId: ids(6).savePointId, componentId: `${ids(6).turnId}:screenshot`, role: "screenshot", expectedRevision: 1, expectedManifestDigest: digest("missing"), expectedDigest: digest("missing") })).toEqual({ status: "unavailable", reasonCode: "media.lifecycle-unavailable" });
    const stable = canonicalSerialize(after);
    repository.close();
    downgradeToV3(projectRoot);
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    expect(canonicalSerialize(repository.listHistory())).toBe(stable);
    repository.close();
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    expect(canonicalSerialize(repository.listHistory())).toBe(stable);
    repository.close();

    const database = new DatabaseSync(join(projectRoot, ".remo", "catalog.sqlite"), { readOnly: true });
    expect((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
    expect((database.prepare("SELECT COUNT(*) AS count FROM save_points").get() as { count: number }).count).toBe(9);
    expect((database.prepare("SELECT COUNT(*) AS count FROM history_entries").get() as { count: number }).count).toBe(10);
    expect((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('history_entries','lineages','decision_revisions','branch_operations') ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(["branch_operations", "decision_revisions", "history_entries", "lineages"]);
    expect((database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_idx' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expect.arrayContaining(["branch_operations_state_idx", "decision_revisions_predecessor_idx", "history_entries_order_idx", "history_entries_state_idx"]));
    database.close();
  });

  it("backs up a genuine v3 catalog with truthful naming, migrates idempotently, and restores before branching", () => {
    const projectRoot = root();
    let repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    repository.promote(stripBytes(promotion(1)));
    repository.close();
    const catalog = downgradeToV3(projectRoot);
    const backup = `${catalog}.pre-v4-v3.sqlite`;
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    const firstProjection = canonicalSerialize(repository.listHistory());
    expect(repository.listHistory().anchors).toHaveLength(1);
    repository.close();
    expect(existsSync(backup)).toBe(true);
    const backupBytes = readFileSync(backup);
    const backupDatabase = new DatabaseSync(backup, { readOnly: true });
    expect((backupDatabase.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    expect(backupDatabase.prepare("SELECT name FROM sqlite_master WHERE name = 'branch_operations'").get()).toBeUndefined();
    backupDatabase.close();
    copyFileSync(backup, catalog);
    rmSync(`${catalog}-wal`, { force: true }); rmSync(`${catalog}-shm`, { force: true });
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    expect(canonicalSerialize(repository.listHistory())).toBe(firstProjection);
    expect(repository.listPendingBranchOperations()).toEqual([]);
    repository.close();
    expect(readFileSync(backup)).toEqual(backupBytes);

  });

  it("omits unauthoritative nomination prose from fresh and migrated active fixture anchors", () => {
    const projectRoot = root();
    let repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    repository.promote(stripBytes(promotion(1)));
    expect(repository.listHistory().anchors[0]).not.toHaveProperty("nominationReason");
    repository.close();

    downgradeToV3(projectRoot);
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    expect(repository.listHistory().anchors[0]).not.toHaveProperty("nominationReason");
    repository.close();
  });

  it("refuses an unknown future schema version before migration", () => {
    const projectRoot = root();
    const repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) }); repository.close();
    const catalog = join(projectRoot, ".remo", "catalog.sqlite");
    const future = new DatabaseSync(catalog); future.exec("PRAGMA user_version=5"); future.close();
    expect(() => new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) })).toThrow(/Unsupported storage schema version 5/u);
  });

  it("refuses ambiguous fixture sequence authority before durable promotion", () => {
    const repository = new LocalSavePointRepository({ projectRoot: root(), now: () => new Date(stamp) });
    expect(() => repository.promote(stripBytes(promotion(1, "vs001-sequence:2:other")))).toThrow(/ambiguous/u);
    expect(repository.countDurable()).toBe(0);
    expect(repository.listHistory().anchors).toEqual([]);
    repository.close();
  });
});

describe("lifecycle-safe evidence media", () => {
  it("returns digest-bound bytes without paths and fails closed for every catalog, component, lifecycle, size, link, and stale mode without logging bytes", () => {
    const projectRoot = root();
    const repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    const request = promotion(1); const receipt = repository.promote(stripBytes(request));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const read = (overrides: Record<string, unknown> = {}) => repository.readEvidenceMedia({ savePointId: request.savePointId, componentId: `${request.turnId}:screenshot`, role: "screenshot", expectedRevision: 1, expectedManifestDigest: receipt.manifestDigest, expectedDigest: digest(request.screenshot), ...overrides } as never);
    const available = read();
    expect(available).toMatchObject({ status: "available", savePointId: request.savePointId, componentId: `${request.turnId}:screenshot`, role: "screenshot", digest: digest(request.screenshot), byteSize: request.screenshot.byteLength, contentType: "image/png" });
    expect(JSON.stringify({ ...available, bytes: undefined })).not.toMatch(/relative_path|\.remo|manifestPath|C:\\/iu);
    expect(read({ role: "source" })).toEqual({ status: "unavailable", reasonCode: "media.invalid-role" });
    expect(read({ componentId: "missing" })).toEqual({ status: "unavailable", reasonCode: "media.component-missing" });
    expect(read({ componentId: `${request.turnId}:rrweb` })).toEqual({ status: "unavailable", reasonCode: "media.component-mismatch" });
    expect(read({ expectedRevision: 2 })).toEqual({ status: "unavailable", reasonCode: "media.stale-binding" });

    const catalog = new DatabaseSync(repository.catalogPath);
    const catalogRow = catalog.prepare("SELECT digest, byte_size, relative_path FROM save_point_blobs WHERE save_point_id = ? AND role = 'screenshot'").get(request.savePointId) as { digest: string; byte_size: number; relative_path: string };
    catalog.prepare("DELETE FROM save_point_blobs WHERE save_point_id = ? AND role = 'screenshot'").run(request.savePointId);
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.catalog-missing" });
    catalog.prepare("INSERT INTO save_point_blobs(save_point_id, role, digest, byte_size, relative_path) VALUES (?, 'screenshot', ?, ?, ?)").run(request.savePointId, catalogRow.digest, catalogRow.byte_size, catalogRow.relative_path);
    catalog.prepare("UPDATE save_point_blobs SET digest = ? WHERE save_point_id = ? AND role = 'screenshot'").run(digest("other"), request.savePointId);
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.catalog-mismatch" });
    catalog.prepare("UPDATE save_point_blobs SET digest = ?, relative_path = '../escape' WHERE save_point_id = ? AND role = 'screenshot'").run(catalogRow.digest, request.savePointId);
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.path-invalid" });
    catalog.prepare("UPDATE save_point_blobs SET relative_path = ? WHERE save_point_id = ? AND role = 'screenshot'").run(catalogRow.relative_path, request.savePointId);
    catalog.prepare("UPDATE save_point_blobs SET byte_size = ? WHERE save_point_id = ? AND role = 'screenshot'").run(MAX_EVIDENCE_MEDIA_BYTES + 1, request.savePointId);
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.oversized" });
    catalog.prepare("UPDATE save_point_blobs SET byte_size = ? WHERE save_point_id = ? AND role = 'screenshot'").run(request.screenshot.byteLength + 1, request.savePointId);
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.size-mismatch" });
    catalog.prepare("UPDATE save_point_blobs SET byte_size = ? WHERE save_point_id = ? AND role = 'screenshot'").run(request.screenshot.byteLength, request.savePointId);
    const path = repository.blobPath(digest(request.screenshot));
    renameSync(path, `${path}.missing`);
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.missing" });
    renameSync(`${path}.missing`, path);
    writeFileSync(path, Buffer.alloc(MAX_EVIDENCE_MEDIA_BYTES + 1));
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.oversized" });
    writeFileSync(path, Buffer.alloc(request.screenshot.byteLength, 120));
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.digest-mismatch" });
    writeFileSync(path, request.screenshot);
    const target = join(dirname(path), "linked-target"); writeFileSync(target, request.screenshot);
    renameSync(path, `${path}.real`);
    try {
      symlinkSync(target, path, "file");
      expect(read()).toEqual({ status: "unavailable", reasonCode: "media.link-rejected" });
      rmSync(path, { force: true }); renameSync(`${path}.real`, path);
    } catch {
      renameSync(`${path}.real`, path);
    }
    repository.quarantineDurable(request.savePointId, "quarantine-media");
    expect(read()).toEqual({ status: "unavailable", reasonCode: "media.quarantined" });
    expect(errorSpy).not.toHaveBeenCalled(); expect(logSpy).not.toHaveBeenCalled();
    catalog.close(); repository.close();
  });
});

describe("decision and branch foundation durability", () => {

  it.each(["before-revision-manifest-write", "before-revision-manifest-rename"] as const)("materializes a matching pending decision manifest on same-process retry after %s and on restart", (crashPoint) => {
    const appendWithInjectedFailure = (projectRoot: string, restartOnly: boolean): void => {
      let injected = false;
      let repository = new LocalSavePointRepository({
        projectRoot,
        now: () => new Date(stamp),
        crashPoint,
        crashAction: (() => { if (!injected) { injected = true; throw new Error(`injected ${crashPoint}`); } }) as never,
      });
      const save = promotion(restartOnly ? 5 : 4);
      repository.promote(stripBytes(save));
      const record = { decisionId: `decision-${crashPoint}-${restartOnly ? "restart" : "retry"}`, value: "bounded evidence" };
      const expectedDigest = digest(canonicalSerialize(record));
      const request = { savePointId: save.savePointId, turnId: save.turnId, revision: 1, canonicalRecord: record, expectedDigest, recordedAt: stamp };
      expect(() => repository.appendDecisionRevision(request)).toThrow(`injected ${crashPoint}`);
      expect(repository.readDecisionRevisions(save.savePointId)).toHaveLength(1);
      if (restartOnly) {
        repository.close();
        repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
      } else {
        expect(repository.appendDecisionRevision(request)).toMatchObject({ revision: 1, digest: expectedDigest });
      }
      const revision = repository.getCurrentRevision(save.savePointId)!;
      expect(existsSync(revision.manifestPath)).toBe(true);
      expect(readFileSync(revision.manifestPath, "utf8")).toContain(expectedDigest);
      repository.close();
    };
    appendWithInjectedFailure(root(), false);
    appendWithInjectedFailure(root(), true);
  });
  it("exports decision revisions and removes their payload on durable deletion and candidate expiry", () => {
    const projectRoot = root();
    let now = new Date(stamp);
    const repository = new LocalSavePointRepository({ projectRoot, now: () => now });
    const durableRequest = promotion(2); repository.promote(stripBytes(durableRequest));
    const durableRecord = { decisionId: "decision-export", value: "bounded evidence" };
    const durableDigest = digest(canonicalSerialize(durableRecord));
    repository.appendDecisionRevision({ savePointId: durableRequest.savePointId, turnId: durableRequest.turnId, revision: 1, canonicalRecord: durableRecord, expectedDigest: durableDigest, recordedAt: stamp });
    expect(repository.exportDurable(durableRequest.savePointId, "export-decision-revision").inventory.map(({ path }) => path)).toContain("decisions/revision-001.json");
    repository.deleteDurable(durableRequest.savePointId, "delete-decision-revision");
    expect(repository.readDecisionRevisions(durableRequest.savePointId)).toEqual([]);
    expect(repository.listHistory().anchors.find(({ savePointId }) => savePointId === durableRequest.savePointId)).toMatchObject({ state: "tombstone", integrity: "deleted" });

    const candidateRequest = promotion(3);
    repository.registerCandidate({ operationId: "candidate-decision-expiry", turnId: candidateRequest.turnId, savePointId: candidateRequest.savePointId, revision: 1, manifestDigest: candidateRequest.candidateManifestDigest, createdAt: stamp, policyRevision: candidateRequest.policyRevision, manifest: candidateRequest.bundle, blobs: candidateRequest.blobs });
    const candidateRecord = { decisionId: "decision-expiry", value: "candidate evidence" };
    const candidateDigest = digest(canonicalSerialize(candidateRecord));
    repository.appendDecisionRevision({ savePointId: candidateRequest.savePointId, turnId: candidateRequest.turnId, revision: 1, canonicalRecord: candidateRecord, expectedDigest: candidateDigest, recordedAt: stamp });
    now = new Date("2026-08-24T08:00:00.000Z");
    expect(repository.sweepExpired().candidates).toContain(candidateRequest.turnId);
    expect(repository.readDecisionRevisions(candidateRequest.savePointId)).toEqual([]);
    repository.close();
  });

  it("appends predecessor-bound decisions and branch journal/receipt state atomically across restart", () => {
    const projectRoot = root();
    let repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    const save = promotion(1); repository.promote(stripBytes(save));
    const firstRecord = { decisionId: "decision-1", value: "first" };
    const firstDigest = digest(canonicalSerialize(firstRecord));
    expect(repository.appendDecisionRevision({ savePointId: save.savePointId, turnId: save.turnId, revision: 1, canonicalRecord: firstRecord, expectedDigest: firstDigest, recordedAt: stamp })).toMatchObject({ revision: 1, digest: firstDigest });
    const secondRecord = { ...firstRecord, value: "corrected" }; const secondDigest = digest(canonicalSerialize(secondRecord));
    expect(repository.appendDecisionRevision({ savePointId: save.savePointId, turnId: save.turnId, revision: 2, predecessorDigest: firstDigest, canonicalRecord: secondRecord, expectedDigest: secondDigest, recordedAt: "2026-08-16T08:01:00.000Z" })).toMatchObject({ revision: 2, predecessorDigest: firstDigest, digest: secondDigest });
    expect(repository.getCurrentRevision(save.savePointId)).toMatchObject({ revision: 3, predecessorRevision: 2 });
    expect(repository.readDecisionRevisions(save.savePointId)).toEqual([
      expect.objectContaining({ revision: 1, digest: firstDigest, canonicalRecord: firstRecord }),
      expect.objectContaining({ revision: 2, predecessorDigest: firstDigest, digest: secondDigest, canonicalRecord: secondRecord }),
    ]);
    const intent = { operationId: "operation-1", intentKey: "intent-1", savePointId: save.savePointId, preflightDigest: digest("preflight"), originalFutureDigest: digest("future"), branchRef: "refs/heads/remo/operation-1", worktreeRelativePath: ".remo/worktrees/operation-1", createdAt: stamp };
    expect(repository.beginBranchOperation(intent)).toMatchObject({ ...intent, state: "pending" });
    const intentPath = join(projectRoot, ".remo", "staging", "branch-operation-1.json");
    expect(existsSync(intentPath)).toBe(true);
    repository.close();
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    expect(repository.readLatestDecisionRevision(save.savePointId)).toMatchObject({ revision: 2, predecessorDigest: firstDigest, digest: secondDigest, canonicalRecord: secondRecord });
    expect(repository.listPendingBranchOperations()).toEqual([expect.objectContaining({ operationId: "operation-1", state: "pending" })]);
    expect(existsSync(intentPath)).toBe(true);
    expect(() => repository.appendBranchOperationReceipt({ operationId: "operation-1", state: "succeeded", canonicalResult: { branchRef: intent.branchRef }, updatedAt: "2026-08-16T08:02:00.000Z" })).toThrow(/requires matching active-alternate lineage evidence/u);
    expect(repository.listPendingBranchOperations()).toHaveLength(1);
    const completed = repository.appendBranchOperationReceipt({ operationId: "operation-1", state: "recovery-required", canonicalResult: { reasonCode: "branch.interrupted" }, updatedAt: "2026-08-16T08:02:00.000Z" });
    expect(completed).toMatchObject({ state: "recovery-required", canonicalResult: { reasonCode: "branch.interrupted" } });
    expect(existsSync(intentPath)).toBe(false);
    repository.close();
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    expect(repository.listPendingBranchOperations()).toEqual([]);
    repository.close();
  });

  it("recovers a byte-matching finalized branch intent after durable completion and cleans only that intent", () => {
    const projectRoot = root();
    let repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    const save = promotion(1); repository.promote(stripBytes(save));
    const intent = { operationId: "operation-complete", intentKey: "intent-complete", savePointId: save.savePointId, preflightDigest: digest("preflight-complete"), originalFutureDigest: digest("future-complete"), branchRef: "refs/heads/remo/operation-complete", worktreeRelativePath: ".remo/worktrees/operation-complete", createdAt: stamp };
    repository.beginBranchOperation(intent);
    const completed = repository.appendBranchOperationReceipt({
      operationId: intent.operationId,
      state: "succeeded",
      canonicalResult: { branchRef: intent.branchRef },
      updatedAt: "2026-08-16T08:02:00.000Z",
      lineage: { lineageId: "lineage:alternate-complete", parentLineageId: "lineage:original", rootSavePointId: save.savePointId, branchOperationId: intent.operationId, gitRef: intent.branchRef, worktreeRelativePath: intent.worktreeRelativePath, state: "active-alternate" },
    });
    const staging = join(projectRoot, ".remo", "staging");
    const intentPath = join(staging, `branch-${intent.operationId}.json`);
    const receiptPath = join(projectRoot, ".remo", "receipts", `branch-${intent.operationId}.json`);
    const orphan = { schemaVersion: "remo.branch-intent.v1", operationId: "orphan-preserved", intentKey: "orphan-preserved", savePointId: ids(2).savePointId, preflightDigest: digest("orphan-preflight"), originalFutureDigest: digest("orphan-future"), branchRef: "refs/heads/remo/orphan-preserved", worktreeRelativePath: ".remo/worktrees/orphan-preserved", createdAt: stamp };
    const orphanPath = join(staging, "branch-orphan-preserved.json");

    writeFileSync(intentPath, canonicalSerialize({ schemaVersion: "remo.branch-intent.v1", ...intent }));
    writeFileSync(orphanPath, canonicalSerialize(orphan));
    rmSync(receiptPath);
    repository.close();

    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    expect(readFileSync(receiptPath, "utf8")).toBe(canonicalSerialize(completed));
    expect(existsSync(intentPath)).toBe(false);
    expect(existsSync(orphanPath)).toBe(true);
    expect(repository.listPendingBranchOperations()).toEqual([]);
    repository.close();

    writeFileSync(intentPath, canonicalSerialize({ schemaVersion: "remo.branch-intent.v1", ...intent }));
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    expect(readFileSync(receiptPath, "utf8")).toBe(canonicalSerialize(completed));
    expect(existsSync(intentPath)).toBe(false);
    expect(existsSync(orphanPath)).toBe(true);
    repository.close();
  });

  it("enforces one active or unresolved alternate before writing a second durable intent", () => {
    const projectRoot = root();
    const repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    const first = { operationId: "operation-only", intentKey: "intent-only", savePointId: ids(1).savePointId, preflightDigest: digest("preflight-only"), originalFutureDigest: digest("future-only"), branchRef: "refs/heads/remo/operation-only", worktreeRelativePath: ".remo/worktrees/operation-only", createdAt: stamp };
    const second = { operationId: "operation-second", intentKey: "intent-second", savePointId: ids(2).savePointId, preflightDigest: digest("preflight-second"), originalFutureDigest: digest("future-second"), branchRef: "refs/heads/remo/operation-second", worktreeRelativePath: ".remo/worktrees/operation-second", createdAt: "2026-08-16T08:01:00.000Z" };

    repository.beginBranchOperation(first);
    expect(() => repository.beginBranchOperation(second)).toThrow(/exactly one alternate lineage/u);
    expect(repository.listBranchOperations()).toHaveLength(1);
    expect(existsSync(join(projectRoot, ".remo", "staging", "branch-operation-second.json"))).toBe(false);

    repository.appendBranchOperationReceipt({ operationId: first.operationId, state: "recovery-required", canonicalResult: { reasonCode: "branch.fixture-recovery" }, updatedAt: "2026-08-16T08:02:00.000Z" });
    expect(() => repository.beginBranchOperation(second)).toThrow(/exactly one alternate lineage/u);
    expect(existsSync(join(projectRoot, ".remo", "staging", "branch-operation-second.json"))).toBe(false);
    repository.close();
  });

  it("fails closed when finalized branch cleanup finds mismatched receipt bytes or intent evidence", () => {
    for (const mismatch of ["receipt", "intent"] as const) {
      const projectRoot = root();
      const repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
      const save = promotion(1); repository.promote(stripBytes(save));
      const intent = { operationId: `operation-${mismatch}`, intentKey: `intent-${mismatch}`, savePointId: save.savePointId, preflightDigest: digest(`preflight-${mismatch}`), originalFutureDigest: digest(`future-${mismatch}`), branchRef: `refs/heads/remo/operation-${mismatch}`, worktreeRelativePath: `.remo/worktrees/operation-${mismatch}`, createdAt: stamp };
      repository.beginBranchOperation(intent);
      repository.appendBranchOperationReceipt({ operationId: intent.operationId, state: "recovery-required", canonicalResult: { reasonCode: "branch.interrupted" }, updatedAt: "2026-08-16T08:02:00.000Z" });
      const intentPath = join(projectRoot, ".remo", "staging", `branch-${intent.operationId}.json`);
      const receiptPath = join(projectRoot, ".remo", "receipts", `branch-${intent.operationId}.json`);
      writeFileSync(intentPath, canonicalSerialize({ schemaVersion: "remo.branch-intent.v1", ...intent, ...(mismatch === "intent" ? { originalFutureDigest: digest("mismatched-future") } : {}) }));
      if (mismatch === "receipt") writeFileSync(receiptPath, canonicalSerialize({ tampered: true }));
      repository.close();

      expect(() => new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) })).toThrow(mismatch === "receipt" ? /receipt conflicts/u : /intent conflicts/u);
      expect(existsSync(intentPath)).toBe(true);
    }
  });

  it("preserves a valid orphan branch intent, rejects malformed branch intent, and leaves non-branch staging sweep behavior closed", () => {
    const projectRoot = root();
    let repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) });
    repository.close();
    const staging = join(projectRoot, ".remo", "staging");
    const valid = { schemaVersion: "remo.branch-intent.v1", operationId: "orphan-1", intentKey: "orphan-intent", savePointId: ids(1).savePointId, preflightDigest: digest("preflight"), originalFutureDigest: digest("future"), branchRef: "refs/heads/remo/orphan-1", worktreeRelativePath: ".remo/worktrees/orphan-1", createdAt: stamp };
    const validPath = join(staging, "branch-orphan-1.json"); writeFileSync(validPath, canonicalSerialize(valid));
    const disposable = join(staging, "unrelated.tmp"); writeFileSync(disposable, "safe-to-sweep");
    repository = new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) }); repository.close();
    expect(existsSync(validPath)).toBe(true); expect(existsSync(disposable)).toBe(false);
    writeFileSync(join(staging, "branch-bad.json"), '{"schemaVersion":"remo.branch-intent.v1","operationId":"bad"}');
    expect(() => new LocalSavePointRepository({ projectRoot, now: () => new Date(stamp) })).toThrow(/Malformed branch intent/u);
    expect(existsSync(validPath)).toBe(true);
  });
});
