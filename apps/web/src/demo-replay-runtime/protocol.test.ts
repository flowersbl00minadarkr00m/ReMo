import { describe, expect, it } from "vitest";
import {
  HOSTED_REPLAY_BOOTSTRAP_TYPE,
  HOSTED_REPLAY_FRAME_ID,
  HOSTED_REPLAY_PARENT_ID,
  HOSTED_REPLAY_PROTOCOL_VERSION,
  hostedReplayIdentityKey,
  isHostedReplayRuntimeMessage,
  isTrustedHostedReplayBootstrap,
  isValidHostedReplayCommand,
  isValidHostedReplayInitialize,
  type HostedReplayBinding,
} from "./protocol.js";

const digest = `sha256:${"b".repeat(64)}`;
const binding: HostedReplayBinding = {
  parentId: HOSTED_REPLAY_PARENT_ID,
  frameId: HOSTED_REPLAY_FRAME_ID,
  fixtureRevision: "rel001-fixture-2026-08-20",
  mediaId: "turn-4-rrweb",
  digest,
};
const capability = "a".repeat(43);
const source = {} as WindowProxy;
const port = {} as MessagePort;

function bootstrap(overrides: Record<string, unknown> = {}, options: { readonly origin?: string; readonly source?: MessageEventSource | null; readonly ports?: readonly MessagePort[] } = {}): MessageEvent {
  return {
    origin: options.origin ?? "https://demo.invalid",
    source: options.source === undefined ? source : options.source,
    ports: options.ports === undefined ? [port] : [...options.ports],
    data: {
      protocol: HOSTED_REPLAY_PROTOCOL_VERSION,
      type: HOSTED_REPLAY_BOOTSTRAP_TYPE,
      ...binding,
      ...overrides,
    },
  } as unknown as MessageEvent;
}

describe("hosted demo replay protocol", () => {
  it("accepts only the exact same-origin parent, source, single port, revision, media identity, and digest", () => {
    const context = { expectedSource: source, expectedOrigin: "https://demo.invalid", expectedBinding: binding, connected: false };
    expect(isTrustedHostedReplayBootstrap(bootstrap(), context)).toBe(true);
    expect(isTrustedHostedReplayBootstrap(bootstrap({}, { origin: "https://other.invalid" }), context)).toBe(false);
    expect(isTrustedHostedReplayBootstrap(bootstrap({}, { source: {} as WindowProxy }), context)).toBe(false);
    expect(isTrustedHostedReplayBootstrap(bootstrap({}, { ports: [] }), context)).toBe(false);
    expect(isTrustedHostedReplayBootstrap(bootstrap({}, { ports: [port, port] }), context)).toBe(false);
    expect(isTrustedHostedReplayBootstrap(bootstrap({ fixtureRevision: "other" }), context)).toBe(false);
    expect(isTrustedHostedReplayBootstrap(bootstrap({ mediaId: "other" }), context)).toBe(false);
    expect(isTrustedHostedReplayBootstrap(bootstrap({ digest: `sha256:${"c".repeat(64)}` }), context)).toBe(false);
    expect(isTrustedHostedReplayBootstrap(bootstrap(), { ...context, connected: true })).toBe(false);
  });

  it("initializes from binding metadata only and rejects arbitrary events, URLs, markup, and extra keys", () => {
    const message = { protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "initialize", capability, ...binding };
    expect(isValidHostedReplayInitialize(message, binding, false)).toBe(true);
    expect(isValidHostedReplayInitialize({ ...message, events: [] }, binding, false)).toBe(false);
    expect(isValidHostedReplayInitialize({ ...message, url: "/other.json" }, binding, false)).toBe(false);
    expect(isValidHostedReplayInitialize({ ...message, html: "<p>other</p>" }, binding, false)).toBe(false);
    expect(isValidHostedReplayInitialize({ ...message, digest: `sha256:${"c".repeat(64)}` }, binding, false)).toBe(false);
    expect(isValidHostedReplayInitialize(message, binding, true)).toBe(false);
  });

  it("accepts only sequential bounded play, pause, seek, restart, resume, and destroy commands", () => {
    const identityKey = hostedReplayIdentityKey(binding);
    const context = { capability, identityKey, durationMs: 2_000, lastCommandId: 3, state: "paused" as const, destroyed: false };
    for (const type of ["play", "restart", "resume", "destroy"] as const) {
      expect(isValidHostedReplayCommand({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type, capability, identityKey, commandId: 4 }, context)).toBe(true);
    }
    expect(isValidHostedReplayCommand({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "seek", capability, identityKey, commandId: 4, atMs: 1_250 }, context)).toBe(true);
    expect(isValidHostedReplayCommand({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "seek", capability, identityKey, commandId: 4, atMs: 2_001 }, context)).toBe(false);
    expect(isValidHostedReplayCommand({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "pause", capability, identityKey, commandId: 4 }, context)).toBe(false);
    expect(isValidHostedReplayCommand({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "play", capability, identityKey, commandId: 3 }, context)).toBe(false);
    expect(isValidHostedReplayCommand({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "play", capability: "b".repeat(43), identityKey, commandId: 4 }, context)).toBe(false);
  });

  it("binds every runtime acknowledgment and failure to the exact fixture identity", () => {
    const identityKey = hostedReplayIdentityKey(binding);
    expect(isHostedReplayRuntimeMessage({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "status", capability, identityKey, state: "paused", commandId: 0, currentTimeMs: 0, acknowledgedAt: 1, eventCount: 3, durationMs: 2_000 }, { capability, identityKey, durationMs: 2_000 })).toBe(true);
    expect(isHostedReplayRuntimeMessage({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "failure", capability, identityKey, reasonCode: "hosted-replay.fixture-digest-mismatch" }, { capability, identityKey, durationMs: 2_000 })).toBe(true);
    expect(isHostedReplayRuntimeMessage({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "status", capability, identityKey: `${identityKey}:other`, state: "paused", commandId: 0, currentTimeMs: 0, acknowledgedAt: 1, eventCount: 3, durationMs: 2_000 }, { capability, identityKey, durationMs: 2_000 })).toBe(false);
  });
});
