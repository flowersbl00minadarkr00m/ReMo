// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayEvidence } from "../evidence-media/evidence-media-client.js";
import { REPLAY_BOOTSTRAP_TYPE, REPLAY_PROTOCOL_VERSION, REPLAY_RUNTIME_ORIGIN, replayIdentity, replayIdentityKey, type ReplayRuntimeStatusMessage } from "./replay-protocol.js";
import { RrwebReplaySurface } from "./RrwebReplaySurface.js";
import { replayLifecycleSnapshot } from "./replay-lifecycle.js";

class FakePort {
  peer?: FakePort;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  closed = false;
  start = vi.fn();
  close = vi.fn(() => { this.closed = true; });
  postMessage = vi.fn((data: unknown) => { if (!this.closed) this.peer?.onmessage?.({ data } as MessageEvent); });
}

class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; createdChannels.push(this); }
}

const createdChannels: FakeMessageChannel[] = [];

const replay: ReplayEvidence = {
  schemaVersion: "remo.rrweb-replay.v1",
  savePointId: "01J000000000000000000000S5",
  componentId: "01J000000000000000000000T5:rrweb",
  revision: 3,
  manifestDigest: `sha256:${"a".repeat(64)}`,
  digest: `sha256:${"b".repeat(64)}`,
  capture: { origin: "http://127.0.0.1:4173", path: "/fixture/save-point", viewport: { width: 640, height: 360 }, startTime: 1_000, endTime: 2_000, durationMs: 1_000 },
  events: [{ type: 4, timestamp: 1_000 }, { type: 2, timestamp: 2_000 }],
};

function status(capability: string, commandId: number, state: ReplayRuntimeStatusMessage["state"], currentTimeMs: number): ReplayRuntimeStatusMessage {
  return { protocol: REPLAY_PROTOCOL_VERSION, type: "status", capability, identityKey: replayIdentityKey(replayIdentity(replay)), state, commandId, currentTimeMs, acknowledgedAt: performance.now(), ...(commandId === 0 ? { firstFrameMs: 40 } : {}) };
}

function frameRebuilt(capability: string) {
  return { protocol: REPLAY_PROTOCOL_VERSION, type: "frame-rebuilt", capability, identityKey: replayIdentityKey(replayIdentity(replay)), reconstructedElements: 42, visibleTextLength: 120 } as const;
}

function connectRuntime(runtimePort: FakePort, initialOverride: Partial<ReplayRuntimeStatusMessage> = {}): void {
  let capability = "";
  runtimePort.onmessage = ({ data: raw }) => {
    const message = raw as { readonly type: string; readonly capability: string; readonly commandId?: number; readonly atMs?: number };
    if (message.type === "initialize") {
      capability = message.capability;
      runtimePort.postMessage(frameRebuilt(capability));
    } else if (message.type === "confirm-painted-frame") {
      runtimePort.postMessage({ ...status(capability, 0, "paused", 0), ...initialOverride });
    } else if (message.type !== "destroy") {
      runtimePort.postMessage(status(capability, message.commandId!, message.type === "play" ? "playing" : message.type === "seek" && message.atMs === 1_000 ? "finished" : "paused", message.atMs ?? (message.type === "pause" ? 100 : 0)));
    }
  };
}

beforeEach(() => {
  createdChannels.length = 0;
  delete window.__REMO_REPLAY_LIFECYCLE__;
  delete window.__REMO_REPLAY_LIFECYCLE_COUNTERS__;
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0)));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("cross-origin bounded replay controller", () => {
  it("bootstraps one transferred port at exact 4176 and exposes only bounded commands", async () => {
    const samples = vi.fn();
    const failed = vi.fn();
    render(<RrwebReplaySurface replay={replay} onFailure={failed} onSample={samples} availability={{ state: "available", origin: REPLAY_RUNTIME_ORIGIN }} />);
    const iframe = screen.getByTitle("Isolated non-interactive historical replay") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe("http://127.0.0.1:4176/runtime");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    const posted = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((data: unknown, targetOrigin?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
      expect(data).toEqual({ type: REPLAY_BOOTSTRAP_TYPE, protocol: REPLAY_PROTOCOL_VERSION });
      expect(targetOrigin).toBe(REPLAY_RUNTIME_ORIGIN);
      expect(transfer).toHaveLength(1);
      const runtimePort = transfer![0] as unknown as FakePort;
      connectRuntime(runtimePort);
    });
    fireEvent.load(iframe);
    expect(await screen.findByText("Replay paused")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start replay" }));
    expect(await screen.findByText("Playing historical evidence")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.change(screen.getByRole("slider", { name: "Seek within replay" }), { target: { value: "1000" } });
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(samples.mock.calls.map(([sample]) => (sample as { command: string }).command)).toEqual(["play", "pause", "seek", "restart"]);
    expect(samples.mock.calls.every(([sample]) => (sample as { acknowledgedMs: number }).acknowledgedMs < 100)).toBe(true);
    expect(posted).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("fails closed on a wrong capability response", () => {
    const failed = vi.fn();
    render(<RrwebReplaySurface replay={replay} onFailure={failed} availability={{ state: "available", origin: REPLAY_RUNTIME_ORIGIN }} />);
    const iframe = screen.getByTitle("Isolated non-interactive historical replay") as HTMLIFrameElement;
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((_data: unknown, _target?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
      const runtimePort = transfer![0] as unknown as FakePort;
      runtimePort.onmessage = () => runtimePort.postMessage(frameRebuilt("A".repeat(43)));
    });
    fireEvent.load(iframe);
    expect(failed).toHaveBeenCalledWith("replay.protocol-failure");
  });

  it.each([
    ["identity or digest", { identityKey: "stale-identity" }],
    ["initial state", { state: "playing" }],
    ["out-of-range time", { currentTimeMs: 1_001 }],
    ["unexpected command id", { commandId: 7 }],
  ])("fails closed on a wrong %s response", async (_label, override) => {
    const failed = vi.fn();
    render(<RrwebReplaySurface replay={replay} onFailure={failed} availability={{ state: "available", origin: REPLAY_RUNTIME_ORIGIN }} />);
    const iframe = screen.getByTitle("Isolated non-interactive historical replay") as HTMLIFrameElement;
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((_data: unknown, _target?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
      const runtimePort = transfer![0] as unknown as FakePort;
      connectRuntime(runtimePort, override as Partial<ReplayRuntimeStatusMessage>);
    });
    fireEvent.load(iframe);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("replay.protocol-failure"));
    expect(createdChannels.at(-1)?.port1.closed).toBe(true);
  });

  it("times out and closes a runtime that never acknowledges initialization", () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    render(<RrwebReplaySurface replay={replay} onFailure={failed} availability={{ state: "available", origin: REPLAY_RUNTIME_ORIGIN }} />);
    const iframe = screen.getByTitle("Isolated non-interactive historical replay") as HTMLIFrameElement;
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => undefined);
    fireEvent.load(iframe);
    act(() => vi.advanceTimersByTime(3_001));
    expect(failed).toHaveBeenCalledWith("replay.timeout");
    expect(createdChannels.at(-1)?.port1.closed).toBe(true);
    vi.useRealTimers();
  });

  it("destroys the session when an established runtime frame reloads", async () => {
    const failed = vi.fn();
    render(<RrwebReplaySurface replay={replay} onFailure={failed} availability={{ state: "available", origin: REPLAY_RUNTIME_ORIGIN }} />);
    const iframe = screen.getByTitle("Isolated non-interactive historical replay") as HTMLIFrameElement;
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((_data: unknown, _target?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
      const runtimePort = transfer![0] as unknown as FakePort;
      connectRuntime(runtimePort);
    });
    fireEvent.load(iframe);
    expect(await screen.findByText("Replay paused")).toBeTruthy();
    fireEvent.load(iframe);
    expect(failed).toHaveBeenCalledWith("replay.runtime-loss");
  });

  it("projects listener unavailability without creating an iframe", () => {
    const failed = vi.fn();
    render(<RrwebReplaySurface replay={replay} onFailure={failed} availability={{ state: "listener-unavailable", origin: REPLAY_RUNTIME_ORIGIN, reasonCode: "replay.listener-unavailable" }} />);
    expect(failed).toHaveBeenCalledWith("replay.listener-unavailable");
    expect(screen.queryByTitle("Isolated non-interactive historical replay")).toBeNull();
  });

  it("starts paused for reduced motion and destroys the one-use port on unmount", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const view = render(<RrwebReplaySurface replay={replay} onFailure={vi.fn()} availability={{ state: "available", origin: REPLAY_RUNTIME_ORIGIN }} />);
    const iframe = screen.getByTitle("Isolated non-interactive historical replay") as HTMLIFrameElement;
    let runtimePort: FakePort | undefined;
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((_data: unknown, _target?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
      runtimePort = transfer![0] as unknown as FakePort;
      connectRuntime(runtimePort);
    });
    fireEvent.load(iframe);
    expect(screen.getByText(/Reduced-motion preference detected/u)).toBeTruthy();
    view.unmount();
    expect(runtimePort).toBeDefined();
    expect(createdChannels.at(-1)?.port1.closed).toBe(true);
  });

  it("returns every tracked controller resource to baseline across repeated mounts", async () => {
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const view = render(<RrwebReplaySurface replay={replay} onFailure={vi.fn()} availability={{ state: "available", origin: REPLAY_RUNTIME_ORIGIN }} />);
      const iframe = screen.getByTitle("Isolated non-interactive historical replay") as HTMLIFrameElement;
      vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((_data: unknown, _target?: string | WindowPostMessageOptions, transfer?: Transferable[]) => connectRuntime(transfer![0] as unknown as FakePort));
      fireEvent.load(iframe);
      expect(await screen.findByText("Replay paused")).toBeTruthy();
      const active = replayLifecycleSnapshot();
      expect(active).toMatchObject({ frames: 1, channels: 1, ports: 1, timers: 0, objectUrls: 0 });
      view.unmount();
      expect(replayLifecycleSnapshot()).toMatchObject({ frames: 0, channels: 0, ports: 0, players: 0, timers: 0, listeners: 0, objectUrls: 0, heapProxyResources: 0 });
    }
  });
});
