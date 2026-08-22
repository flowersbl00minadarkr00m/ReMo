import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LifecycleConfirmationRequiredError, LifecycleIdempotencyConflictError, LifecycleUnavailableError } from "@remo/storage-local";
import { BoundedJsonError, readBoundedJson } from "../save-points/bounded-json-reader.js";
import type { LifecycleService } from "./lifecycle-service.js";

const MAX_BODY_BYTES = 2048;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

function exactLoopbackOrigin(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new Error("Lifecycle API requires one exact IPv4 loopback Origin.");
  return origin.origin;
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function drain(request: IncomingMessage): void {
  if (!request.complete && !request.destroyed) request.resume();
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new BoundedJsonError("request-invalid-json");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new BoundedJsonError("request-invalid-json");
}

function eventId(operationId: string, code: string): string {
  return `lifecycle-${createHash("sha256").update(`${operationId}:${code}`).digest("hex").slice(0, 20)}`;
}

export function createLifecycleApi(options: {
  readonly allowedOrigin: string;
  readonly sessionToken: string;
  readonly service: LifecycleService;
}): { handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> } {
  const origin = exactLoopbackOrigin(options.allowedOrigin);
  if (options.sessionToken.length < 32) throw new TypeError("Lifecycle session token must contain at least 32 characters.");
  return {
    async handle(request, response) {
      const match = /^\/api\/save-points\/([A-Za-z0-9_-]{1,128})(?:\/(lifecycle|pin|unpin|export|quarantine|redact))?$/u.exec(request.url ?? "");
      if (match === null) return false;
      const savePointId = match[1]!;
      const action = match[2];
      if (request.socket.remoteAddress !== "127.0.0.1") { drain(request); writeJson(response, 403, { error: "lifecycle.loopback-required" }); return true; }
      if (request.method === "GET" && action === "lifecycle") {
        const lifecycle = options.service.get(savePointId);
        writeJson(response, lifecycle === undefined ? 404 : 200, lifecycle ?? { error: "lifecycle.not-found" });
        return true;
      }
      const isDelete = request.method === "DELETE" && action === undefined;
      const isAction = request.method === "POST" && action !== undefined && action !== "lifecycle";
      if (!isDelete && !isAction) return false;
      if (request.headers.origin !== origin) { drain(request); writeJson(response, 403, { error: "lifecycle.origin-rejected" }); return true; }
      if (!sameToken(request.headers["x-remo-session-token"] as string | undefined, options.sessionToken)) { drain(request); writeJson(response, 401, { error: "lifecycle.session-token-required" }); return true; }
      if (request.headers["transfer-encoding"] !== undefined) { drain(request); writeJson(response, 400, { error: "lifecycle.transfer-encoding-rejected" }); return true; }
      if (typeof request.headers["content-type"] !== "string" || !JSON_CONTENT_TYPE.test(request.headers["content-type"])) { drain(request); writeJson(response, 415, { error: "lifecycle.json-required" }); return true; }
      const operationId = request.headers["idempotency-key"];
      if (typeof operationId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(operationId)) { drain(request); writeJson(response, 400, { error: "lifecycle.idempotency-key-required" }); return true; }
      try {
        const body = object(await readBoundedJson(request, MAX_BODY_BYTES));
        let result: unknown;
        if (isDelete) {
          exactKeys(body, []);
          result = options.service.delete(savePointId, operationId);
        } else if (action === "pin") {
          exactKeys(body, []);
          result = options.service.pin(savePointId, operationId);
        } else if (action === "unpin") {
          exactKeys(body, ["confirmImmediateExpiry"]);
          if (typeof body.confirmImmediateExpiry !== "boolean") throw new BoundedJsonError("request-invalid-json");
          result = options.service.unpin(savePointId, operationId, body.confirmImmediateExpiry);
        } else if (action === "quarantine") {
          exactKeys(body, []);
          result = options.service.quarantine(savePointId, operationId);
        } else if (action === "redact") {
          exactKeys(body, ["redactedRoles"]);
          if (!Array.isArray(body.redactedRoles) || body.redactedRoles.length > 8 || body.redactedRoles.some((role) => typeof role !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(role))) throw new BoundedJsonError("request-invalid-json");
          result = options.service.redact(savePointId, operationId, body.redactedRoles as string[]);
        } else if (action === "export") {
          exactKeys(body, []);
          const exported = options.service.export(savePointId, operationId);
          const { path: controlledLocalPath, ...safeExport } = exported;
          void controlledLocalPath;
          result = safeExport;
        } else {
          drain(request);
          writeJson(response, 404, { error: "lifecycle.unknown-action" });
          return true;
        }
        writeJson(response, 200, result);
      } catch (error) {
        if (error instanceof BoundedJsonError) {
          if (!response.destroyed) writeJson(response, error.code === "request-too-large" ? 413 : 400, { error: `lifecycle.${error.code}` });
        } else if (error instanceof LifecycleConfirmationRequiredError) {
          writeJson(response, 409, { error: error.code, confirmationRequired: true, originalExpiresAt: error.originalExpiresAt, retryable: true, eventId: eventId(operationId, error.code) });
        } else if (error instanceof LifecycleUnavailableError) {
          const status = error.code === "lifecycle.expired" ? 410 : error.code === "lifecycle.quarantined" ? 423 : 404;
          writeJson(response, status, { error: error.code, retryable: false, eventId: eventId(operationId, error.code) });
        } else if (error instanceof LifecycleIdempotencyConflictError) {
          writeJson(response, 409, { error: error.code, retryable: false, eventId: eventId(operationId, error.code) });
        } else {
          writeJson(response, 409, { error: "lifecycle.action-failed", retryable: true, eventId: eventId(operationId, "lifecycle.action-failed") });
        }
      }
      return true;
    },
  };
}
