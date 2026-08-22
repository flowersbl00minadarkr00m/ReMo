import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BranchPreflightReceipt } from "@remo/domain";
import { BoundedJsonError, readBoundedJson } from "../save-points/bounded-json-reader.js";

const ROUTE = /^\/api\/save-points\/([A-Za-z0-9_-]{1,128})\/branch-preflight$/u;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body));
}

function revisionBody(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1) throw new BoundedJsonError("request-invalid-json");
  const revision = (value as { readonly savePointRevision?: unknown }).savePointRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new BoundedJsonError("request-invalid-json");
  return Number(revision);
}

export function createBranchPreflightApi(options: { readonly allowedOrigin: string; readonly sessionToken: string; readonly evaluate: (savePointId: string, revision: number) => Promise<BranchPreflightReceipt> }) {
  return {
    matches(requestUrl: string | undefined): boolean { if (requestUrl === undefined) return false; const url = new URL(requestUrl, options.allowedOrigin); return url.search === "" && ROUTE.test(url.pathname); },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const url = new URL(request.url ?? "/", options.allowedOrigin);
      const savePointId = ROUTE.exec(url.pathname)?.[1];
      if (savePointId === undefined || url.search !== "") { writeJson(response, 404, { error: "preflight.route-not-found" }); return; }
      if (request.method !== "POST") { request.resume(); writeJson(response, 405, { error: "preflight.post-required" }); return; }
      if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.origin !== options.allowedOrigin || !sameToken(request.headers["x-remo-session-token"] as string | undefined, options.sessionToken)) { request.resume(); writeJson(response, 403, { error: "preflight.authentication-required" }); return; }
      if (!JSON_CONTENT_TYPE.test(request.headers["content-type"] ?? "")) { request.resume(); writeJson(response, 415, { error: "preflight.json-required" }); return; }
      try {
        const revision = revisionBody(await readBoundedJson(request, 1024));
        writeJson(response, 200, await options.evaluate(savePointId, revision));
      } catch (error) {
        if (error instanceof BoundedJsonError) {
          if (error.code === "request-aborted") { if (!response.destroyed) response.destroy(); return; }
          writeJson(response, error.code === "request-too-large" ? 413 : 400, { error: `preflight.${error.code}` }); return;
        }
        writeJson(response, 409, { error: "preflight.inspection-unavailable", message: "Read-only branch preflight could not complete. No mutation was attempted." });
      }
    },
  };
}

export type BranchPreflightApi = ReturnType<typeof createBranchPreflightApi>;
