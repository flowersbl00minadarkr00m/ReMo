import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PromotionHttpResponse } from "./promotion-handler.js";

const MAX_BODY_BYTES = 1024;

function exactLoopbackOrigin(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new Error("Promotion API requires one exact IPv4 loopback Origin.");
  return origin.origin;
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("request-too-large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface PromotionApi {
  readonly sessionToken: string;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export function createPromotionApi(options: {
  readonly allowedOrigin: string;
  readonly promote: (turnId: string, body: unknown) => Promise<PromotionHttpResponse>;
  readonly sessionToken?: string;
}): PromotionApi {
  const origin = exactLoopbackOrigin(options.allowedOrigin);
  const sessionToken = options.sessionToken ?? randomBytes(32).toString("base64url");
  if (sessionToken.length < 32) throw new TypeError("Promotion session token must contain at least 32 characters");
  return {
    sessionToken,
    async handle(request, response) {
      if (request.socket.remoteAddress !== "127.0.0.1") { writeJson(response, 403, { status: "failed", code: "promotion.loopback-required", message: "Loopback connection required.", retryable: false }); return; }
      if (request.headers.origin !== origin) { writeJson(response, 403, { status: "failed", code: "promotion.origin-rejected", message: "Request Origin was rejected.", retryable: false }); return; }
      if (!sameToken(request.headers["x-remo-session-token"] as string | undefined, sessionToken)) { writeJson(response, 401, { status: "failed", code: "promotion.session-token-required", message: "Promotion session token required.", retryable: false }); return; }
      if (request.method !== "POST" || !request.headers["content-type"]?.toLowerCase().startsWith("application/json")) { writeJson(response, 415, { status: "failed", code: "promotion.json-post-required", message: "JSON POST required.", retryable: false }); return; }
      const match = /^\/api\/candidates\/([A-Za-z0-9_-]{1,128})\/promote$/u.exec(request.url ?? "");
      if (match === null) { writeJson(response, 404, { status: "failed", code: "promotion.unknown-route", message: "Unknown promotion route.", retryable: false }); return; }
      try {
        const result = await options.promote(match[1]!, await readJson(request));
        writeJson(response, result.status, result.body);
      } catch {
        writeJson(response, 400, { status: "failed", code: "promotion.invalid-request", message: "Promotion request was invalid.", retryable: false });
      }
    },
  };
}
