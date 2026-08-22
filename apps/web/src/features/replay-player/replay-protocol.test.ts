import { describe, expect, it } from "vitest";
import { REPLAY_BOOTSTRAP_TYPE, REPLAY_PROTOCOL_VERSION, createReplayCapability, isReplayRuntimeMessage, isTrustedReplayBootstrap, isValidReplayCommandMessage, isValidReplayIdentity, isValidReplayInitializeMessage, replayEventBytes } from "./replay-protocol.js";

const identity = { savePointId: "save", componentId: "turn:rrweb", revision: 1, manifestDigest: `sha256:${"a".repeat(64)}`, digest: `sha256:${"b".repeat(64)}` };
const events = [{ type: 4, timestamp: 1_000 }, { type: 2, timestamp: 2_000 }];
const capability = "A".repeat(43);

describe("replay protocol validation", () => {
  it("creates fixed-length URL-safe random capabilities", () => {
    const values = new Set(Array.from({ length: 20 }, () => createReplayCapability()));
    expect(values.size).toBe(20);
    expect([...values].every((value) => /^[A-Za-z0-9_-]{43}$/u.test(value))).toBe(true);
  });

  it("rejects incomplete identities and messages outside the closed vocabulary", () => {
    expect(isValidReplayIdentity(identity)).toBe(true);
    expect(isValidReplayIdentity({ ...identity, revision: 0 })).toBe(false);
    const common = { protocol: REPLAY_PROTOCOL_VERSION, capability: "A".repeat(43), identityKey: "identity" };
    expect(isReplayRuntimeMessage({ ...common, type: "status", state: "paused", commandId: 0, currentTimeMs: 0, acknowledgedAt: 1 })).toBe(true);
    expect(isReplayRuntimeMessage({ ...common, type: "navigate" })).toBe(false);
    expect(isReplayRuntimeMessage({ ...common, type: "failure", reasonCode: "javascript:alert(1)" })).toBe(false);
  });

  it("measures the exact transferred event serialization", () => {
    expect(replayEventBytes([{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }])).toBe(new TextEncoder().encode('[{"type":4,"timestamp":1},{"type":2,"timestamp":2}]').byteLength);
  });

  it("accepts only one exact parent bootstrap source, origin, window, version, and port", () => {
    const parent = {} as MessageEventSource;
    const port = {} as MessagePort;
    const valid = { data: { type: REPLAY_BOOTSTRAP_TYPE, protocol: REPLAY_PROTOCOL_VERSION }, origin: "http://127.0.0.1:4175", source: parent, ports: [port] };
    expect(isTrustedReplayBootstrap(valid, parent, false)).toBe(true);
    expect(isTrustedReplayBootstrap({ ...valid, origin: "http://localhost:4175" }, parent, false)).toBe(false);
    expect(isTrustedReplayBootstrap({ ...valid, source: {} as MessageEventSource }, parent, false)).toBe(false);
    expect(isTrustedReplayBootstrap({ ...valid, data: { ...valid.data, protocol: "wrong" } }, parent, false)).toBe(false);
    expect(isTrustedReplayBootstrap({ ...valid, data: { ...valid.data, extra: true } }, parent, false)).toBe(false);
    expect(isTrustedReplayBootstrap(valid, parent, true)).toBe(false);
  });

  it("rejects invalid initialize identity, digest shape, size, duration, event state, and duplicates", () => {
    const initialize = { protocol: REPLAY_PROTOCOL_VERSION, type: "initialize", capability, identity, durationMs: 1_000, eventBytes: replayEventBytes(events), viewport: { width: 640, height: 360 }, events };
    expect(isValidReplayInitializeMessage(initialize)).toBe(true);
    expect(isValidReplayInitializeMessage(initialize, true)).toBe(false);
    expect(isValidReplayInitializeMessage({ ...initialize, identity: { ...identity, digest: "sha256:wrong" } })).toBe(false);
    expect(isValidReplayInitializeMessage({ ...initialize, eventBytes: 4 * 1024 * 1024 + 1 })).toBe(false);
    expect(isValidReplayInitializeMessage({ ...initialize, durationMs: 999 })).toBe(false);
    expect(isValidReplayInitializeMessage({ ...initialize, events: [{ type: 4, timestamp: 1_000 }, { type: 3, timestamp: 2_000, data: { source: 9 } }], eventBytes: replayEventBytes([{ type: 4, timestamp: 1_000 }, { type: 3, timestamp: 2_000, data: { source: 9 } }]) })).toBe(false);
  });

  it("enforces capability, identity, monotonic IDs, state, range, and post-destroy command closure", () => {
    const context = { capability, identityKey: "identity", durationMs: 1_000, lastCommandId: 3, state: "paused" as const, destroyed: false };
    const play = { protocol: REPLAY_PROTOCOL_VERSION, type: "play", capability, identityKey: "identity", commandId: 4 };
    expect(isValidReplayCommandMessage(play, context)).toBe(true);
    expect(isValidReplayCommandMessage({ ...play, capability: "B".repeat(43) }, context)).toBe(false);
    expect(isValidReplayCommandMessage({ ...play, identityKey: "stale" }, context)).toBe(false);
    expect(isValidReplayCommandMessage({ ...play, commandId: 3 }, context)).toBe(false);
    expect(isValidReplayCommandMessage({ ...play, type: "pause" }, context)).toBe(false);
    expect(isValidReplayCommandMessage({ ...play, type: "seek", atMs: 1_001 }, context)).toBe(false);
    expect(isValidReplayCommandMessage(play, { ...context, destroyed: true })).toBe(false);
  });
});
