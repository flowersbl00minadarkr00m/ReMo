import type { ReplayEvidence } from "../evidence-media/evidence-media-client.js";

export const REPLAY_RUNTIME_ORIGIN = "http://127.0.0.1:4176" as const;
export const REPLAY_RUNTIME_PATH = "/runtime" as const;
export const REPLAY_PROTOCOL_VERSION = "remo.replay-runtime.v1" as const;
export const REPLAY_BOOTSTRAP_TYPE = "remo.replay.bootstrap" as const;
export const REPLAY_MAX_EVENT_BYTES = 4 * 1024 * 1024;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}:rrweb$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/u;

export type ReplayCommandName = "play" | "pause" | "seek" | "restart" | "destroy";
export type ReplayRuntimeState = "paused" | "playing" | "finished" | "destroyed";
export type ReplayRuntimeAvailability =
  | { readonly state: "available"; readonly origin: typeof REPLAY_RUNTIME_ORIGIN }
  | { readonly state: "listener-unavailable"; readonly origin: typeof REPLAY_RUNTIME_ORIGIN; readonly reasonCode: string };

export interface ReplayRuntimeIdentity {
  readonly savePointId: string;
  readonly componentId: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly digest: string;
}

export interface ReplayInitializeMessage {
  readonly protocol: typeof REPLAY_PROTOCOL_VERSION;
  readonly type: "initialize";
  readonly capability: string;
  readonly identity: ReplayRuntimeIdentity;
  readonly durationMs: number;
  readonly eventBytes: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly events: ReplayEvidence["events"];
}

export interface ReplayCommandMessage {
  readonly protocol: typeof REPLAY_PROTOCOL_VERSION;
  readonly type: ReplayCommandName;
  readonly capability: string;
  readonly identityKey: string;
  readonly commandId: number;
  readonly atMs?: number;
}

export interface ReplayRuntimeStatusMessage {
  readonly protocol: typeof REPLAY_PROTOCOL_VERSION;
  readonly type: "status";
  readonly capability: string;
  readonly identityKey: string;
  readonly state: ReplayRuntimeState;
  readonly commandId: number;
  readonly currentTimeMs: number;
  readonly acknowledgedAt: number;
  readonly firstFrameMs?: number;
}

export interface ReplayRuntimeFailureMessage {
  readonly protocol: typeof REPLAY_PROTOCOL_VERSION;
  readonly type: "failure";
  readonly capability: string;
  readonly identityKey: string;
  readonly reasonCode: string;
}

export interface ReplayRuntimeFrameRebuiltMessage {
  readonly protocol: typeof REPLAY_PROTOCOL_VERSION;
  readonly type: "frame-rebuilt";
  readonly capability: string;
  readonly identityKey: string;
  readonly reconstructedElements: number;
  readonly visibleTextLength: number;
}

export interface ReplayPaintConfirmationMessage {
  readonly protocol: typeof REPLAY_PROTOCOL_VERSION;
  readonly type: "confirm-painted-frame";
  readonly capability: string;
  readonly identityKey: string;
}

export interface ReplayCommandValidationContext {
  readonly capability: string;
  readonly identityKey: string;
  readonly durationMs: number;
  readonly lastCommandId: number;
  readonly state: ReplayRuntimeState;
  readonly destroyed: boolean;
}

declare global {
  interface Window {
    __REMO_REPLAY_RUNTIME__?: ReplayRuntimeAvailability;
  }
}

export function replayIdentity(evidence: ReplayEvidence): ReplayRuntimeIdentity {
  return {
    savePointId: evidence.savePointId,
    componentId: evidence.componentId,
    revision: evidence.revision,
    manifestDigest: evidence.manifestDigest,
    digest: evidence.digest,
  };
}

export function replayIdentityKey(identity: ReplayRuntimeIdentity): string {
  return `${identity.savePointId}:${identity.componentId}:${identity.revision}:${identity.manifestDigest}:${identity.digest}`;
}

export function replayEventBytes(events: ReplayEvidence["events"]): number {
  return new TextEncoder().encode(JSON.stringify(events)).byteLength;
}

export function isValidCapability(value: unknown): value is string {
  return typeof value === "string" && CAPABILITY.test(value);
}

export function isValidReplayIdentity(value: unknown): value is ReplayRuntimeIdentity {
  if (value === null || typeof value !== "object") return false;
  const identity = value as Partial<ReplayRuntimeIdentity>;
  return typeof identity.savePointId === "string" && ID.test(identity.savePointId)
    && typeof identity.componentId === "string" && COMPONENT_ID.test(identity.componentId)
    && Number.isSafeInteger(identity.revision) && Number(identity.revision) > 0
    && typeof identity.manifestDigest === "string" && DIGEST.test(identity.manifestDigest)
    && typeof identity.digest === "string" && DIGEST.test(identity.digest);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

export function isTrustedReplayBootstrap(event: Pick<MessageEvent, "data" | "origin" | "ports" | "source">, expectedParent: MessageEventSource, connected: boolean): boolean {
  if (connected || event.origin !== "http://127.0.0.1:4175" || event.source !== expectedParent || event.ports.length !== 1 || event.data === null || typeof event.data !== "object") return false;
  const data = event.data as Record<string, unknown>;
  return hasExactKeys(data, ["protocol", "type"]) && data.type === REPLAY_BOOTSTRAP_TYPE && data.protocol === REPLAY_PROTOCOL_VERSION;
}

export function isValidReplayInitializeMessage(value: unknown, initialized = false): value is ReplayInitializeMessage {
  if (initialized || value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (!hasExactKeys(message, ["capability", "durationMs", "eventBytes", "events", "identity", "protocol", "type", "viewport"])
    || message.protocol !== REPLAY_PROTOCOL_VERSION || message.type !== "initialize" || !isValidCapability(message.capability) || !isValidReplayIdentity(message.identity)) return false;
  if (!Number.isFinite(message.durationMs) || Number(message.durationMs) < 0 || !Number.isSafeInteger(message.eventBytes) || Number(message.eventBytes) < 1 || Number(message.eventBytes) > REPLAY_MAX_EVENT_BYTES) return false;
  const viewport = message.viewport as { readonly width?: unknown; readonly height?: unknown } | null;
  if (viewport === null || typeof viewport !== "object" || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || Number(viewport.width) < 1 || Number(viewport.height) < 1 || Number(viewport.width) > 16_384 || Number(viewport.height) > 16_384) return false;
  if (!Array.isArray(message.events) || message.events.length < 2 || replayEventBytes(message.events as ReplayEvidence["events"]) !== message.eventBytes) return false;
  const timestamps: number[] = [];
  for (const raw of message.events) {
    if (raw === null || typeof raw !== "object") return false;
    const event = raw as { readonly type?: unknown; readonly timestamp?: unknown; readonly data?: unknown };
    if (!Number.isSafeInteger(event.type) || Number(event.type) < 0 || Number(event.type) > 4 || !Number.isFinite(event.timestamp) || Number(event.timestamp) < 0 || (event.type === 3 && (event.data as { readonly source?: unknown } | undefined)?.source === 9)) return false;
    timestamps.push(Number(event.timestamp));
  }
  return Math.max(...timestamps) - Math.min(...timestamps) === message.durationMs;
}

export function isValidReplayCommandMessage(value: unknown, context: ReplayCommandValidationContext): value is ReplayCommandMessage {
  if (context.destroyed || value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  const type = String(message.type);
  const expectsTime = type === "seek";
  if (!hasExactKeys(message, expectsTime ? ["atMs", "capability", "commandId", "identityKey", "protocol", "type"] : ["capability", "commandId", "identityKey", "protocol", "type"])) return false;
  if (message.protocol !== REPLAY_PROTOCOL_VERSION || !["play", "pause", "seek", "restart", "destroy"].includes(type) || message.capability !== context.capability || message.identityKey !== context.identityKey || !Number.isSafeInteger(message.commandId) || Number(message.commandId) <= context.lastCommandId) return false;
  if (expectsTime && (!Number.isFinite(message.atMs) || Number(message.atMs) < 0 || Number(message.atMs) > context.durationMs)) return false;
  if (type === "play" && context.state !== "paused" && context.state !== "finished") return false;
  if (type === "pause" && context.state !== "playing") return false;
  return true;
}

export function isValidReplayPaintConfirmationMessage(value: unknown, context: { readonly capability: string; readonly identityKey: string; readonly frameRebuilt: boolean; readonly confirmed: boolean; readonly destroyed: boolean }): value is ReplayPaintConfirmationMessage {
  if (context.destroyed || !context.frameRebuilt || context.confirmed || value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return hasExactKeys(message, ["capability", "identityKey", "protocol", "type"])
    && message.protocol === REPLAY_PROTOCOL_VERSION
    && message.type === "confirm-painted-frame"
    && message.capability === context.capability
    && message.identityKey === context.identityKey;
}

export function isReplayRuntimeMessage(value: unknown): value is ReplayRuntimeStatusMessage | ReplayRuntimeFailureMessage | ReplayRuntimeFrameRebuiltMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.protocol !== REPLAY_PROTOCOL_VERSION || !isValidCapability(message.capability) || typeof message.identityKey !== "string") return false;
  if (message.type === "failure") return hasExactKeys(message, ["capability", "identityKey", "protocol", "reasonCode", "type"]) && typeof message.reasonCode === "string" && /^replay\.[a-z0-9-]+$/u.test(message.reasonCode);
  if (message.type === "frame-rebuilt") return hasExactKeys(message, ["capability", "identityKey", "protocol", "reconstructedElements", "type", "visibleTextLength"])
    && Number.isSafeInteger(message.reconstructedElements) && Number(message.reconstructedElements) > 0
    && Number.isSafeInteger(message.visibleTextLength) && Number(message.visibleTextLength) > 0;
  return hasExactKeys(message, message.firstFrameMs === undefined ? ["acknowledgedAt", "capability", "commandId", "currentTimeMs", "identityKey", "protocol", "state", "type"] : ["acknowledgedAt", "capability", "commandId", "currentTimeMs", "firstFrameMs", "identityKey", "protocol", "state", "type"])
    && message.type === "status"
    && ["paused", "playing", "finished", "destroyed"].includes(String(message.state))
    && Number.isSafeInteger(message.commandId) && Number(message.commandId) >= 0
    && Number.isFinite(message.currentTimeMs) && Number(message.currentTimeMs) >= 0
    && Number.isFinite(message.acknowledgedAt)
    && (message.firstFrameMs === undefined || (Number.isFinite(message.firstFrameMs) && Number(message.firstFrameMs) >= 0));
}

export function createReplayCapability(cryptoSource: Crypto = crypto): string {
  const bytes = new Uint8Array(32);
  cryptoSource.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
