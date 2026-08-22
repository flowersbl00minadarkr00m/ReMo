export const RRWEB_REPLAY_SCHEMA = "remo.rrweb-replay.v1" as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["clipboardData", "dataTransfer", "files", "rawKey", "http-equiv"]);
const URL_KEYS = new Set(["src", "srcset", "href", "xlink:href", "action", "formaction", "poster"]);
const FORBIDDEN_TAGS = new Set(["script", "iframe", "frame", "object", "embed", "canvas", "form", "base", "link", "img", "picture", "audio", "video", "source", "track"]);

export type EvidenceMediaFailureState = "replay-unavailable" | "corrupt" | "digest-mismatch" | "unsafe-content";

export class EvidenceMediaClientError extends Error {
  readonly state: EvidenceMediaFailureState;
  readonly reasonCode: string;
  constructor(state: EvidenceMediaFailureState, reasonCode: string) {
    super(reasonCode);
    this.name = "EvidenceMediaClientError";
    this.state = state;
    this.reasonCode = reasonCode;
  }
}

export interface EvidenceMediaIdentity {
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly manifestDigest: string;
}

export interface ScreenshotEvidence {
  readonly blob: Blob;
  readonly digest: string;
  readonly componentId: string;
  readonly width: number;
  readonly height: number;
}

export interface ReplayEvent {
  readonly type: number;
  readonly timestamp: number;
  readonly data?: unknown;
}

export interface ReplayEvidence {
  readonly schemaVersion: typeof RRWEB_REPLAY_SCHEMA;
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
  readonly events: readonly ReplayEvent[];
}

export interface EvidenceMediaClient {
  screenshot(identity: EvidenceMediaIdentity, signal: AbortSignal): Promise<ScreenshotEvidence>;
  replay(identity: EvidenceMediaIdentity, signal: AbortSignal): Promise<ReplayEvidence>;
}

function exactLoopbackOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value || origin.username !== "" || origin.password !== "") throw new TypeError("Evidence media requires the exact IPv4 loopback origin.");
  return origin;
}

function assertIdentity(identity: EvidenceMediaIdentity): void {
  if (!ID.test(identity.savePointId) || !ID.test(identity.turnId) || !Number.isSafeInteger(identity.revision) || identity.revision < 1 || !DIGEST.test(identity.manifestDigest)) throw new TypeError("Evidence media identity is invalid.");
}

function header(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (value === null) throw new EvidenceMediaClientError("corrupt", "media.response-binding-missing");
  return value;
}

function validateBindings(response: Response, identity: EvidenceMediaIdentity, role: "screenshot" | "rrweb"): { readonly digest: string; readonly componentId: string } {
  const digest = header(response, "x-remo-evidence-digest");
  const componentId = header(response, "x-remo-component-id");
  if (header(response, "x-remo-save-point-id") !== identity.savePointId || componentId !== `${identity.turnId}:${role}` || header(response, "x-remo-manifest-revision") !== String(identity.revision) || header(response, "x-remo-manifest-digest") !== identity.manifestDigest) throw new EvidenceMediaClientError("digest-mismatch", "media.identity-mismatch");
  if (!DIGEST.test(digest)) throw new EvidenceMediaClientError("digest-mismatch", "media.digest-mismatch");
  return { digest, componentId };
}

async function responseFailure(response: Response): Promise<never> {
  let reasonCode = `media.http-${response.status}`;
  try {
    const body = await response.json() as { readonly reasonCode?: unknown };
    if (typeof body.reasonCode === "string") reasonCode = body.reasonCode;
  } catch { /* The status remains the honest fallback. */ }
  const state: EvidenceMediaFailureState = reasonCode.includes("digest") || reasonCode.includes("identity") || reasonCode.includes("mismatch")
    ? "digest-mismatch"
    : reasonCode.includes("security") || reasonCode.includes("unsafe")
      ? "unsafe-content"
      : reasonCode.includes("rrweb-invalid") || reasonCode.includes("corrupt") || reasonCode.includes("png-invalid")
      ? "corrupt"
      : "replay-unavailable";
  throw new EvidenceMediaClientError(state, reasonCode);
}

function unsafeUrl(value: string, captureUrl: string): boolean {
  if (value === captureUrl) return false;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return normalized !== "" && (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:") || normalized.startsWith("http:") || normalized.startsWith("https:") || normalized.startsWith("//") || normalized.startsWith("blob:") || normalized.startsWith("data:text/html") || normalized.startsWith("data:image/svg"));
}

function unsafeReplayValue(value: unknown, captureUrl: string, parentKey?: string): boolean {
  if (Array.isArray(value)) return value.some((child) => unsafeReplayValue(child, captureUrl, parentKey));
  if (typeof value === "string") {
    if (value.includes("REMO_SECRET_CANARY_V1")) return true;
    if (parentKey === "tagName" && FORBIDDEN_TAGS.has(value.toLocaleLowerCase("en-US"))) return true;
    if (parentKey !== undefined && URL_KEYS.has(parentKey.toLocaleLowerCase("en-US")) && unsafeUrl(value, captureUrl)) return true;
    return /(?:url\s*\(|@import|expression\s*\()/iu.test(value);
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEYS.has(key) || /^on[a-z]+$/iu.test(key) || unsafeReplayValue(child, captureUrl, key));
}

export function validateReplayEnvelope(value: unknown, identity: EvidenceMediaIdentity, digest: string, componentId: string): ReplayEvidence {
  if (value === null || typeof value !== "object") throw new EvidenceMediaClientError("corrupt", "media.rrweb-invalid");
  const envelope = value as Partial<ReplayEvidence>;
  if (envelope.schemaVersion !== RRWEB_REPLAY_SCHEMA || envelope.savePointId !== identity.savePointId || envelope.componentId !== componentId || envelope.revision !== identity.revision || envelope.manifestDigest !== identity.manifestDigest || envelope.digest !== digest) throw new EvidenceMediaClientError("digest-mismatch", "media.identity-mismatch");
  const capture = envelope.capture;
  if (capture === undefined || capture.origin !== "http://127.0.0.1:4173" || capture.path !== "/fixture/save-point" || !Number.isSafeInteger(capture.viewport?.width) || !Number.isSafeInteger(capture.viewport?.height) || capture.viewport.width < 1 || capture.viewport.height < 1 || !Number.isFinite(capture.startTime) || !Number.isFinite(capture.endTime) || !Number.isFinite(capture.durationMs) || capture.endTime < capture.startTime || capture.durationMs !== capture.endTime - capture.startTime || !Array.isArray(envelope.events) || envelope.events.length < 2) throw new EvidenceMediaClientError("corrupt", "media.rrweb-invalid");
  const captureUrl = `${capture.origin}${capture.path}`;
  for (const raw of envelope.events as readonly unknown[]) {
    if (raw === null || typeof raw !== "object") throw new EvidenceMediaClientError("corrupt", "media.rrweb-security-rejected");
    const event = raw as Partial<ReplayEvent>;
    if (!Number.isSafeInteger(event.type) || Number(event.type) < 0 || Number(event.type) > 4 || !Number.isFinite(event.timestamp) || Number(event.timestamp) < capture.startTime || Number(event.timestamp) > capture.endTime || (event.type === 3 && (event.data as { readonly source?: unknown } | undefined)?.source === 9) || unsafeReplayValue(event.data, captureUrl)) throw new EvidenceMediaClientError("corrupt", "media.rrweb-security-rejected");
  }
  return envelope as ReplayEvidence;
}

export function createEvidenceMediaClient(options: { readonly origin: string; readonly sessionToken: string; readonly fetcher?: typeof fetch }): EvidenceMediaClient {
  const origin = exactLoopbackOrigin(options.origin);
  if (options.sessionToken.length < 32) throw new TypeError("Evidence media session token is missing.");
  const fetcher = options.fetcher ?? fetch;
  const request = (identity: EvidenceMediaIdentity, role: "screenshot" | "rrweb", signal: AbortSignal) => {
    assertIdentity(identity);
    return fetcher(`${origin.origin}/api/save-points/${encodeURIComponent(identity.savePointId)}/media/${role}`, { method: "GET", credentials: "same-origin", headers: { "x-remo-session-token": options.sessionToken }, signal });
  };
  return {
    async screenshot(identity, signal) {
      const response = await request(identity, "screenshot", signal);
      if (!response.ok) return responseFailure(response);
      if (response.headers.get("content-type") !== "image/png") throw new EvidenceMediaClientError("corrupt", "media.png-invalid");
      const bindings = validateBindings(response, identity, "screenshot");
      const width = Number(header(response, "x-remo-viewport-width"));
      const height = Number(header(response, "x-remo-viewport-height"));
      const bytes = await response.arrayBuffer();
      const signature = new Uint8Array(bytes.slice(0, 8));
      if (bytes.byteLength < 24 || bytes.byteLength > MAX_BYTES || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || signature.join(",") !== "137,80,78,71,13,10,26,10") throw new EvidenceMediaClientError("corrupt", "media.png-invalid");
      return { blob: new Blob([bytes], { type: "image/png" }), digest: bindings.digest, componentId: bindings.componentId, width, height };
    },
    async replay(identity, signal) {
      const response = await request(identity, "rrweb", signal);
      if (!response.ok) return responseFailure(response);
      if (!response.headers.get("content-type")?.startsWith("application/json")) throw new EvidenceMediaClientError("corrupt", "media.rrweb-invalid");
      const bindings = validateBindings(response, identity, "rrweb");
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BYTES * 2) throw new EvidenceMediaClientError("corrupt", "media.rrweb-invalid");
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new EvidenceMediaClientError("corrupt", "media.rrweb-invalid"); }
      return validateReplayEnvelope(value, identity, bindings.digest, bindings.componentId);
    },
  };
}
