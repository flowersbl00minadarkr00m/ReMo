import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BundleManifest, EvidenceDescriptor, EvidenceMediaFailureReason, EvidenceMediaReader, EvidenceMediaRole, HistoryPage } from "@remo/domain";
import type { CurrentDurableSavePoint } from "@remo/storage-local";
import type { EvidenceMediaRouteHandler, EvidenceMediaRouteMatch } from "./mount.js";

const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RRWEB_SCHEMA_VERSION = "remo.rrweb-replay.v1";
const PRIVACY_CANARY = "REMO_SECRET_CANARY_V1";
const FORBIDDEN_KEYS = new Set(["clipboardData", "dataTransfer", "files", "rawKey", "http-equiv"]);
const URL_KEYS = new Set(["src", "srcset", "href", "xlink:href", "action", "formaction", "poster"]);
const FORBIDDEN_TAGS = new Set(["script", "iframe", "frame", "object", "embed", "canvas", "form", "base", "link", "img", "picture", "audio", "video", "source", "track"]);

export const EVIDENCE_DIGEST_HEADER = "x-remo-evidence-digest";
export const EVIDENCE_SAVE_POINT_HEADER = "x-remo-save-point-id";
export const EVIDENCE_COMPONENT_HEADER = "x-remo-component-id";
export const EVIDENCE_REVISION_HEADER = "x-remo-manifest-revision";
export const EVIDENCE_MANIFEST_HEADER = "x-remo-manifest-digest";

export type EvidenceMediaServiceFailure = EvidenceMediaFailureReason
  | "media.authentication-required"
  | "media.origin-rejected"
  | "media.method-not-allowed"
  | "media.identity-mismatch"
  | "media.png-invalid"
  | "media.rrweb-invalid"
  | "media.rrweb-security-rejected";

export interface EvidenceMediaAuthorityReader extends EvidenceMediaReader {
  listCurrentDurable(): readonly CurrentDurableSavePoint[];
  listHistory(): HistoryPage;
}

export interface RrwebReplayEnvelope {
  readonly schemaVersion: typeof RRWEB_SCHEMA_VERSION;
  readonly savePointId: string;
  readonly componentId: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly digest: string;
  readonly capture: {
    readonly origin: string;
    readonly path: string;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly startTime: number;
    readonly endTime: number;
    readonly durationMs: number;
  };
  readonly events: readonly RrwebEvent[];
}

interface RrwebEvent {
  readonly type: number;
  readonly timestamp: number;
  readonly data?: unknown;
}

interface MediaAuthority {
  readonly current: CurrentDurableSavePoint;
  readonly manifest: BundleManifest;
  readonly descriptor: EvidenceDescriptor;
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeFailure(response: ServerResponse, status: number, reasonCode: EvidenceMediaServiceFailure): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  }).end(JSON.stringify({ state: "unavailable", reasonCode }));
}

function failureStatus(reason: EvidenceMediaFailureReason): number {
  if (reason === "media.save-not-found") return 404;
  if (reason === "media.lifecycle-unavailable") return 410;
  if (reason === "media.quarantined") return 423;
  if (reason === "media.oversized") return 413;
  if (reason === "media.invalid-role") return 400;
  return 409;
}

function exactLoopbackHost(request: IncomingMessage, allowedOrigin: URL): boolean {
  if (request.socket.remoteAddress !== "127.0.0.1") return false;
  return request.headers.host === allowedOrigin.host;
}

function mediaAuthority(reader: EvidenceMediaAuthorityReader, match: EvidenceMediaRouteMatch): MediaAuthority | EvidenceMediaFailureReason | "media.identity-mismatch" {
  const current = reader.listCurrentDurable().find(({ receipt }) => receipt.savePointId === match.savePointId);
  if (current === undefined) {
    return reader.listHistory().anchors.some(({ savePointId }) => savePointId === match.savePointId)
      ? "media.lifecycle-unavailable"
      : "media.save-not-found";
  }
  if (current.lifecycle.state === "quarantined") return "media.quarantined";
  if (current.lifecycle.state !== "active") return "media.lifecycle-unavailable";
  const manifest = current.bundle as Partial<BundleManifest>;
  if (manifest.savePointId !== current.receipt.savePointId || manifest.correlation?.turnId !== current.receipt.turnId || !Array.isArray(manifest.evidence)) return "media.identity-mismatch";
  const descriptor = (manifest.evidence as readonly EvidenceDescriptor[]).find(({ componentType }) => componentType === match.role);
  if (descriptor === undefined || descriptor.availability !== "available" || descriptor.digest === undefined) return "media.component-missing";
  if (descriptor.componentId !== `${current.receipt.turnId}:${match.role}` || descriptor.correlation.turnId !== current.receipt.turnId) return "media.component-mismatch";
  return { current, manifest: manifest as BundleManifest, descriptor };
}

function pngViewport(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.byteLength < 24 || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 16_384 && height <= 16_384 ? { width, height } : undefined;
}

function hasUnsafeUrl(value: string, allowedCaptureUrl: string): boolean {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (value === allowedCaptureUrl) return false;
  return normalized !== "" && (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:") || normalized.startsWith("http:") || normalized.startsWith("https:") || normalized.startsWith("//") || normalized.startsWith("blob:") || normalized.startsWith("data:text/html") || normalized.startsWith("data:image/svg"));
}

function inspectReplayValue(value: unknown, allowedCaptureUrl: string, parentKey?: string): boolean {
  if (Array.isArray(value)) return value.some((child) => inspectReplayValue(child, allowedCaptureUrl, parentKey));
  if (typeof value === "string") {
    if (value.includes(PRIVACY_CANARY)) return true;
    if (parentKey === "tagName" && FORBIDDEN_TAGS.has(value.toLocaleLowerCase("en-US"))) return true;
    if (parentKey !== undefined && URL_KEYS.has(parentKey.toLocaleLowerCase("en-US")) && hasUnsafeUrl(value, allowedCaptureUrl)) return true;
    if (/(?:url\s*\(|@import|expression\s*\()/iu.test(value)) return true;
    return false;
  }
  if (value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || /^on[a-z]+$/iu.test(key)) return true;
    if (inspectReplayValue(child, allowedCaptureUrl, key)) return true;
  }
  return false;
}

export function validateRrwebBytes(bytes: Buffer, allowedCaptureUrl: string): RrwebReplayEnvelope["capture"] & { readonly events: readonly RrwebEvent[] } {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("media.rrweb-invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("media.rrweb-invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 2) throw new Error("media.rrweb-invalid");
  const events: RrwebEvent[] = [];
  let meta: { readonly href?: unknown; readonly width?: unknown; readonly height?: unknown } | undefined;
  for (const raw of parsed) {
    if (raw === null || typeof raw !== "object") throw new Error("media.rrweb-invalid");
    const event = raw as { readonly type?: unknown; readonly timestamp?: unknown; readonly data?: unknown };
    if (!Number.isSafeInteger(event.type) || Number(event.type) < 0 || Number(event.type) > 4 || !Number.isFinite(event.timestamp) || Number(event.timestamp) < 0) throw new Error("media.rrweb-invalid");
    if (Number(event.type) === 3 && (event.data as { readonly source?: unknown } | undefined)?.source === 9) throw new Error("media.rrweb-security-rejected");
    if (inspectReplayValue(event.data, allowedCaptureUrl)) throw new Error("media.rrweb-security-rejected");
    if (Number(event.type) === 4) {
      if (meta !== undefined) throw new Error("media.rrweb-invalid");
      meta = event.data as typeof meta;
    }
    events.push({ type: Number(event.type), timestamp: Number(event.timestamp), ...(event.data === undefined ? {} : { data: event.data }) });
  }
  const timestamps = events.map(({ timestamp }) => timestamp);
  const startTime = Math.min(...timestamps);
  const endTime = Math.max(...timestamps);
  const url = new URL(allowedCaptureUrl);
  if (meta?.href !== allowedCaptureUrl || !Number.isSafeInteger(meta.width) || !Number.isSafeInteger(meta.height) || Number(meta.width) < 1 || Number(meta.height) < 1 || Number(meta.width) > 16_384 || Number(meta.height) > 16_384 || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) throw new Error("media.rrweb-invalid");
  return {
    origin: url.origin,
    path: url.pathname,
    viewport: { width: Number(meta.width), height: Number(meta.height) },
    startTime,
    endTime,
    durationMs: endTime - startTime,
    events,
  };
}

export function safelyAvailableEvidenceMedia(options: {
  readonly reader: EvidenceMediaAuthorityReader;
  readonly savePointId: string;
  readonly allowedCaptureUrl: string;
}): ReadonlySet<EvidenceMediaRole> {
  const available = new Set<EvidenceMediaRole>();
  for (const role of ["screenshot", "rrweb"] as const) {
    const authority = mediaAuthority(options.reader, { savePointId: options.savePointId, role });
    if (typeof authority === "string") continue;
    const read = options.reader.readEvidenceMedia({
      savePointId: options.savePointId,
      componentId: authority.descriptor.componentId,
      role,
      expectedRevision: authority.current.revision.revision,
      expectedManifestDigest: authority.current.revision.manifestDigest,
      expectedDigest: authority.descriptor.digest!,
    });
    if (read.status === "unavailable" || read.byteSize !== read.bytes.byteLength || read.byteSize > MAX_MEDIA_BYTES || read.savePointId !== options.savePointId || read.componentId !== authority.descriptor.componentId || read.role !== role || read.digest !== authority.descriptor.digest) continue;
    if (role === "screenshot") {
      if (pngViewport(read.bytes) !== undefined) available.add(role);
      continue;
    }
    try { validateRrwebBytes(read.bytes, options.allowedCaptureUrl); available.add(role); }
    catch { /* Unsafe or malformed stored replay is not projected as safely available. */ }
  }
  return available;
}

export function createEvidenceMediaHandler(options: {
  readonly allowedOrigin: string;
  readonly allowedCaptureUrl: string;
  readonly sessionToken: string;
  readonly reader: EvidenceMediaAuthorityReader;
}): EvidenceMediaRouteHandler {
  const allowedOrigin = new URL(options.allowedOrigin);
  const allowedCaptureUrl = new URL(options.allowedCaptureUrl);
  if (allowedOrigin.protocol !== "http:" || allowedOrigin.hostname !== "127.0.0.1" || allowedOrigin.origin !== options.allowedOrigin) throw new TypeError("Evidence media requires the exact IPv4 loopback product origin.");
  if (allowedCaptureUrl.protocol !== "http:" || allowedCaptureUrl.hostname !== "127.0.0.1" || allowedCaptureUrl.search !== "" || allowedCaptureUrl.hash !== "") throw new TypeError("Evidence replay requires one exact IPv4 loopback capture URL.");
  if (options.sessionToken.length < 32) throw new TypeError("Evidence media requires an ephemeral session token.");

  return {
    handle(request, response, match) {
      if (request.method !== "GET") { writeFailure(response, 405, "media.method-not-allowed"); return true; }
      if (!exactLoopbackHost(request, allowedOrigin) || (request.headers.origin !== undefined && request.headers.origin !== allowedOrigin.origin) || (request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin")) {
        writeFailure(response, 403, "media.origin-rejected"); return true;
      }
      if (!sameToken(request.headers["x-remo-session-token"] as string | undefined, options.sessionToken)) { writeFailure(response, 401, "media.authentication-required"); return true; }
      const authority = mediaAuthority(options.reader, match);
      if (typeof authority === "string") { writeFailure(response, authority === "media.identity-mismatch" ? 409 : failureStatus(authority), authority); return true; }
      const read = options.reader.readEvidenceMedia({
        savePointId: match.savePointId,
        componentId: authority.descriptor.componentId,
        role: match.role,
        expectedRevision: authority.current.revision.revision,
        expectedManifestDigest: authority.current.revision.manifestDigest,
        expectedDigest: authority.descriptor.digest!,
      });
      if (read.status === "unavailable") { writeFailure(response, failureStatus(read.reasonCode), read.reasonCode); return true; }
      if (read.byteSize !== read.bytes.byteLength || read.byteSize > MAX_MEDIA_BYTES || read.savePointId !== match.savePointId || read.componentId !== authority.descriptor.componentId || read.role !== match.role || read.digest !== authority.descriptor.digest) {
        writeFailure(response, 409, "media.identity-mismatch"); return true;
      }
      const commonHeaders = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        [EVIDENCE_DIGEST_HEADER]: read.digest,
        [EVIDENCE_SAVE_POINT_HEADER]: read.savePointId,
        [EVIDENCE_COMPONENT_HEADER]: read.componentId,
        [EVIDENCE_REVISION_HEADER]: String(authority.current.revision.revision),
        [EVIDENCE_MANIFEST_HEADER]: authority.current.revision.manifestDigest,
      };
      if (match.role === "screenshot") {
        const viewport = pngViewport(read.bytes);
        if (viewport === undefined) { writeFailure(response, 409, "media.png-invalid"); return true; }
        response.writeHead(200, { ...commonHeaders, "content-type": "image/png", "content-length": String(read.bytes.byteLength), "x-remo-viewport-width": String(viewport.width), "x-remo-viewport-height": String(viewport.height) }).end(read.bytes);
        return true;
      }
      let replay: ReturnType<typeof validateRrwebBytes>;
      try { replay = validateRrwebBytes(read.bytes, allowedCaptureUrl.toString()); }
      catch (error) {
        const reason = error instanceof Error && error.message === "media.rrweb-security-rejected" ? "media.rrweb-security-rejected" : "media.rrweb-invalid";
        writeFailure(response, 409, reason); return true;
      }
      const envelope: RrwebReplayEnvelope = {
        schemaVersion: RRWEB_SCHEMA_VERSION,
        savePointId: read.savePointId,
        componentId: read.componentId,
        revision: authority.current.revision.revision,
        manifestDigest: authority.current.revision.manifestDigest,
        digest: read.digest,
        capture: { origin: replay.origin, path: replay.path, viewport: replay.viewport, startTime: replay.startTime, endTime: replay.endTime, durationMs: replay.durationMs },
        events: replay.events,
      };
      response.writeHead(200, { ...commonHeaders, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(envelope));
      return true;
    },
  };
}
