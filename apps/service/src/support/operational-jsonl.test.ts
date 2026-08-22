import { link, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSavePointRepository } from "@remo/storage-local";
import { createOperationalDiagnosticsReporter, operationalDiagnosticsPath } from "./operational-jsonl.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function event(retryCount = 0) {
  return {
    operationId: "promotion.commit",
    operationInstanceId: "promotion-turn-9",
    turnIds: ["01J000000000000000000000T9"],
    savePointIds: ["01J000000000000000000000S9"],
    reasonCodes: retryCount === 0 ? [] : ["promotion.retry"],
    durationMs: 12,
    perTurnLatencyMs: 12,
    retryCount,
    sizes: { eventBytes: 120, blobBytes: 4096 },
    digests: {},
    policyVersions: { privacy: "privacy-v4", integrity: "integrity-v3" },
    outcomes: { privacy: "passed", integrity: "complete" },
    result: "pass",
  } as const;
}

describe("private bounded operational diagnostics", () => {
  it("writes payload-neutral JSONL, uses stable event IDs, rotates to two bounded generations, and applies private modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-operational-jsonl-"));
    roots.push(root);
    const repository = new LocalSavePointRepository({ projectRoot: root });
    const reporter = createOperationalDiagnosticsReporter({ projectRoot: root, maxBytes: 700, now: () => new Date("2026-08-16T20:00:00.000Z") });
    const first = reporter.report(event());
    expect(reporter.report(event()).eventId).toBe(first.eventId);
    for (let retry = 1; retry <= 5; retry += 1) expect(reporter.report(event(retry)).written).toBe(true);
    const path = operationalDiagnosticsPath(root);
    const files = await readdir(resolve(path, ".."));
    expect(files.sort()).toEqual(["vs001-operational.jsonl", "vs001-operational.previous.jsonl"]);
    for (const file of files) expect((await stat(resolve(path, "..", file))).size).toBeLessThanOrEqual(700);
    expect(repository.verifyPrivateStorage()).toEqual([]);
    if (process.platform !== "win32") {
      expect((await stat(resolve(path, ".."))).mode & 0o077).toBe(0);
      expect((await stat(path)).mode & 0o077).toBe(0);
    }
    const bytes = await Promise.all(files.map((file) => readFile(resolve(path, "..", file), "utf8")));
    expect(bytes.join("\n")).not.toContain("REMO_SECRET_CANARY_V1");
    for (const line of bytes.flatMap((value) => value.trim().split("\n"))) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["digests", "durationMs", "eventId", "occurredAt", "operationId", "operationInstanceId", "outcomes", "perTurnLatencyMs", "policyVersions", "reasonCodes", "result", "retryCount", "savePointIds", "sizes", "turnIds"].sort());
    }
    repository.close();
  });

  it("contains diagnostics failures and never throws into the product operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-operational-failure-"));
    roots.push(root);
    const reporter = createOperationalDiagnosticsReporter({ projectRoot: root, appendLine: () => { throw new Error("disk unavailable"); } });
    expect(() => reporter.report(event())).not.toThrow();
    expect(reporter.report(event())).toEqual(expect.objectContaining({ written: false, failureReason: "diagnostics.write-failed" }));
  });

  it("replaces secret-shaped operation keys with stable domain-separated opaque identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-operational-identity-"));
    roots.push(root);
    const marker = "sk_live_REMO_SECRET_MARKER_20260816";
    const reporter = createOperationalDiagnosticsReporter({ projectRoot: root });

    expect(reporter.report({ ...event(), operationInstanceId: marker }).written).toBe(true);
    expect(reporter.report({ ...event(), operationInstanceId: marker }).written).toBe(true);
    expect(reporter.report({ ...event(), operationId: "lifecycle.delete", operationInstanceId: marker }).written).toBe(true);
    expect(reporter.report({ ...event(), savePointIds: ["01J000000000000000000000S8"], operationInstanceId: marker }).written).toBe(true);

    const raw = await readFile(operationalDiagnosticsPath(root), "utf8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line) as { operationInstanceId: string });
    expect(raw).not.toContain(marker);
    expect(records[0]!.operationInstanceId).toMatch(/^opi\.v1\.[0-9a-f]{64}$/u);
    expect(records[1]!.operationInstanceId).toBe(records[0]!.operationInstanceId);
    expect(records[2]!.operationInstanceId).not.toBe(records[0]!.operationInstanceId);
    expect(records[3]!.operationInstanceId).not.toBe(records[0]!.operationInstanceId);
  });

  it("rejects an unsafe previous generation before rotation", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-operational-previous-link-"));
    roots.push(root);
    const reporter = createOperationalDiagnosticsReporter({ projectRoot: root, maxBytes: 700 });
    expect(reporter.report(event()).written).toBe(true);
    const current = operationalDiagnosticsPath(root);
    const previous = resolve(current, "..", "vs001-operational.previous.jsonl");
    const outside = join(root, "outside-previous.txt");
    await writeFile(outside, "outside-previous-before");
    await link(outside, previous);

    expect(reporter.report(event(1))).toEqual(expect.objectContaining({ written: false, failureReason: "diagnostics.unsafe-path" }));
    expect(await readFile(outside, "utf8")).toBe("outside-previous-before");
    expect(await readFile(current, "utf8")).not.toContain("promotion.retry");
    await unlink(previous);
  });
});
