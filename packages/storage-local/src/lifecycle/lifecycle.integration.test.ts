import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  LifecycleConfirmationRequiredError,
  LifecycleIdempotencyConflictError,
  LocalSavePointRepository,
  type CandidateRegistration,
  type PromotionRequest,
} from "../index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "remo-storage-t7-"));
  roots.push(root);
  return root;
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function storedZipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameSize = zip.readUInt16LE(offset + 26);
    const extraSize = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameSize + extraSize;
    const name = zip.subarray(nameStart, nameStart + nameSize).toString("utf8");
    entries.set(name, zip.subarray(contentStart, contentStart + size));
    offset = contentStart + size;
  }
  return entries;
}

function promotion(turn = "T7A", save = "S7A", sharedScreenshot?: Buffer): PromotionRequest {
  const rrweb = Buffer.from(`masked rrweb ${turn}`);
  const screenshot = sharedScreenshot ?? Buffer.from(`masked screenshot ${turn}`);
  return {
    operationId: `promote-${turn}`,
    turnId: `01J0000000000000000000${turn}`,
    savePointId: `01J0000000000000000000${save}`,
    revision: 1,
    candidateRevision: 1,
    candidateManifestDigest: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    policyRevision: "remo.privacy.v1",
    bundle: {
      schemaVersion: "remo.bundle.v1",
      savePointId: `01J0000000000000000000${save}`,
      correlation: { turnId: `01J0000000000000000000${turn}` },
      evidence: [
        { componentType: "source", authority: "git", externalId: "a".repeat(40) },
        { componentType: "trace", authority: "langfuse", externalId: "b".repeat(32) },
        { componentType: "rrweb", authority: "rrweb" },
        { componentType: "screenshot", authority: "remo" },
      ],
    },
    blobs: [
      { role: "rrweb", bytes: rrweb, expectedDigest: sha256(rrweb) },
      { role: "screenshot", bytes: screenshot, expectedDigest: sha256(screenshot) },
    ],
  };
}

function candidate(turn = "T7C", save = "S7C"): CandidateRegistration {
  const rrweb = Buffer.from(`candidate rrweb ${turn}`);
  const screenshot = Buffer.from(`candidate screenshot ${turn}`);
  return {
    operationId: `candidate-${turn}`,
    turnId: `01J0000000000000000000${turn}`,
    savePointId: `01J0000000000000000000${save}`,
    revision: 1,
    manifestDigest: sha256(`candidate-manifest-${turn}`),
    createdAt: "2026-08-01T00:00:00.000Z",
    policyRevision: "retention-v1",
    manifest: { status: "reviewable", evidence: ["privacy-cleared"] },
    blobs: [
      { role: "rrweb", bytes: rrweb, expectedDigest: sha256(rrweb) },
      { role: "screenshot", bytes: screenshot, expectedDigest: sha256(screenshot) },
    ],
  };
}

describe("T7 retention and lifecycle storage", () => {
  it("preserves every live candidate CAS reference across startup reconciliation", async () => {
    const root = await projectRoot();
    const registration = candidate();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-02T00:00:00.000Z") });
    repository.registerCandidate(registration);
    const blobPaths = registration.blobs.map((blob) => repository.blobPath(blob.expectedDigest));
    repository.close();

    const reopened = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-02T00:00:00.000Z") });
    expect(reopened.getCandidateLifecycle(registration.turnId)).toMatchObject({ state: "active", revision: 1 });
    for (const [index, path] of blobPaths.entries()) await expect(readFile(path)).resolves.toEqual(registration.blobs[index]!.bytes);
    reopened.close();
  });

  it("enforces candidate seven-day and durable thirty-day deadlines logically and through startup/hourly sweeps", async () => {
    const root = await projectRoot();
    let now = new Date("2026-08-01T00:00:00.000Z");
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => now });
    const registered = repository.registerCandidate(candidate());
    expect(registered.expiresAt).toBe("2026-08-08T00:00:00.000Z");
    expect(repository.getCandidateLifecycle(candidate().turnId)?.state).toBe("active");

    const durable = repository.promote(promotion());
    expect(durable.expiresAt).toBe("2026-08-31T00:00:00.000Z");
    now = new Date("2026-08-08T00:00:00.001Z");
    expect(repository.getCandidateLifecycle(candidate().turnId)).toBeUndefined();
    expect(repository.getDurable(promotion().turnId)).toBeDefined();
    now = new Date("2026-08-31T00:00:00.001Z");
    expect(repository.getDurable(promotion().turnId)).toBeUndefined();
    expect(() => repository.quarantineDurable(durable.savePointId, "expired-quarantine-t7")).toThrow(/expired/u);
    repository.close();

    const reopened = new LocalSavePointRepository({ projectRoot: root, now: () => now });
    expect(reopened.sweepExpired()).toMatchObject({ candidates: [], durableSavePoints: [] });
    expect(reopened.countDurable()).toBe(0);
    reopened.close();
  });

  it("pinning preserves the original deadline and unpinning after it requires explicit immediate-expiry confirmation", async () => {
    const root = await projectRoot();
    let now = new Date("2026-08-01T00:00:00.000Z");
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => now });
    const durable = repository.promote(promotion());
    const pinned = repository.pinDurable(durable.savePointId, "pin-t7");
    expect(pinned).toMatchObject({ pinned: true, expiresAt: durable.expiresAt });
    now = new Date("2026-09-01T00:00:00.000Z");
    expect(repository.getDurable(durable.turnId)).toBeDefined();
    expect(() => repository.unpinDurable(durable.savePointId, "unpin-t7", false)).toThrow(LifecycleConfirmationRequiredError);
    expect(repository.getDurable(durable.turnId)).toBeDefined();
    expect(repository.unpinDurable(durable.savePointId, "unpin-t7", true)).toMatchObject({ state: "expired", originalExpiresAt: durable.expiresAt });
    expect(repository.getDurable(durable.turnId)).toBeUndefined();
    repository.close();
  });

  it("binds one idempotency key to exactly one action, subject, and target", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-01T00:00:00.000Z") });
    const first = repository.promote(promotion("T7A", "S7A"));
    const second = repository.promote(promotion("T7B", "S7B"));
    const pinned = repository.pinDurable(first.savePointId, "tuple-bound-intent");
    expect(repository.pinDurable(first.savePointId, "tuple-bound-intent")).toEqual(pinned);
    expect(() => repository.quarantineDurable(first.savePointId, "tuple-bound-intent")).toThrow(LifecycleIdempotencyConflictError);
    expect(() => repository.pinDurable(second.savePointId, "tuple-bound-intent")).toThrow(LifecycleIdempotencyConflictError);
    expect(() => repository.exportDurable(first.savePointId, "tuple-bound-intent")).toThrow(LifecycleIdempotencyConflictError);
    expect(repository.getLifecycle(first.savePointId)).toMatchObject({ pinned: true, state: "active" });
    expect(repository.getLifecycle(second.savePointId)).toMatchObject({ pinned: false, state: "active" });
    repository.close();
  });

  it("quarantines ordinary access and regenerates a new candidate revision without changing durable manifest bytes", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-01T00:00:00.000Z") });
    const durable = repository.promote(promotion());
    const before = await readFile(durable.manifestPath);
    expect(repository.quarantineDurable(durable.savePointId, "quarantine-t7")).toMatchObject({ state: "quarantined" });
    expect(repository.getDurable(durable.turnId)).toBeUndefined();
    const regenerated = repository.redactDurable(durable.savePointId, "redact-t7", { redactedRoles: ["screenshot"] });
    expect(regenerated).toMatchObject({ subject: "candidate", revision: 2, sourceSavePointId: durable.savePointId, state: "active" });
    expect(await readFile(durable.manifestPath)).toEqual(before);
    expect(repository.getCandidateLifecycle(regenerated.turnId)).toMatchObject({ revision: 2, state: "active" });
    const regeneratedAgain = repository.redactDurable(durable.savePointId, "redact-t7-later-intent", { redactedRoles: ["rrweb"] });
    expect(regeneratedAgain).toMatchObject({ subject: "candidate", revision: 3, sourceSavePointId: durable.savePointId, state: "active" });
    expect(await readFile(durable.manifestPath)).toEqual(before);
    repository.close();
  });

  it("writes a deterministic bounded ZIP with matching inventory hashes and explicit exclusions", async () => {
    const root = await projectRoot();
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-01T00:00:00.000Z") });
    const durable = repository.promote(promotion());
    const first = repository.exportDurable(durable.savePointId, "export-t7");
    const repeated = repository.exportDurable(durable.savePointId, "export-t7");
    const firstBytes = await readFile(first.path);
    const laterIntent = repository.exportDurable(durable.savePointId, "export-t7-later-intent");
    expect(repeated).toEqual(first);
    expect(laterIntent.path).not.toBe(first.path);
    expect(laterIntent.fileName).not.toBe(first.fileName);
    await expect(readFile(first.path)).resolves.toEqual(firstBytes);
    expect(sha256(firstBytes)).toBe(first.digest);
    const laterBytes = await readFile(laterIntent.path);
    expect(sha256(laterBytes)).toBe(laterIntent.digest);
    expect(laterBytes.toString("utf8")).not.toContain(root);
    expect([...storedZipEntries(laterBytes).entries()].some(([path, bytes]) => path.startsWith("receipts/lifecycle-") && bytes.toString("utf8").includes("[private-path-removed]"))).toBe(true);
    expect(first.savePointId).toBe(durable.savePointId);
    expect(first.excluded.some((entry) => entry.reason === "external-authority")).toBe(true);
    expect(first.byteSize).toBeLessThanOrEqual(4 * 1024 * 1024);
    const zip = await readFile(first.path);
    expect(sha256(zip)).toBe(first.digest);
    expect(first.inventory.every((entry) => /^sha256:[0-9a-f]{64}$/u.test(entry.digest))).toBe(true);
    expect(first.inventory.map((entry) => entry.path)).toEqual([...first.inventory.map((entry) => entry.path)].sort());
    const entries = storedZipEntries(zip);
    for (const bytes of entries.values()) {
      expect(bytes.toString("utf8")).not.toContain(root);
      expect(bytes.toString("utf8")).not.toMatch(/[A-Za-z]:[\\/][^"\n]*/u);
    }
    expect(entries.get("manifest.json")?.toString("utf8")).toContain("[private-path-removed]");
    expect(entries.get("receipts/promotion.json")?.toString("utf8")).toContain("[private-path-removed]");
    const inventory = JSON.parse(entries.get("inventory.json")!.toString("utf8")) as { included: Array<{ path: string; byteSize: number; digest: string }>; excluded: Array<{ reason: string; authority?: string }> };
    expect(inventory.included).toEqual(first.inventory);
    for (const item of inventory.included) {
      expect(entries.get(item.path)?.byteLength).toBe(item.byteSize);
      expect(sha256(entries.get(item.path)!)).toBe(item.digest);
    }
    expect(inventory.excluded.some((entry) => entry.reason === "external-authority" && entry.authority === "git")).toBe(true);
    expect(inventory.excluded.some((entry) => entry.reason === "external-authority" && entry.authority === "langfuse")).toBe(true);
    repository.close();
  });

  it("deletes only controlled local material, retains shared blobs, reports external authority, and retries idempotently after a crash", async () => {
    const root = await projectRoot();
    const shared = Buffer.from("same privacy-cleared screenshot");
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-01T00:00:00.000Z") });
    const first = repository.promote(promotion("T7A", "S7A", shared));
    const second = repository.promote(promotion("T7B", "S7B", shared));
    const other = repository.promote(promotion("T7D", "S7D"));
    const firstExport = repository.exportDurable(first.savePointId, "export-before-delete-a");
    const secondExport = repository.exportDurable(first.savePointId, "export-before-delete-a-later");
    const crashExport = repository.exportDurable(second.savePointId, "export-before-crash-delete-b");
    const sharedPath = repository.blobPath(sha256(shared));
    const receipt = repository.deleteDurable(first.savePointId, "delete-t7-a");
    expect(receipt.states).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "shared", digest: sha256(shared) }),
      expect.objectContaining({ state: "external", authority: "git" }),
      expect.objectContaining({ state: "external", authority: "langfuse" }),
      expect.objectContaining({ state: "removed", kind: "export", digest: firstExport.digest }),
      expect.objectContaining({ state: "removed", kind: "export", digest: secondExport.digest }),
    ]));
    await expect(stat(firstExport.path)).rejects.toThrow();
    await expect(stat(secondExport.path)).rejects.toThrow();
    expect(await readdir(repository.exportsRoot)).toEqual([crashExport.fileName]);
    await expect(stat(sharedPath)).resolves.toBeDefined();
    expect(repository.getDurable(second.turnId)?.manifestDigest).toBe(second.manifestDigest);
    expect(repository.deleteDurable(first.savePointId, "delete-t7-a")).toEqual(receipt);
    const currentSecond = repository.getCurrentRevision(second.savePointId)!;
    repository.appendReconciliation({
      savePointId: second.savePointId,
      turnId: second.turnId,
      expectedRevision: currentSecond.revision,
      expectedManifestDigest: currentSecond.manifestDigest,
      traceValidatedAt: "2026-08-01T01:00:00.000Z",
      bundle: { schemaVersion: "remo.bundle.v1", savePointId: second.savePointId, correlation: { turnId: second.turnId }, evidence: ["safe reconciled revision before deletion crash"] },
    });
    repository.close();

    const crashing = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-01T00:00:00.000Z"), lifecycleCrashPoint: "after-local-remove-before-catalog-commit" });
    expect(() => crashing.deleteDurable(second.savePointId, "delete-t7-b")).toThrow(/Injected lifecycle crash/u);
    crashing.close();
    const retried = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-01T00:00:00.000Z") });
    expect(retried.deleteDurable(second.savePointId, "delete-t7-b").states).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "missing" }),
      expect.objectContaining({ state: "missing", kind: "export", digest: crashExport.digest }),
    ]));
    expect(await readdir(retried.exportsRoot)).toEqual([]);
    expect(retried.getDurable(other.turnId)?.manifestDigest).toBe(other.manifestDigest);
    expect(retried.countDurable()).toBe(1);
    retried.deleteDurable(other.savePointId, "delete-t7-d");
    expect(retried.countDurable()).toBe(0);
    retried.close();
    const catalog = new DatabaseSync(join(root, ".remo", "catalog.sqlite"), { readOnly: true });
    expect((catalog.prepare("SELECT COUNT(*) AS count FROM exports").get() as { count: number }).count).toBe(0);
    expect((catalog.prepare("SELECT COUNT(*) AS count FROM lifecycle_receipts WHERE action = 'export'").get() as { count: number }).count).toBe(0);
    expect((catalog.prepare("SELECT COUNT(*) AS count FROM save_points").get() as { count: number }).count).toBe(0);
    catalog.close();
  });
});
