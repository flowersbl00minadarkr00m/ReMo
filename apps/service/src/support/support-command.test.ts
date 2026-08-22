import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSavePointRepository } from "@remo/storage-local";
import { afterEach, describe, expect, it } from "vitest";
import { serializeDiagnosticEvent, type PayloadNeutralDiagnosticEvent } from "./diagnostic-event.js";
import { appendOperationalDiagnostic } from "./operational-jsonl.js";
import { runSupportCommand } from "./support-command.js";
import { createOperationalDiagnosticsReporter } from "./operational-jsonl.js";

const roots: string[] = [];
const SENSITIVE_TEST_VALUE = "REMO_SUPPORT_SENSITIVE_VALUE_V1";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture(): Promise<{ readonly root: string; readonly blobPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "remo-t9-support-"));
  roots.push(root);
  const repository = new LocalSavePointRepository({ projectRoot: root, now: () => new Date("2026-08-16T12:00:00.000Z") });
  createOperationalDiagnosticsReporter({ projectRoot: root, now: () => new Date("2026-08-16T12:00:00.000Z") }).report({ operationId: "capture.fixture", turnIds: [], savePointIds: [], reasonCodes: [], durationMs: 1, retryCount: 0, sizes: { captureBytes: 0 }, digests: {}, policyVersions: { capture: "capture-v2" }, result: "pass" });
  const blob = Buffer.from(SENSITIVE_TEST_VALUE);
  const receipt = repository.promote({
    operationId: "support-fixture-promotion",
    turnId: "01J00000000000000000000T09",
    savePointId: "01J00000000000000000000S09",
    revision: 1,
    candidateRevision: 1,
    candidateManifestDigest: digest("candidate"),
    createdAt: "2026-08-16T11:59:00.000Z",
    policyRevision: "remo.privacy.v1",
    bundle: { policyRevision: "remo.privacy.v1", sensitiveFixturePayload: SENSITIVE_TEST_VALUE },
    blobs: [{ role: "rrweb", bytes: blob, expectedDigest: digest(blob) }],
  });
  const blobPath = repository.blobPath(digest(blob));
  expect(receipt.status).toBe("durable");
  repository.close();
  return { root, blobPath };
}

async function treeInventory(root: string): Promise<Readonly<Record<string, string>>> {
  const entries: Record<string, string> = {};
  const visit = async (path: string, relativePath: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) await visit(child, childRelative);
      else entries[childRelative] = digest(await readFile(child));
    }
  };
  await visit(root, "");
  return entries;
}

describe("payload-neutral operational diagnostics", () => {
  it("verifies database, manifests, blobs, staging, permissions, and adapter reachability without mutating storage", async () => {
    const { root } = await fixture();
    const before = await treeInventory(join(root, ".remo"));
    const events = await runSupportCommand({ projectRoot: root, probeLangfuse: () => Promise.resolve(true) });
    const output = events.map(serializeDiagnosticEvent).join("\n");
    const after = await treeInventory(join(root, ".remo"));

    expect(events.map(({ operationId }) => operationId)).toEqual([
      "support.database",
      "support.manifests",
      "support.blobs",
      "support.staging",
      "support.permissions",
      "support.branch-operations",
      "support.operational-log",
      "support.langfuse-reachability",
    ]);
    expect(events.every(({ result }) => result === "pass")).toBe(true);
    expect(after).toEqual(before);
    expect(output).not.toContain(SENSITIVE_TEST_VALUE);
    expect(output).not.toMatch(/manifest_path|relative_path|canonical_json|receipt_json|payload|sourcePatch|domText|screenshot|tracePayload|credential|secret/iu);
    for (const line of output.split("\n")) {
      expect(Object.keys(JSON.parse(line) as object)).toEqual(["eventId", "operationId", "turnIds", "savePointIds", "reasonCodes", "sizes", "digests", "policyVersions", "result"]);
    }
  });

  it.runIf(process.platform === "win32")("verifies legitimate private storage with a sanitized PowerShell module path", async () => {
    const { root } = await fixture();
    const hostileModulePath = join(root, "sanitized-modules");
    const shadowSecurityModule = join(hostileModulePath, "Microsoft.PowerShell.Security");
    await mkdir(shadowSecurityModule, { recursive: true });
    await writeFile(join(shadowSecurityModule, "Microsoft.PowerShell.Security.psd1"), `@{
      RootModule = 'missing-security-module.psm1'
      ModuleVersion = '1.0.0'
      GUID = '224f8fb6-8294-44bb-b736-b566eb4bcb28'
      CmdletsToExport = @('Get-Acl')
      FunctionsToExport = @()
      AliasesToExport = @()
    }`);
    const originalModulePath = process.env.PSModulePath;
    try {
      process.env.PSModulePath = hostileModulePath;
      const events = await runSupportCommand({ projectRoot: root });
      expect(events.find(({ operationId }) => operationId === "support.permissions")).toMatchObject({ result: "pass", reasonCodes: [] });
    } finally {
      if (originalModulePath === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = originalModulePath;
    }
  });

  it.runIf(process.platform === "win32")("fails closed for an unsafe ACL and restores the private tree", async () => {
    const { root } = await fixture();
    const remoRoot = join(root, ".remo");
    execFileSync("C:\\Windows\\System32\\icacls.exe", [remoRoot, "/grant", "*S-1-1-0:(OI)(CI)F", "/T", "/C", "/Q"], { stdio: "pipe", windowsHide: true });
    try {
      const events = await runSupportCommand({ projectRoot: root });
      expect(events.find(({ operationId }) => operationId === "support.permissions")).toMatchObject({ result: "fail", reasonCodes: ["permissions.not-owner-only"] });
    } finally {
      const repository = new LocalSavePointRepository({ projectRoot: root });
      repository.close();
    }
    const restored = await runSupportCommand({ projectRoot: root });
    expect(restored.find(({ operationId }) => operationId === "support.permissions")).toMatchObject({ result: "pass", reasonCodes: [] });
  }, 30_000);

  it("reports corruption and staging residue with reason codes, sizes, and digests only", async () => {
    const { root, blobPath } = await fixture();
    await writeFile(blobPath, SENSITIVE_TEST_VALUE.repeat(2));
    await writeFile(join(root, ".remo", "staging", "orphan-operation"), SENSITIVE_TEST_VALUE);
    const events = await runSupportCommand({ projectRoot: root });
    const output = events.map(serializeDiagnosticEvent).join("\n");

    expect(events.find(({ operationId }) => operationId === "support.blobs")).toMatchObject({ result: "fail", reasonCodes: ["blob.digest-mismatch", "blob.size-mismatch"] });
    expect(events.find(({ operationId }) => operationId === "support.staging")).toMatchObject({ result: "degraded", reasonCodes: ["staging.pending-or-orphaned"] });
    expect(events.find(({ operationId }) => operationId === "support.langfuse-reachability")).toMatchObject({ result: "unavailable", reasonCodes: ["adapter.langfuse.not-configured"] });
    expect(output).not.toContain(SENSITIVE_TEST_VALUE);
  });

  it("reports an absent controlled operational directory as not initialized", async () => {
    const { root } = await fixture();
    await rm(join(root, ".remo", "operations"), { recursive: true });
    const events = await runSupportCommand({ projectRoot: root });
    expect(events.find(({ operationId }) => operationId === "support.operational-log")).toMatchObject({
      result: "unavailable",
      reasonCodes: ["operational.not-initialized"],
    });
  });

  it("writes one validated JSON object per line and rejects non-schema content", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-t9-jsonl-"));
    roots.push(root);
    const path = join(root, "operations.jsonl");
    const valid: PayloadNeutralDiagnosticEvent = {
      eventId: "vs001.operation.01",
      operationId: "promotion.01",
      turnIds: ["01J00000000000000000000T09"],
      savePointIds: ["01J00000000000000000000S09"],
      reasonCodes: [],
      sizes: { blobBytes: 42 },
      digests: { manifest: [digest("manifest")] },
      policyVersions: { privacy: "remo.privacy.v1" },
      result: "pass",
    };
    await appendOperationalDiagnostic(path, valid);
    await appendOperationalDiagnostic(path, { ...valid, eventId: "vs001.operation.02", result: "degraded", reasonCodes: ["trace.authority-unreachable"] });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line) as object)).toMatchObject([{ eventId: "vs001.operation.01" }, { eventId: "vs001.operation.02" }]);
    expect(() => serializeDiagnosticEvent({ ...valid, policyVersions: { privacy: SENSITIVE_TEST_VALUE.replaceAll("_", " ") } })).toThrow(/identifier/u);
    expect(() => serializeDiagnosticEvent({ ...valid, result: "payload-bearing" as PayloadNeutralDiagnosticEvent["result"] })).toThrow(/canonical diagnostic result/u);
  });

  it("fails closed on a file link without mutating or reading the outside target", async () => {
    const { root } = await fixture();
    const path = join(root, ".remo", "operations", "vs001-operational.jsonl");
    const outside = join(root, "outside-sensitive.txt");
    const outsideMarker = "outside-before-REMO_EXTERNAL_SECRET_MARKER";
    await writeFile(outside, outsideMarker);
    await unlink(path);
    await link(outside, path);

    const report = createOperationalDiagnosticsReporter({ projectRoot: root }).report({
      operationId: "lifecycle.delete",
      operationInstanceId: "sk_live_REMO_SECRET_MARKER_20260816",
      turnIds: ["01J00000000000000000000T09"],
      savePointIds: ["01J00000000000000000000S09"],
      reasonCodes: [], sizes: {}, digests: {}, policyVersions: {}, result: "pass",
    });
    const support = await runSupportCommand({ projectRoot: root });
    const supportEvent = support.find(({ operationId }) => operationId === "support.operational-log");
    const supportBytes = support.map(serializeDiagnosticEvent).join("\n");

    expect(report).toEqual(expect.objectContaining({ written: false, failureReason: "diagnostics.unsafe-path" }));
    expect(await readFile(outside, "utf8")).toBe(outsideMarker);
    expect(supportEvent).toMatchObject({ result: "fail", reasonCodes: ["operational.unsafe-path"] });
    expect(supportBytes).not.toContain(outsideMarker);
  });
});
