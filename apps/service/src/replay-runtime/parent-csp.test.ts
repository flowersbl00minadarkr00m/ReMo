import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalApplication } from "../promotion/local-application.js";
import { REPLAY_RUNTIME_ORIGIN } from "./runtime-server.js";

const roots: string[] = [];
const closes: Array<() => Promise<void>> = [];

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback port was allocated.");
  server.close();
  await once(server, "close");
  return address.port;
}

afterEach(async () => {
  while (closes.length > 0) await closes.pop()!();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parent application CSP remains independent", () => {
  it("adds only the bounded media and exact replay-frame capabilities", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "remo-parent-csp-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".git"));
    const application = await startLocalApplication({
      projectRoot,
      port: await freePort(),
      webRoot: resolve(import.meta.dirname, "../../../web/dist"),
      lifecycleSweepEveryMs: 60 * 60 * 1_000,
    });
    closes.push(application.close);
    const response = await fetch(application.origin);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(response.status).toBe(200);
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain(`frame-src ${REPLAY_RUNTIME_ORIGIN}`);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/(?:^|\s)\*(?:;|\s|$)/u);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(application.replayRuntime.state).toBe("listener-unavailable");
  });
});
