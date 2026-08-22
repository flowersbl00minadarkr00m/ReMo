import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface TypedBoundaryRequest { readonly kind: "decision" | "human-intervention" | "verification"; readonly boundaryId: string; readonly occurredAt: string }
export type TurnSettlement = { readonly status: "candidate" | "no-candidate"; readonly [key: string]: unknown };
export interface SettlingTurn { stop(boundaries: readonly TypedBoundaryRequest[]): Promise<TurnSettlement> }
export interface TurnControlApi { readonly sessionToken: string; register(turnId: string, turn: SettlingTurn): void; handle(request: IncomingMessage, response: ServerResponse): Promise<void> }

const MAX_BODY_BYTES = 32 * 1024;

function exactLoopbackOrigin(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new Error("Turn control requires one exact IPv4 loopback Origin.");
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
function parseBoundaries(value: unknown): readonly TypedBoundaryRequest[] {
  if (typeof value !== "object" || value === null || !("boundaries" in value) || !Array.isArray(value.boundaries)) throw new Error("invalid-boundaries");
  return value.boundaries.map((boundary: unknown) => {
    if (typeof boundary !== "object" || boundary === null) throw new Error("invalid-boundary");
    const candidate = boundary as Partial<TypedBoundaryRequest>;
    if (!(["decision", "human-intervention", "verification"] as const).includes(candidate.kind as never)
      || typeof candidate.boundaryId !== "string" || candidate.boundaryId.length === 0 || candidate.boundaryId.length > 128
      || typeof candidate.occurredAt !== "string" || !Number.isFinite(Date.parse(candidate.occurredAt))) throw new Error("invalid-boundary");
    return { kind: candidate.kind, boundaryId: candidate.boundaryId, occurredAt: candidate.occurredAt } as TypedBoundaryRequest;
  });
}

export function createTurnControlApi({ allowedOrigin }: { readonly allowedOrigin: string }): TurnControlApi {
  const origin = exactLoopbackOrigin(allowedOrigin);
  const sessionToken = randomBytes(32).toString("base64url");
  const turns = new Map<string, SettlingTurn>();
  return {
    sessionToken,
    register(turnId, turn) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(turnId) || turns.has(turnId)) throw new Error("Turn identity must be unique and URL-safe.");
      turns.set(turnId, turn);
    },
    async handle(request, response) {
      if (request.socket.remoteAddress !== "127.0.0.1") { writeJson(response, 403, { error: "loopback-required" }); return; }
      if (request.headers.origin !== origin) { writeJson(response, 403, { error: "origin-rejected" }); return; }
      if (!sameToken(request.headers["x-remo-session-token"] as string | undefined, sessionToken)) { writeJson(response, 401, { error: "session-token-required" }); return; }
      if (request.method !== "POST" || !request.headers["content-type"]?.toLowerCase().startsWith("application/json")) { writeJson(response, 415, { error: "json-post-required" }); return; }
      const match = /^\/api\/turns\/([A-Za-z0-9_-]{1,128})\/stop$/u.exec(request.url ?? "");
      if (match === null) { writeJson(response, 404, { error: "unknown-route" }); return; }
      const turn = turns.get(match[1] ?? "");
      if (turn === undefined) { writeJson(response, 404, { error: "unknown-turn" }); return; }
      try {
        const boundaries = parseBoundaries(await readJson(request));
        writeJson(response, 200, await turn.stop(boundaries));
      } catch {
        writeJson(response, 409, { error: "stop-not-confirmed" });
      }
    },
  };
}
