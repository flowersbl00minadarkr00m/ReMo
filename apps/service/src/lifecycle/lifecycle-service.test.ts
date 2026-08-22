import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleIdempotencyConflictError, LocalSavePointRepository, type PromotionRequest } from "@remo/storage-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLifecycleService, startLifecycleSweep } from "./lifecycle-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function promotion(turn: string, save: string): PromotionRequest {
  const bytes = Buffer.from(`safe ${turn}`);
  return {
    operationId: `promote-${turn}`,
    turnId: `01J0000000000000000000${turn}`,
    savePointId: `01J0000000000000000000${save}`,
    revision: 1,
    candidateRevision: 1,
    candidateManifestDigest: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    policyRevision: "remo.privacy.v1",
    bundle: { schemaVersion: "remo.bundle.v1", evidence: ["safe"] },
    blobs: [{ role: "rrweb", bytes, expectedDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }],
  };
}

describe("lifecycle sweep scheduler", () => {
  it("runs at startup and exactly hourly, and closes its handle", () => {
    const sweep = vi.fn().mockReturnValue({ sweptAt: "2026-08-16T00:00:00.000Z", candidates: [], durableSavePoints: [] });
    let callback: (() => void) | undefined;
    const handle = { fake: true } as unknown as ReturnType<typeof setInterval>;
    const schedule = vi.fn((next: () => void, milliseconds: number) => { callback = next; expect(milliseconds).toBe(60 * 60 * 1000); return handle; });
    const cancel = vi.fn();
    const scheduler = startLifecycleSweep({ sweep, setInterval: schedule, clearInterval: cancel });
    expect(scheduler.startup).toMatchObject({ candidates: [], durableSavePoints: [] });
    expect(sweep).toHaveBeenCalledTimes(1);
    callback?.();
    expect(sweep).toHaveBeenCalledTimes(2);
    scheduler.close();
    scheduler.close();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(handle);
  });
});

describe("lifecycle service idempotency binding", () => {
  it("preserves repository action and target bindings across the service seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-service-t7-idempotency-"));
    roots.push(root);
    const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-01T01:00:00.000Z") });
    const first = repository.promote(promotion("T7A", "S7A"));
    const second = repository.promote(promotion("T7B", "S7B"));
    const service = createLifecycleService(repository);
    const pinned = service.pin(first.savePointId, "service-tuple-intent");
    expect(service.pin(first.savePointId, "service-tuple-intent")).toEqual(pinned);
    expect(() => service.quarantine(first.savePointId, "service-tuple-intent")).toThrow(LifecycleIdempotencyConflictError);
    expect(() => service.pin(second.savePointId, "service-tuple-intent")).toThrow(LifecycleIdempotencyConflictError);
    repository.close();
  });
});
