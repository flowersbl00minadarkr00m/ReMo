import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createVerificationRunner } from "./index.js";

function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

const descriptors = [{ id: "fixture-pass", executable: process.execPath, args: ["-e", "process.stdout.write('verified')"], cwd: process.cwd(), timeoutMs: 2_000, maxOutputBytes: 1_024 } ] as const;

describe("fixed verification execution", () => {
  it("runs an allowlisted descriptor with an explicit argument array and returns payload-free evidence", async () => {
    const runner = createVerificationRunner(descriptors);
    const result = await runner.run("fixture-pass");
    expect(result).toMatchObject({ commandId: "fixture-pass", status: "passed", exitCode: 0, timedOut: false, outputLimited: false, stdoutDigest: sha256("verified") });
    expect(JSON.stringify(result)).not.toContain("verified");
  });

  it.each(["fixture-pass;whoami", "fixture-pass && calc", "../fixture-pass", ""])("rejects non-allowlisted or injection-shaped input %j", async (commandId) => {
    const runner = createVerificationRunner(descriptors);
    await expect(runner.run(commandId)).rejects.toMatchObject({ reasonCode: "verification.command-not-allowlisted" });
  });

  it("enforces timeout and output resource bounds without a shell", async () => {
    const runner = createVerificationRunner([
      { id: "timeout", executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), timeoutMs: 30, maxOutputBytes: 1_024 },
      { id: "output", executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(4096))"], cwd: process.cwd(), timeoutMs: 2_000, maxOutputBytes: 64 },
    ]);
    await expect(runner.run("timeout")).resolves.toMatchObject({ status: "failed", timedOut: true, reasonCodes: ["verification.timeout"] });
    await expect(runner.run("output")).resolves.toMatchObject({ status: "failed", outputLimited: true, reasonCodes: ["verification.output-limit"] });
  });

  it("rejects invalid descriptors before execution", () => {
    expect(() => createVerificationRunner([{ id: "unsafe id", executable: process.execPath, args: [], cwd: process.cwd(), timeoutMs: 1, maxOutputBytes: 1 }])).toThrow(/descriptor ID/u);
    expect(() => createVerificationRunner([{ id: "duplicate", executable: process.execPath, args: [], cwd: process.cwd(), timeoutMs: 1, maxOutputBytes: 1 }, { id: "duplicate", executable: process.execPath, args: [], cwd: process.cwd(), timeoutMs: 1, maxOutputBytes: 1 }])).toThrow(/Duplicate/u);
  });
});
