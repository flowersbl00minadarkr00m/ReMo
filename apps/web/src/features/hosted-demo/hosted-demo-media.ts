import {
  EvidenceMediaClientError,
  RRWEB_REPLAY_SCHEMA,
  type EvidenceMediaClient,
  type EvidenceMediaIdentity,
  type ReplayEvent,
  type ReplayEvidence,
} from "../evidence-media/evidence-media-client.js";
import type { HostedDemoFixtureBundle } from "./hosted-demo-fixture.js";
import {
  HOSTED_DEMO_MEDIA_MANIFEST,
  type HostedDemoReplayManifestEntry,
  type HostedDemoScreenshotManifestEntry,
} from "./hosted-demo-fixture-source.js";

export { HOSTED_DEMO_MEDIA_MANIFEST, HOSTED_DEMO_TURN_5_SCREENSHOT_MANIFEST } from "./hosted-demo-fixture-source.js";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const FORBIDDEN_KEYS = new Set(["clipboardData", "dataTransfer", "files", "rawKey", "http-equiv"]);
const URL_KEYS = new Set(["src", "srcset", "href", "xlink:href", "action", "formaction", "poster"]);
const FORBIDDEN_TAGS = new Set(["script", "iframe", "frame", "object", "embed", "canvas", "form", "base", "link", "img", "picture", "audio", "video", "source", "track"]);
const FORBIDDEN_STRING = /(?:REMO_SECRET_CANARY_V1|(?:https?|wss?):\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0|(?:[A-Za-z]:[\\/])|(?:^|\s)\/(?:Users|home|tmp|var)\/|javascript:|vbscript:|data:text\/html|data:image\/svg|url\s*\(|@import|expression\s*\()/iu;
const SHA256_ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

export type HostedDemoReplayAsset = Readonly<{
  events: readonly ReplayEvent[];
  text: string;
}>;

function sameIdentity(identity: EvidenceMediaIdentity, expected: EvidenceMediaIdentity): boolean {
  return identity.savePointId === expected.savePointId
    && identity.turnId === expected.turnId
    && identity.revision === expected.revision
    && identity.manifestDigest === expected.manifestDigest;
}

function screenshotManifest(fixture: HostedDemoFixtureBundle, identity: EvidenceMediaIdentity): HostedDemoScreenshotManifestEntry {
  const match = fixture.media.find((entry): entry is HostedDemoScreenshotManifestEntry => entry.kind === "screenshot" && sameIdentity(identity, entry));
  if (match !== undefined) return match;
  throw new EvidenceMediaClientError("digest-mismatch", "media.identity-mismatch");
}

const requestInit = (signal: AbortSignal): RequestInit => ({
  method: "GET",
  credentials: "omit",
  mode: "same-origin",
  redirect: "error",
  referrerPolicy: "no-referrer",
  signal,
});

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

export function sha256HostedDemoBytes(input: ArrayBuffer): string {
  const source = new Uint8Array(input);
  const bitLength = source.byteLength * 8;
  const paddedLength = Math.ceil((source.byteLength + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.byteLength] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + SHA256_ROUND[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0; hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0; hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
  }
  return `sha256:${[...hash].map((word) => word.toString(16).padStart(8, "0")).join("")}`;
}

async function readBoundAsset(fetcher: typeof fetch, path: string, mediaType: string, byteLength: number, expectedDigest: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetcher(path, requestInit(signal));
  if (!response.ok) throw new EvidenceMediaClientError("replay-unavailable", `media.http-${response.status}`);
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== mediaType) throw new EvidenceMediaClientError("corrupt", "media.content-type-invalid");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== byteLength) throw new EvidenceMediaClientError("digest-mismatch", "media.byte-length-mismatch");
  if (sha256HostedDemoBytes(bytes) !== expectedDigest) throw new EvidenceMediaClientError("digest-mismatch", "media.digest-mismatch");
  return bytes;
}

export function validateHostedDemoPng(input: ArrayBuffer, expectedWidth: number, expectedHeight: number): void {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new EvidenceMediaClientError("corrupt", "media.png-invalid");
  }
  const view = new DataView(input);
  const ihdr = bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82;
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const validBitDepth = (colorType === 0 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16))
    || (colorType === 2 && (bitDepth === 8 || bitDepth === 16))
    || (colorType === 3 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8))
    || ((colorType === 4 || colorType === 6) && (bitDepth === 8 || bitDepth === 16));
  if (view.getUint32(8, false) !== 13 || !ihdr || !validBitDepth || bytes[26] !== 0 || bytes[27] !== 0 || (bytes[28] !== 0 && bytes[28] !== 1)) {
    throw new EvidenceMediaClientError("corrupt", "media.png-invalid");
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0 || width !== expectedWidth || height !== expectedHeight) {
    throw new EvidenceMediaClientError("corrupt", "media.png-dimensions-mismatch");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsafeReplayValue(value: unknown, parentKey?: string): boolean {
  if (Array.isArray(value)) return value.some((child) => unsafeReplayValue(child, parentKey));
  if (typeof value === "string") {
    if (parentKey === "href" && value === "about:blank") return false;
    if (parentKey === "tagName" && FORBIDDEN_TAGS.has(value.toLocaleLowerCase("en-US"))) return true;
    if (parentKey !== undefined && URL_KEYS.has(parentKey.toLocaleLowerCase("en-US")) && value.trim() !== "") return true;
    return FORBIDDEN_STRING.test(value);
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEYS.has(key) || /^on[a-z]+$/iu.test(key) || unsafeReplayValue(child, key));
}

export function validateHostedReplayEvents(value: unknown, manifest: HostedDemoReplayManifestEntry = HOSTED_DEMO_MEDIA_MANIFEST.replay): readonly ReplayEvent[] {
  if (!Array.isArray(value) || value.length !== manifest.eventCount) throw new EvidenceMediaClientError("corrupt", "media.rrweb-event-count-mismatch");
  let previous = -Infinity;
  for (const raw of value) {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.type) || Number(raw.type) < 0 || Number(raw.type) > 4 || !Number.isFinite(raw.timestamp) || Number(raw.timestamp) < previous || Number(raw.timestamp) < manifest.startTime || Number(raw.timestamp) > manifest.endTime || unsafeReplayValue(raw.data)) {
      throw new EvidenceMediaClientError("unsafe-content", "media.rrweb-security-rejected");
    }
    previous = Number(raw.timestamp);
  }
  const events = value as unknown as readonly ReplayEvent[];
  const meta = events[0];
  const snapshot = events.find(({ type }) => type === 2);
  if (meta?.type !== 4 || !isRecord(meta.data) || meta.data.href !== "about:blank" || meta.data.width !== manifest.viewport.width || meta.data.height !== manifest.viewport.height || snapshot === undefined) {
    throw new EvidenceMediaClientError("corrupt", "media.rrweb-invalid");
  }
  return Object.freeze(structuredClone(events));
}

export async function loadHostedReplayAsset(signal: AbortSignal, fetcher: typeof fetch = fetch, manifest: HostedDemoReplayManifestEntry = HOSTED_DEMO_MEDIA_MANIFEST.replay): Promise<HostedDemoReplayAsset> {
  const bytes = await readBoundAsset(fetcher, manifest.path, manifest.mediaType, manifest.byteLength, manifest.digest, signal);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new EvidenceMediaClientError("corrupt", "media.rrweb-invalid"); }
  return Object.freeze({ events: validateHostedReplayEvents(value, manifest), text });
}

export function createHostedDemoEvidenceMediaClient(fixture: HostedDemoFixtureBundle, options: { readonly fetcher?: typeof fetch } = {}): EvidenceMediaClient {
  const fetcher = options.fetcher ?? fetch;
  const replayManifest = fixture.media.find((entry): entry is HostedDemoReplayManifestEntry => entry.kind === "replay");
  if (replayManifest === undefined) throw new TypeError("Hosted demo replay manifest is unavailable.");
  const replayIdentity: EvidenceMediaIdentity = { savePointId: replayManifest.savePointId, turnId: replayManifest.turnId, revision: replayManifest.revision, manifestDigest: replayManifest.manifestDigest };
  return {
    async screenshot(identity, signal) {
      const manifest = screenshotManifest(fixture, identity);
      const bytes = await readBoundAsset(fetcher, manifest.path, manifest.mediaType, manifest.byteLength, manifest.digest, signal);
      validateHostedDemoPng(bytes, manifest.width, manifest.height);
      return { blob: new Blob([bytes], { type: manifest.mediaType }), digest: manifest.digest, componentId: manifest.componentId, width: manifest.width, height: manifest.height };
    },
    async replay(identity, signal): Promise<ReplayEvidence> {
      if (!sameIdentity(identity, replayIdentity)) throw new EvidenceMediaClientError("digest-mismatch", "media.identity-mismatch");
      const manifest = replayManifest;
      const asset = await loadHostedReplayAsset(signal, fetcher, manifest);
      return Object.freeze({
        schemaVersion: RRWEB_REPLAY_SCHEMA,
        savePointId: replayManifest.savePointId,
        componentId: manifest.componentId,
        revision: replayManifest.revision,
        manifestDigest: replayManifest.manifestDigest,
        digest: manifest.digest,
        capture: Object.freeze({ origin: "Synthetic hosted demonstration", path: "Turn 4", viewport: manifest.viewport, startTime: manifest.startTime, endTime: manifest.endTime, durationMs: manifest.durationMs }),
        events: asset.events,
      });
    },
  };
}
