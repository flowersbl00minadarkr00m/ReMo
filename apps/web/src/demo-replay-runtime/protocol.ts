export const HOSTED_REPLAY_PROTOCOL_VERSION = "remo.hosted-demo-replay.v1" as const;
export const HOSTED_REPLAY_BOOTSTRAP_TYPE = "remo.hosted-demo-replay.bootstrap" as const;
export const HOSTED_REPLAY_PARENT_ID = "hosted-demo-parent" as const;
export const HOSTED_REPLAY_FRAME_ID = "turn-4-replay-frame" as const;
export const HOSTED_REPLAY_FIXTURE_REVISION = "rel001-fixture-2026-08-20" as const;
export const HOSTED_REPLAY_MEDIA_ID = "turn-4-rrweb" as const;
export const HOSTED_REPLAY_RUNTIME_PATH = "/demo-replay.html" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/u;
const REASON_CODE = /^hosted-replay\.[a-z0-9-]+$/u;

export type HostedReplayCommandName = "play" | "pause" | "seek" | "restart" | "resume" | "destroy";
export type HostedReplayRuntimeState = "paused" | "playing" | "finished" | "destroyed";

export interface HostedReplayBinding {
  readonly parentId: typeof HOSTED_REPLAY_PARENT_ID;
  readonly frameId: typeof HOSTED_REPLAY_FRAME_ID;
  readonly fixtureRevision: typeof HOSTED_REPLAY_FIXTURE_REVISION;
  readonly mediaId: typeof HOSTED_REPLAY_MEDIA_ID;
  readonly digest: string;
}

export interface HostedReplayInitializeMessage extends HostedReplayBinding {
  readonly protocol: typeof HOSTED_REPLAY_PROTOCOL_VERSION;
  readonly type: "initialize";
  readonly capability: string;
}

export interface HostedReplayCommandMessage {
  readonly protocol: typeof HOSTED_REPLAY_PROTOCOL_VERSION;
  readonly type: HostedReplayCommandName;
  readonly capability: string;
  readonly identityKey: string;
  readonly commandId: number;
  readonly atMs?: number;
}

export interface HostedReplayRuntimeStatusMessage {
  readonly protocol: typeof HOSTED_REPLAY_PROTOCOL_VERSION;
  readonly type: "status";
  readonly capability: string;
  readonly identityKey: string;
  readonly state: HostedReplayRuntimeState;
  readonly commandId: number;
  readonly currentTimeMs: number;
  readonly acknowledgedAt: number;
  readonly eventCount: number;
  readonly durationMs: number;
  readonly firstFrameMs?: number;
}

export interface HostedReplayRuntimeFailureMessage {
  readonly protocol: typeof HOSTED_REPLAY_PROTOCOL_VERSION;
  readonly type: "failure";
  readonly capability: string;
  readonly identityKey: string;
  readonly reasonCode: string;
}

export type HostedReplayRuntimeMessage = HostedReplayRuntimeStatusMessage | HostedReplayRuntimeFailureMessage;

export interface HostedReplayCommandValidationContext {
  readonly capability: string;
  readonly identityKey: string;
  readonly durationMs: number;
  readonly lastCommandId: number;
  readonly state: HostedReplayRuntimeState;
  readonly destroyed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactBinding(value: Record<string, unknown>, expected: HostedReplayBinding): boolean {
  return value.parentId === expected.parentId
    && value.frameId === expected.frameId
    && value.fixtureRevision === expected.fixtureRevision
    && value.mediaId === expected.mediaId
    && value.digest === expected.digest
    && DIGEST.test(expected.digest);
}

export function hostedReplayIdentityKey(binding: HostedReplayBinding): string {
  return `${binding.parentId}:${binding.frameId}:${binding.fixtureRevision}:${binding.mediaId}:${binding.digest}`;
}

export function isTrustedHostedReplayBootstrap(event: MessageEvent, context: {
  readonly expectedSource: WindowProxy;
  readonly expectedOrigin: string;
  readonly expectedBinding: HostedReplayBinding;
  readonly connected: boolean;
}): boolean {
  if (context.connected || event.source !== context.expectedSource || event.origin !== context.expectedOrigin || event.ports.length !== 1 || !isRecord(event.data)) return false;
  return exactKeys(event.data, ["protocol", "type", "parentId", "frameId", "fixtureRevision", "mediaId", "digest"])
    && event.data.protocol === HOSTED_REPLAY_PROTOCOL_VERSION
    && event.data.type === HOSTED_REPLAY_BOOTSTRAP_TYPE
    && exactBinding(event.data, context.expectedBinding);
}

export function isValidHostedReplayInitialize(value: unknown, expected: HostedReplayBinding, initialized: boolean): value is HostedReplayInitializeMessage {
  if (initialized || !isRecord(value)) return false;
  return exactKeys(value, ["protocol", "type", "capability", "parentId", "frameId", "fixtureRevision", "mediaId", "digest"])
    && value.protocol === HOSTED_REPLAY_PROTOCOL_VERSION
    && value.type === "initialize"
    && typeof value.capability === "string"
    && CAPABILITY.test(value.capability)
    && exactBinding(value, expected);
}

export function isValidHostedReplayCommand(value: unknown, context: HostedReplayCommandValidationContext): value is HostedReplayCommandMessage {
  if (context.destroyed || context.state === "destroyed" || !isRecord(value) || value.protocol !== HOSTED_REPLAY_PROTOCOL_VERSION || typeof value.type !== "string") return false;
  const type = value.type as HostedReplayCommandName;
  const allowed = type === "play" || type === "pause" || type === "seek" || type === "restart" || type === "resume" || type === "destroy";
  if (!allowed) return false;
  const keys = type === "seek" ? ["protocol", "type", "capability", "identityKey", "commandId", "atMs"] : ["protocol", "type", "capability", "identityKey", "commandId"];
  if (!exactKeys(value, keys)
    || value.capability !== context.capability
    || value.identityKey !== context.identityKey
    || !Number.isSafeInteger(value.commandId)
    || Number(value.commandId) !== context.lastCommandId + 1) return false;
  if (type === "seek" && (!Number.isFinite(value.atMs) || Number(value.atMs) < 0 || Number(value.atMs) > context.durationMs)) return false;
  if (type === "pause") return context.state === "playing";
  if (type === "play") return context.state === "paused" || context.state === "finished";
  if (type === "resume") return context.state === "paused";
  return true;
}

export function isHostedReplayRuntimeMessage(value: unknown, context: { readonly capability: string; readonly identityKey: string; readonly durationMs: number }): value is HostedReplayRuntimeMessage {
  if (!isRecord(value)
    || value.protocol !== HOSTED_REPLAY_PROTOCOL_VERSION
    || value.capability !== context.capability
    || value.identityKey !== context.identityKey) return false;
  if (value.type === "failure") {
    return exactKeys(value, ["protocol", "type", "capability", "identityKey", "reasonCode"])
      && typeof value.reasonCode === "string"
      && REASON_CODE.test(value.reasonCode);
  }
  if (value.type !== "status") return false;
  const required = ["protocol", "type", "capability", "identityKey", "state", "commandId", "currentTimeMs", "acknowledgedAt", "eventCount", "durationMs"];
  const keys = value.firstFrameMs === undefined ? required : [...required, "firstFrameMs"];
  const validState = value.state === "paused" || value.state === "playing" || value.state === "finished" || value.state === "destroyed";
  return exactKeys(value, keys)
    && validState
    && Number.isSafeInteger(value.commandId)
    && Number(value.commandId) >= 0
    && Number.isFinite(value.currentTimeMs)
    && Number(value.currentTimeMs) >= 0
    && Number(value.currentTimeMs) <= context.durationMs
    && Number.isFinite(value.acknowledgedAt)
    && Number.isSafeInteger(value.eventCount)
    && Number(value.eventCount) >= 2
    && value.durationMs === context.durationMs
    && (value.firstFrameMs === undefined || (Number.isFinite(value.firstFrameMs) && Number(value.firstFrameMs) >= 0));
}

export function createHostedReplayCapability(cryptoValue: Crypto = crypto): string {
  const bytes = new Uint8Array(32);
  cryptoValue.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
