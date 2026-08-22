import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadReplayRuntimeAssets, type ReplayRuntimeAsset, type ReplayRuntimeAssets } from "./runtime-assets.js";

export const REPLAY_RUNTIME_PORT = 4176 as const;
export const REPLAY_RUNTIME_ORIGIN = "http://127.0.0.1:4176" as const;
export const REPLAY_PARENT_ORIGIN = "http://127.0.0.1:4175" as const;
export const REPLAY_RUNTIME_PATH = "/runtime" as const;

export type ReplayRuntimeAvailability =
  | { readonly state: "available"; readonly origin: typeof REPLAY_RUNTIME_ORIGIN }
  | { readonly state: "listener-unavailable"; readonly origin: typeof REPLAY_RUNTIME_ORIGIN; readonly reasonCode: string };

export interface ReplayRuntimeServer {
  readonly availability: ReplayRuntimeAvailability;
  readonly close: () => Promise<void>;
}

export function replayRuntimeSecurityHeaders(contentType: string): Readonly<Record<string, string>> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src data: blob:",
      "connect-src 'none'",
      "frame-src 'self'",
      "font-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${REPLAY_PARENT_ORIGIN}`,
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=()",
    "cross-origin-resource-policy": "same-site",
  };
}

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store", "x-content-type-options": "nosniff" }).end();
}

function requestAsset(request: IncomingMessage, assets: ReplayRuntimeAssets): ReplayRuntimeAsset | { readonly bytes: Buffer; readonly contentType: string } | undefined {
  if (request.url === REPLAY_RUNTIME_PATH) return { bytes: assets.document, contentType: "text/html; charset=utf-8" };
  return request.url === undefined || request.url.includes("?") || request.url.includes("#") ? undefined : assets.assets.get(request.url);
}

function handleRequest(request: IncomingMessage, response: ServerResponse, assets: ReplayRuntimeAssets): void {
  if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== `127.0.0.1:${REPLAY_RUNTIME_PORT}`) { reject(response, 403); return; }
  if (request.method !== "GET") { reject(response, 405); return; }
  if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) { reject(response, 400); return; }
  if (request.headers.cookie !== undefined || request.headers.authorization !== undefined || request.headers["proxy-authorization"] !== undefined) { reject(response, 403); return; }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== REPLAY_RUNTIME_ORIGIN) { reject(response, 403); return; }
  const asset = requestAsset(request, assets);
  if (asset === undefined) { reject(response, 404); return; }
  response.writeHead(200, replayRuntimeSecurityHeaders(asset.contentType)).end(asset.bytes);
}

function closedServer(server: Server): Promise<void> {
  return new Promise((resolve, rejectClose) => {
    server.close((error) => error === undefined ? resolve() : rejectClose(error));
    server.closeAllConnections();
  });
}

export async function startReplayRuntime(options: { readonly webRoot: string }): Promise<ReplayRuntimeServer> {
  let assets: ReplayRuntimeAssets;
  try { assets = loadReplayRuntimeAssets(options.webRoot); }
  catch { return { availability: { state: "listener-unavailable", origin: REPLAY_RUNTIME_ORIGIN, reasonCode: "replay.runtime-assets-unavailable" }, close: () => Promise.resolve() }; }
  const server = createServer({ maxHeaderSize: 8 * 1024 }, (request, response) => handleRequest(request, response, assets));
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  try {
    await new Promise<void>((resolve, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(REPLAY_RUNTIME_PORT, "127.0.0.1", () => { server.off("error", rejectListen); resolve(); });
    });
  } catch {
    server.closeAllConnections();
    return { availability: { state: "listener-unavailable", origin: REPLAY_RUNTIME_ORIGIN, reasonCode: "replay.listener-unavailable" }, close: () => Promise.resolve() };
  }
  let closing: Promise<void> | undefined;
  return { availability: { state: "available", origin: REPLAY_RUNTIME_ORIGIN }, close: () => closing ??= closedServer(server) };
}
