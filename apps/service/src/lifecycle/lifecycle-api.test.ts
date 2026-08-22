import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { LifecycleConfirmationRequiredError, LifecycleIdempotencyConflictError } from "@remo/storage-local";
import { describe, expect, it, vi } from "vitest";
import { createLifecycleApi } from "./lifecycle-api.js";
import type { LifecycleService } from "./lifecycle-service.js";

const TOKEN = randomBytes(32).toString("base64url");
const SAVE = "01J000000000000000000000S7";
const OTHER_SAVE = "01J000000000000000000000S8";

async function fixture(overrides: Partial<LifecycleService> = {}) {
  const projection = { subject: "durable", id: SAVE, turnId: "turn-t7", savePointId: SAVE, revision: 1, state: "active", createdAt: "2026-08-01T00:00:00.000Z", promotedAt: "2026-08-01T00:00:00.000Z", originalExpiresAt: "2026-08-31T00:00:00.000Z", expiresAt: "2026-08-31T00:00:00.000Z", pinned: false } as const;
  const pinMock = vi.fn<LifecycleService["pin"]>((id: string, operationId: string) => {
    void id;
    return { ...projection, operationId, changed: true, pinned: true } as const;
  });
  const service: LifecycleService = {
    get: vi.fn<LifecycleService["get"]>((id: string) => {
      void id;
      return projection;
    }),
    pin: pinMock,
    unpin: vi.fn<LifecycleService["unpin"]>((id: string, operationId: string, confirmed: boolean) => {
      void id;
      void confirmed;
      return { ...projection, operationId, changed: true } as const;
    }),
    quarantine: vi.fn<LifecycleService["quarantine"]>((_id: string, operationId: string) => ({ ...projection, operationId, changed: true, state: "quarantined" } as const)),
    redact: vi.fn<LifecycleService["redact"]>((id: string, operationId: string, redactedRoles: readonly string[]) => {
      void id;
      void redactedRoles;
      return { ...projection, subject: "candidate", operationId, changed: true } as const;
    }),
    export: vi.fn<LifecycleService["export"]>((_id: string, operationId: string) => ({ operationId, savePointId: SAVE, revision: 1, exportedAt: "2026-08-16T00:00:00.000Z", fileName: "safe.zip", path: "C:/private/project/.remo/exports/safe.zip", digest: `sha256:${"a".repeat(64)}`, byteSize: 4, inventory: [], excluded: [], bytesBase64: "UEs=" })),
    delete: vi.fn<LifecycleService["delete"]>((_id: string, operationId: string) => ({ operationId, subject: "durable", targetId: SAVE, savePointId: SAVE, deletedAt: "2026-08-16T00:00:00.000Z", states: [], complete: true } as const)),
    sweep: vi.fn<LifecycleService["sweep"]>(() => ({ sweptAt: "2026-08-16T00:00:00.000Z", candidates: [], durableSavePoints: [] })),
    ...overrides,
  };
  const ref: { api?: ReturnType<typeof createLifecycleApi> } = {};
  const server = createServer((request, response) => { void ref.api!.handle(request, response).then((handled) => { if (!handled) response.writeHead(404).end(); }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  ref.api = createLifecycleApi({ allowedOrigin: origin, sessionToken: TOKEN, service });
  return { origin, service, pinMock, close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))) };
}

function headers(origin: string, key: string): Record<string, string> {
  return { origin, "x-remo-session-token": TOKEN, "content-type": "application/json", "idempotency-key": key };
}

describe("payload-neutral lifecycle HTTP API", () => {
  it("requires same-origin session authority and a bounded idempotency key", async () => {
    const app = await fixture();
    try {
      expect((await fetch(`${app.origin}/api/save-points/${SAVE}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
      expect((await fetch(`${app.origin}/api/save-points/${SAVE}/pin`, { method: "POST", headers: { origin: app.origin, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      expect((await fetch(`${app.origin}/api/save-points/${SAVE}/pin`, { method: "POST", headers: { origin: app.origin, "x-remo-session-token": TOKEN, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
      expect(app.pinMock).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("returns explicit immediate-expiry confirmation without payloads and permits a confirmed retry", async () => {
    const unpin = vi.fn((_id: string, operationId: string, confirmed: boolean) => {
      if (!confirmed) throw new LifecycleConfirmationRequiredError("2026-08-31T00:00:00.000Z");
      return { subject: "durable", id: SAVE, turnId: "turn-t7", savePointId: SAVE, revision: 1, state: "expired", createdAt: "2026-08-01T00:00:00.000Z", promotedAt: "2026-08-01T00:00:00.000Z", originalExpiresAt: "2026-08-31T00:00:00.000Z", expiresAt: "2026-08-31T00:00:00.000Z", pinned: false, operationId, changed: true } as const;
    });
    const app = await fixture({ unpin });
    try {
      const blocked = await fetch(`${app.origin}/api/save-points/${SAVE}/unpin`, { method: "POST", headers: headers(app.origin, "unpin-t7"), body: '{"confirmImmediateExpiry":false}' });
      const blockedBody = await blocked.json() as Record<string, unknown>;
      expect(blocked.status).toBe(409);
      expect(blockedBody).toMatchObject({ error: "lifecycle.immediate-expiry-confirmation-required", confirmationRequired: true, retryable: true });
      expect(JSON.stringify(blockedBody)).not.toMatch(/rrweb|screenshot|manifestPath|private|tracePayload/u);
      const confirmed = await fetch(`${app.origin}/api/save-points/${SAVE}/unpin`, { method: "POST", headers: headers(app.origin, "unpin-t7"), body: '{"confirmImmediateExpiry":true}' });
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toMatchObject({ state: "expired", changed: true });
    } finally { await app.close(); }
  });

  it("exports bounded bytes without exposing the controlled local path and keeps failures retryable", async () => {
    const app = await fixture();
    try {
      const response = await fetch(`${app.origin}/api/save-points/${SAVE}/export`, { method: "POST", headers: headers(app.origin, "export-t7"), body: "{}" });
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ fileName: "safe.zip", bytesBase64: "UEs=" });
      expect(body.path).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("C:/private/project");
    } finally { await app.close(); }
  });

  it("rejects cross-action and cross-target key reuse with one payload-neutral stable conflict", async () => {
    const bindings = new Map<string, string>();
    const bind = (operationId: string, action: string, targetId: string): void => {
      const tuple = `${action}:durable:${targetId}`;
      const existing = bindings.get(operationId);
      if (existing !== undefined && existing !== tuple) throw new LifecycleIdempotencyConflictError();
      bindings.set(operationId, tuple);
    };
    const pin = vi.fn((id: string, operationId: string) => {
      bind(operationId, "pin", id);
      return { subject: "durable", id, turnId: "turn-t7", savePointId: id, revision: 1, state: "active", createdAt: "2026-08-01T00:00:00.000Z", promotedAt: "2026-08-01T00:00:00.000Z", originalExpiresAt: "2026-08-31T00:00:00.000Z", expiresAt: "2026-08-31T00:00:00.000Z", pinned: true, operationId, changed: true } as const;
    });
    const quarantine = vi.fn((id: string, operationId: string) => {
      bind(operationId, "quarantine", id);
      throw new Error("unreachable after conflict fixture binding");
    });
    const app = await fixture({ pin, quarantine });
    try {
      const key = "already-bound-intent";
      expect((await fetch(`${app.origin}/api/save-points/${SAVE}/pin`, { method: "POST", headers: headers(app.origin, key), body: "{}" })).status).toBe(200);
      const crossAction = await fetch(`${app.origin}/api/save-points/${SAVE}/quarantine`, { method: "POST", headers: headers(app.origin, key), body: "{}" });
      const crossTarget = await fetch(`${app.origin}/api/save-points/${OTHER_SAVE}/pin`, { method: "POST", headers: headers(app.origin, key), body: "{}" });
      const eventIds: unknown[] = [];
      for (const response of [crossAction, crossTarget]) {
        const body = await response.json() as Record<string, unknown>;
        expect(response.status).toBe(409);
        expect(body).toMatchObject({ error: "lifecycle.idempotency-conflict", retryable: false });
        expect(body.eventId).toMatch(/^lifecycle-[0-9a-f]{20}$/u);
        expect(JSON.stringify(body)).not.toMatch(/target|action|rrweb|screenshot|manifest|private|trace/iu);
        eventIds.push(body.eventId);
      }
      expect(new Set(eventIds).size).toBe(1);
    } finally { await app.close(); }
  });
});
