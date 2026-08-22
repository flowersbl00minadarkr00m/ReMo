import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createControlledTurnRuntime } from "./controlled-turn.js";

const run = promisify(execFile);
const SOURCE = "packages/test-fixtures/vs001-ui/src";
const ROUTE = "/fixture/save-point";
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map(async (server) => { server.close(); await once(server, "close"); }));
  servers = [];
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "remo-controlled-turn-"));
  await mkdir(join(root, SOURCE, "panels"), { recursive: true });
  await writeFile(join(root, SOURCE, "panels", "EvidencePanel.tsx"), "export const EvidencePanel = () => <main><h1>Evidence</h1></main>;\n");
  await run("git", ["init", "--initial-branch=main"], { cwd: root, shell: false });
  await run("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root, shell: false });
  await run("git", ["config", "user.name", "Fixture"], { cwd: root, shell: false });
  await run("git", ["add", "."], { cwd: root, shell: false });
  await run("git", ["commit", "-m", "fixture"], { cwd: root, shell: false });
  return root;
}

describe("one real controlled turn", () => {
  it("starts Chromium, stops through the authenticated API, settles stable Git evidence, and nominates once", async () => {
    const repositoryRoot = await repository();
    const fixtureOrigin = await listen(createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(request.url === ROUTE ? "<!doctype html><main data-remo-fixture-root><h1>Evidence</h1></main>" : "not found");
    }));
    const apiServer = createServer();
    const apiOrigin = await listen(apiServer);
    const runtime = createControlledTurnRuntime({ allowedOrigin: apiOrigin });
    apiServer.on("request", (request, response) => void runtime.handle(request, response));
    const { turn, bootstrap } = await runtime.start({
      turnId: "turn-integration-3",
      repositoryRoot,
      allowedSourceRoot: SOURCE,
      startedAt: "2026-08-16T06:00:00.000Z",
      capture: { origin: fixtureOrigin, path: ROUTE, captureRoot: "[data-remo-fixture-root]", launchOptions: { headless: true } },
    });
    await writeFile(join(repositoryRoot, SOURCE, "panels", "EvidencePanel.tsx"), "export const EvidencePanel = () => <main aria-label=\"Evidence\"><header><h1>Evidence</h1></header></main>;\n");

    const response = await fetch(`${apiOrigin}/api/turns/turn-integration-3/stop`, {
      method: "POST",
      headers: { origin: apiOrigin, "content-type": "application/json", "x-remo-session-token": runtime.sessionToken },
      body: JSON.stringify({ boundaries: [{ kind: "human-intervention", boundaryId: "user-stop", occurredAt: "2026-08-16T06:00:10.000Z" }] }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { status: string; categories: string[] };
    expect(result).toMatchObject({ status: "candidate", categories: ["structure", "accessibility"] });
    expect(turn.snapshot()).toMatchObject({ status: "stopped", turnId: "turn-integration-3" });
    expect(bootstrap).toMatchObject({ turnId: "turn-integration-3", sessionToken: runtime.sessionToken });
  });
});
