import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createBranchOrchestrationApi } from "./branch-orchestration-api.js";
import type { BranchConfirmationRequest, BranchOrchestrationService } from "./branch-orchestration-service.js";

const ID = "01J000000000000000000000S5";
const TOKEN = randomBytes(24).toString("base64url");
const DIGEST = `sha256:${"b".repeat(64)}`;

function service() {
  return {
    confirm: vi.fn((request: BranchConfirmationRequest) => Promise.resolve({
      schemaVersion: "remo.branch-result.v1" as const,
      operationId: "branch-operation",
      savePointId: request.savePointId,
      savePointRevision: request.expectedSavePointRevision,
      preflightDigest: request.preflightDigest,
      displayLabel: request.displayLabel,
      state: "succeeded" as const,
      reasonCodes: [],
      branchRef: "refs/heads/remo/branch-operation",
      worktreeRelativePath: ".remo/worktrees/branch-operation",
      lineageId: "lineage:alternate:branch-operation",
      updatedAt: "2026-08-20T00:00:00.000Z",
    })),
    readForSavePoint: vi.fn(() => []),
  };
}

async function fixture(run: (origin: string, port: number, subject: ReturnType<typeof service>) => Promise<void>): Promise<void> {
  const subject = service();
  const api = createBranchOrchestrationApi({ allowedOrigin: "http://127.0.0.1", sessionToken: TOKEN, service: subject as unknown as BranchOrchestrationService });
  const server = createServer((request, response) => { if (!api.matches(request.url)) response.writeHead(404).end(); else void api.handle(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("listener unavailable");
  try { await run(`http://127.0.0.1:${address.port}`, address.port, subject); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
}

function body(): string {
  return JSON.stringify({ confirm: true, preflightDigest: DIGEST, expectedSavePointRevision: 1, displayLabel: "Alternate fixture" });
}

function raw(port: number, request: string, abort = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(request);
      if (abort) { socket.destroy(); resolve(""); }
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("end", () => resolve(response));
    socket.on("error", abort ? () => resolve("") : reject);
  });
}

describe("branch orchestration API", () => {
  it("accepts exact closed-loopback confirmation and projects restart truth", async () => fixture(async (origin, _port, subject) => {
    const response = await fetch(`${origin}/api/save-points/${ID}/branches`, { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": TOKEN, "idempotency-key": "branch-key", "content-type": "application/json" }, body: body() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(subject.confirm).toHaveBeenCalledTimes(1);
    const listed = await fetch(`${origin}/api/save-points/${ID}/branches`, { headers: { "x-remo-session-token": TOKEN } });
    expect(listed.status).toBe(200);
    const listedWithExactOrigin = await fetch(`${origin}/api/save-points/${ID}/branches`, { headers: { origin: "http://127.0.0.1", "x-remo-session-token": TOKEN } });
    expect(listedWithExactOrigin.status).toBe(200);
    expect(subject.readForSavePoint).toHaveBeenCalledTimes(2);
    expect(subject.readForSavePoint).toHaveBeenLastCalledWith(ID);
  }));

  it("rejects wrong origin, token, content type, method, query, and body shape before orchestration", async () => fixture(async (origin, _port, subject) => {
    const cases: Array<[string, RequestInit, number]> = [
      [`${origin}/api/save-points/${ID}/branches`, { method: "POST", headers: { origin: "http://localhost", "x-remo-session-token": TOKEN, "idempotency-key": "k", "content-type": "application/json" }, body: body() }, 403],
      [`${origin}/api/save-points/${ID}/branches`, { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": "wrong", "idempotency-key": "k", "content-type": "application/json" }, body: body() }, 403],
      [`${origin}/api/save-points/${ID}/branches`, { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": TOKEN, "idempotency-key": "k", "content-type": "text/plain" }, body: body() }, 415],
      [`${origin}/api/save-points/${ID}/branches`, { method: "PUT", headers: { origin: "http://127.0.0.1", "x-remo-session-token": TOKEN } }, 405],
      [`${origin}/api/save-points/${ID}/branches?x=1`, { method: "GET" }, 404],
      [`${origin}/api/save-points/${ID}/branches`, { method: "GET", headers: { origin: "http://localhost", "x-remo-session-token": TOKEN } }, 403],
      [`${origin}/api/save-points/${ID}/branches`, { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": TOKEN, "idempotency-key": "k", "content-type": "application/json" }, body: JSON.stringify({ confirm: true, preflightDigest: DIGEST, expectedSavePointRevision: 1, displayLabel: "x", sourceCommit: "client-truth-forbidden" }) }, 400],
    ];
    for (const [url, init, expected] of cases) expect((await fetch(url, init)).status).toBe(expected);
    expect(subject.confirm).not.toHaveBeenCalled();
  }));

  it("rejects duplicate and comma-collapsed idempotency headers", async () => fixture(async (_origin, port, subject) => {
    const payload = body();
    const duplicate = await raw(port, `POST /api/save-points/${ID}/branches HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://127.0.0.1\r\nX-ReMo-Session-Token: ${TOKEN}\r\nIdempotency-Key: first\r\nIdempotency-Key: second\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
    expect(duplicate).toMatch(/HTTP\/1\.1 400/u);
    const collapsed = await fetch(`http://127.0.0.1:${port}/api/save-points/${ID}/branches`, { method: "POST", headers: { origin: "http://127.0.0.1", "x-remo-session-token": TOKEN, "idempotency-key": "first, second", "content-type": "application/json" }, body: payload });
    expect(collapsed.status).toBe(400);
    expect(subject.confirm).not.toHaveBeenCalled();
  }));

  it("rejects supplied Origin headers unless exactly one value matches", async () => fixture(async (origin, port, subject) => {
    const route = `/api/save-points/${ID}/branches`;
    const duplicate = await raw(port, `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://127.0.0.1\r\nOrigin: http://127.0.0.1\r\nX-ReMo-Session-Token: ${TOKEN}\r\nConnection: close\r\n\r\n`);
    expect(duplicate).toMatch(/HTTP\/1\.1 403/u);

    const malformedValues = ["http://127.0.0.1, http://127.0.0.1", ""];
    for (const suppliedOrigin of malformedValues) {
      const response = await fetch(`${origin}${route}`, { headers: { origin: suppliedOrigin, "x-remo-session-token": TOKEN } });
      expect(response.status).toBe(403);
    }
    expect(subject.readForSavePoint).not.toHaveBeenCalled();
  }));

  it("bounds oversized and chunked bodies and does not invoke orchestration after abort", async () => fixture(async (_origin, port, subject) => {
    const oversized = "x".repeat(5000);
    const response = await raw(port, `POST /api/save-points/${ID}/branches HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://127.0.0.1\r\nX-ReMo-Session-Token: ${TOKEN}\r\nIdempotency-Key: large\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${oversized.length.toString(16)}\r\n${oversized}\r\n0\r\n\r\n`);
    expect(response).toMatch(/HTTP\/1\.1 413/u);
    await raw(port, `POST /api/save-points/${ID}/branches HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://127.0.0.1\r\nX-ReMo-Session-Token: ${TOKEN}\r\nIdempotency-Key: aborted\r\nContent-Type: application/json\r\nContent-Length: 300\r\n\r\n{`, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(subject.confirm).not.toHaveBeenCalled();
  }));

  it("accepts an IPv4 client observed through Node's IPv4-mapped peer form but rejects native IPv6 loopback", async () => {
    const subject = service();
    const api = createBranchOrchestrationApi({ allowedOrigin: "http://127.0.0.1", sessionToken: TOKEN, service: subject as unknown as BranchOrchestrationService });
    const server = createServer((request, response) => { if (!api.matches(request.url)) response.writeHead(404).end(); else void api.handle(request, response); });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("listener unavailable");
    try {
      const mapped = await fetch(`http://127.0.0.1:${address.port}/api/save-points/${ID}/branches`, { headers: { "x-remo-session-token": TOKEN } });
      expect(mapped.status).toBe(200);
      const nativeIpv6 = await fetch(`http://[::1]:${address.port}/api/save-points/${ID}/branches`, { headers: { "x-remo-session-token": TOKEN } });
      expect(nativeIpv6.status).toBe(403);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  });
});
