import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function outputFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? outputFiles(path) : [path];
  });
}

describe("production promotion-token boundary", () => {
  it("cannot persist a supplied session-token marker in the production build", () => {
    const marker = "REMO_TOKEN_MUST_NOT_PERSIST_7b935a70";
    const webRoot = resolve(import.meta.dirname, "..");
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "pnpm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm run build"] : ["run", "build"];
    execFileSync(command, args, {
      cwd: webRoot,
      env: { ...process.env, REMO_PROMOTION_SESSION_TOKEN: marker },
      stdio: "pipe",
    });

    const persisted = outputFiles(join(webRoot, "dist"))
      .some((path) => readFileSync(path).includes(Buffer.from(marker)));
    expect(persisted).toBe(false);
  }, 30_000);
});
