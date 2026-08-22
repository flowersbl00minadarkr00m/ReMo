import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { FoundationConflictError } from "@remo/storage-local";
import { BoundedJsonError, readBoundedJson } from "../save-points/bounded-json-reader.js";
import type { BranchConfirmationRequest, BranchOrchestrationService } from "./branch-orchestration-service.js";

const ROUTE = /^\/api\/save-points\/([A-Za-z0-9_-]{1,128})\/branches$/u;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/u;

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isExactIpv4LoopbackPeer(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

type OptionalHeader =
  | { readonly state: "absent" }
  | { readonly state: "exact"; readonly value: string }
  | { readonly state: "malformed" };

function exactOptionalHeader(request: IncomingMessage, name: string): OptionalHeader {
  const occurrences: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) occurrences.push(request.rawHeaders[index + 1] ?? "");
  }
  const value = request.headers[name];
  if (occurrences.length === 0 && value === undefined) return { state: "absent" };
  if (occurrences.length === 1 && typeof value === "string" && value === occurrences[0]) return { state: "exact", value };
  return { state: "malformed" };
}

function exactSingleHeader(request: IncomingMessage, name: string): string | undefined {
  const header = exactOptionalHeader(request, name);
  return header.state === "exact" ? header.value : undefined;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body));
}

function confirmationBody(savePointId: string, idempotencyKey: string | undefined, value: unknown): BranchConfirmationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["confirm", "displayLabel", "expectedSavePointRevision", "preflightDigest"])) throw new BoundedJsonError("request-invalid-json");
  const body = value as { readonly confirm?: unknown; readonly displayLabel?: unknown; readonly expectedSavePointRevision?: unknown; readonly preflightDigest?: unknown };
  if (body.confirm !== true || typeof body.displayLabel !== "string" || typeof body.preflightDigest !== "string" || !Number.isSafeInteger(body.expectedSavePointRevision) || idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new BoundedJsonError("request-invalid-json");
  return { savePointId, confirm: true, displayLabel: body.displayLabel, preflightDigest: body.preflightDigest, expectedSavePointRevision: Number(body.expectedSavePointRevision), idempotencyKey };
}

export function createBranchOrchestrationApi(options: { readonly allowedOrigin: string; readonly sessionToken: string; readonly service: BranchOrchestrationService }) {
  return {
    matches(requestUrl: string | undefined): boolean { if (requestUrl === undefined) return false; const url = new URL(requestUrl, options.allowedOrigin); return url.search === "" && ROUTE.test(url.pathname); },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const url = new URL(request.url ?? "/", options.allowedOrigin);
      const savePointId = ROUTE.exec(url.pathname)?.[1];
      if (savePointId === undefined || url.search !== "") { writeJson(response, 404, { error: "branch.route-not-found" }); return; }
      const origin = exactOptionalHeader(request, "origin");
      const token = exactSingleHeader(request, "x-remo-session-token");
      const authenticatedPeer = isExactIpv4LoopbackPeer(request.socket.remoteAddress) && sameToken(token, options.sessionToken);
      if (request.method === "GET") {
        if (!authenticatedPeer || origin.state === "malformed" || (origin.state === "exact" && origin.value !== options.allowedOrigin)) { request.resume(); writeJson(response, 403, { error: "branch.authentication-required" }); return; }
        writeJson(response, 200, { schemaVersion: "remo.branch-results.v1", operations: options.service.readForSavePoint(savePointId) }); return;
      }
      if (!authenticatedPeer || origin.state !== "exact" || origin.value !== options.allowedOrigin) { request.resume(); writeJson(response, 403, { error: "branch.authentication-required" }); return; }
      if (request.method !== "POST") { request.resume(); writeJson(response, 405, { error: "branch.post-required" }); return; }
      if (!JSON_CONTENT_TYPE.test(request.headers["content-type"] ?? "")) { request.resume(); writeJson(response, 415, { error: "branch.json-required" }); return; }
      try {
        const input = confirmationBody(savePointId, exactSingleHeader(request, "idempotency-key"), await readBoundedJson(request, 4096));
        writeJson(response, 200, await options.service.confirm(input));
      } catch (error) {
        if (error instanceof BoundedJsonError) {
          if (error.code === "request-aborted") { if (!response.destroyed) response.destroy(); return; }
          writeJson(response, error.code === "request-too-large" ? 413 : 400, { error: `branch.${error.code}` }); return;
        }
        if (error instanceof FoundationConflictError) { writeJson(response, 409, { error: error.code, message: error.message }); return; }
        writeJson(response, 503, { error: "branch.interrupted", message: "The branch operation did not return a terminal result. Restart reconciliation is required." });
      }
    },
  };
}

export type BranchOrchestrationApi = ReturnType<typeof createBranchOrchestrationApi>;
