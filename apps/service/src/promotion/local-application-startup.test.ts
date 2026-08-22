import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settleLocalApplicationResources, startLocalApplication } from "./local-application.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local application startup settlement", () => {
  it.runIf(process.platform === "win32")("releases runtime resources when web-root canonicalization fails", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "remo-local-app-startup-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".git"));

    const startup = startLocalApplication({
      projectRoot,
      webRoot: join(projectRoot, "missing-web-root"),
      port: 41_574,
      seedImplementationFixture: false,
    });

    await expect(startup).rejects.toMatchObject({ code: "ENOENT" });
    await expect(rm(projectRoot, { recursive: true })).resolves.toBeUndefined();
    roots.splice(roots.indexOf(projectRoot), 1);
  });

  it("preserves a primary failure after complete teardown and reports cleanup-only failures", async () => {
    const primary = new Error("startup failed");
    const cleanupFailure = new Error("cleanup failed");
    const settled: string[] = [];

    await expect(settleLocalApplicationResources([
      () => { settled.push("first"); throw cleanupFailure; },
      () => { settled.push("second"); },
    ], { error: primary })).rejects.toBe(primary);
    expect(settled).toEqual(["first", "second"]);

    await expect(settleLocalApplicationResources([
      () => { throw cleanupFailure; },
    ])).rejects.toBe(cleanupFailure);
  });
});
