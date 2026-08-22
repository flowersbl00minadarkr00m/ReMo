import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BoundedJsonError, readBoundedJson } from "../save-points/bounded-json-reader.js";
import { DecisionServiceError, type DecisionService, type DurableDecisionMutationRequest } from "./decision-service.js";

const MAX_BODY_BYTES = 16 * 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(value));
}

function drain(request: IncomingMessage): void {
  if (!request.complete && !request.destroyed) request.resume();
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new BoundedJsonError("request-invalid-json");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(); const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) throw new BoundedJsonError("request-invalid-json");
}

const DECISION_FIELDS = ["question", "options", "selectedOptionId", "owner", "uncertainty", "expectedEffect", "verification", "outcome"] as const;

function validateFieldShape(value: unknown): void {
  const field = object(value);
  exactKeys(field, field.value === undefined ? ["provenance", "sourceComponentIds"] : ["value", "provenance", "sourceComponentIds"]);
  if (!Array.isArray(field.sourceComponentIds)) throw new BoundedJsonError("request-invalid-json");
}

function validateCandidateContent(value: unknown): void {
  const content = object(value);
  exactKeys(content, [...DECISION_FIELDS, "evidenceComponentIds"]);
  for (const name of DECISION_FIELDS) validateFieldShape(content[name]);
  if (!Array.isArray(content.evidenceComponentIds)) throw new BoundedJsonError("request-invalid-json");
  const options = object(content.options).value;
  if (Array.isArray(options)) for (const option of options) exactKeys(object(option), ["id", "label"]);
  const uncertainty = object(content.uncertainty).value;
  if (uncertainty !== undefined) exactKeys(object(uncertainty), ["level", "source"]);
}

function validateRevisionBody(body: Record<string, unknown>): void {
  if (body.mutation === "confirm-inferred") {
    if (!Array.isArray(body.fields)) throw new BoundedJsonError("request-invalid-json");
    return;
  }
  const changes = object(body.changes);
  for (const [name, value] of Object.entries(changes)) {
    if (!(DECISION_FIELDS as readonly string[]).includes(name)) throw new BoundedJsonError("request-invalid-json");
    validateFieldShape(value);
  }
  if (body.evidenceComponentIds !== undefined && !Array.isArray(body.evidenceComponentIds)) throw new BoundedJsonError("request-invalid-json");
}

export function createDecisionApi(options: { readonly allowedOrigin: string; readonly sessionToken: string; readonly service: DecisionService }) {
  const origin = new URL(options.allowedOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== options.allowedOrigin) throw new Error("Decision API requires one exact IPv4 loopback Origin.");
  return {
    matches(url: string | undefined): boolean {
      return /^\/api\/(?:candidates\/[A-Za-z0-9_-]{1,128}\/decision|save-points\/[A-Za-z0-9_-]{1,128}\/(?:decision|decision-revisions))$/u.test(url ?? "");
    },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const candidate = /^\/api\/candidates\/([A-Za-z0-9_-]{1,128})\/decision$/u.exec(request.url ?? "");
      const durable = /^\/api\/save-points\/([A-Za-z0-9_-]{1,128})\/(decision|decision-revisions)$/u.exec(request.url ?? "");
      if (candidate === null && durable === null) return false;
      if (request.socket.remoteAddress !== "127.0.0.1") { drain(request); writeJson(response, 403, { error: "decision.loopback-required" }); return true; }
      if (request.method === "GET" && candidate !== null) {
        const value = options.service.readCandidate(candidate[1]!);
        writeJson(response, 200, value ?? { schemaVersion: "remo.decision.absent.v1", state: "unknown" });
        return true;
      }
      if (request.method === "GET" && durable?.[2] === "decision") {
        const value = options.service.read(durable[1]!);
        if (value === undefined) writeJson(response, 200, { schemaVersion: "remo.decision.absent.v1", state: "unknown" });
        else writeJson(response, 200, value);
        return true;
      }
      if (request.method !== "POST" || (candidate === null && durable?.[2] !== "decision-revisions")) { drain(request); writeJson(response, 405, { error: "decision.method-rejected" }); return true; }
      if (request.headers.origin !== origin.origin) { drain(request); writeJson(response, 403, { error: "decision.origin-rejected" }); return true; }
      if (!sameToken(request.headers["x-remo-session-token"] as string | undefined, options.sessionToken)) { drain(request); writeJson(response, 401, { error: "decision.session-token-required" }); return true; }
      if (request.headers["transfer-encoding"] !== undefined) { drain(request); writeJson(response, 400, { error: "decision.transfer-encoding-rejected" }); return true; }
      if (typeof request.headers["content-type"] !== "string" || !JSON_CONTENT_TYPE.test(request.headers["content-type"])) { drain(request); writeJson(response, 415, { error: "decision.json-required" }); return true; }
      if (typeof request.headers["idempotency-key"] !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(request.headers["idempotency-key"])) { drain(request); writeJson(response, 400, { error: "decision.idempotency-key-required" }); return true; }
      try {
        const body = object(await readBoundedJson(request, MAX_BODY_BYTES));
        if (candidate !== null) {
          exactKeys(body, ["expectedCandidateRevision", "expectedCandidateManifestDigest", "decisionId", "content"]);
          validateCandidateContent(body.content);
          const result = options.service.createCandidate(candidate[1]!, body as unknown as Parameters<DecisionService["createCandidate"]>[1]);
          writeJson(response, 201, result);
        } else {
          const mutation = body.mutation;
          exactKeys(body, mutation === "confirm-inferred" ? ["expectedRevision", "mutation", "fields"] : body.evidenceComponentIds === undefined ? ["expectedRevision", "mutation", "changes"] : ["expectedRevision", "mutation", "changes", "evidenceComponentIds"]);
          if (!["confirm-inferred", "reconstructed-supplement", "correction"].includes(String(mutation))) throw new DecisionServiceError("decision.mutation-invalid", "Decision mutation is unsupported.", 400);
          validateRevisionBody(body);
          const result = options.service.revise(durable![1]!, body as unknown as DurableDecisionMutationRequest);
          writeJson(response, 201, result);
        }
      } catch (error) {
        if (error instanceof BoundedJsonError) {
          if (!response.destroyed) writeJson(response, error.code === "request-too-large" ? 413 : 400, { error: `decision.${error.code}` });
        } else if (error instanceof DecisionServiceError) writeJson(response, error.status, { error: error.code, message: error.message, retryable: error.status === 409 });
        else writeJson(response, 409, { error: "decision.action-failed", retryable: false });
      }
      return true;
    },
  };
}
