// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://demo.invalid/replay/demo-save-04" }
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayEvidence } from "../evidence-media/evidence-media-client.js";
import { replayLifecycleSnapshot } from "../replay-player/replay-lifecycle.js";
import {
  HOSTED_REPLAY_BOOTSTRAP_TYPE,
  HOSTED_REPLAY_PROTOCOL_VERSION,
  hostedReplayIdentityKey,
  type HostedReplayBinding,
  type HostedReplayRuntimeStatusMessage,
} from "../../demo-replay-runtime/protocol.js";
import { HOSTED_DEMO_MEDIA_MANIFEST } from "./hosted-demo-media.js";
import { HostedDemoReplaySurface } from "./HostedDemoReplaySurface.js";

class FakePort {
  peer?: FakePort;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  closed = false;
  readonly messages: unknown[] = [];
  start = vi.fn();
  close = vi.fn(() => { this.closed = true; });
  postMessage = vi.fn((data: unknown) => {
    this.messages.push(data);
    if (!this.closed) this.peer?.onmessage?.({ data } as MessageEvent);
  });
}

class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; channels.push(this); }
}

const channels: FakeMessageChannel[] = [];
const manifest = HOSTED_DEMO_MEDIA_MANIFEST;
const injectedBinding = Object.freeze({ fixtureRevision: manifest.fixtureRevision, replay: manifest.replay });
const binding: HostedReplayBinding = { parentId: "hosted-demo-parent", frameId: "turn-4-replay-frame", fixtureRevision: manifest.fixtureRevision, mediaId: "turn-4-rrweb", digest: manifest.replay.digest };
const replay: ReplayEvidence = {
  schemaVersion: "remo.rrweb-replay.v1",
  savePointId: manifest.identity.savePointId,
  componentId: manifest.replay.componentId,
  revision: manifest.identity.revision,
  manifestDigest: manifest.identity.manifestDigest,
  digest: manifest.replay.digest,
  capture: { origin: "Synthetic hosted demonstration", path: "Turn 4", viewport: manifest.replay.viewport, startTime: manifest.replay.startTime, endTime: manifest.replay.endTime, durationMs: manifest.replay.durationMs },
  events: [{ type: 4, timestamp: manifest.replay.startTime }, { type: 2, timestamp: manifest.replay.startTime + 1 }, { type: 3, timestamp: manifest.replay.startTime + 2 }, { type: 3, timestamp: manifest.replay.endTime }],
};

function status(capability: string, commandId: number, state: HostedReplayRuntimeStatusMessage["state"], currentTimeMs: number): HostedReplayRuntimeStatusMessage {
  return { protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "status", capability, identityKey: hostedReplayIdentityKey(binding), state, commandId, currentTimeMs, acknowledgedAt: performance.now(), eventCount: manifest.replay.eventCount, durationMs: manifest.replay.durationMs, firstFrameMs: 32 };
}

function connectRuntime(runtimePort: FakePort, options: { readonly wrongIdentity?: boolean; readonly deferCommands?: boolean } = {}): void {
  let capability = "";
  runtimePort.onmessage = ({ data: raw }) => {
    const message = raw as { readonly type: string; readonly capability: string; readonly commandId?: number; readonly atMs?: number };
    if (message.type === "initialize") {
      capability = message.capability;
      const initial = status(capability, 0, "paused", 0);
      runtimePort.postMessage(options.wrongIdentity ? { ...initial, identityKey: `${initial.identityKey}:wrong` } : initial);
      return;
    }
    if (options.deferCommands) return;
    const state = message.type === "play" || message.type === "resume" ? "playing" : message.type === "destroy" ? "destroyed" : message.type === "seek" && message.atMs === manifest.replay.durationMs ? "finished" : "paused";
    const currentTimeMs = message.type === "pause" ? 400 : message.atMs ?? 0;
    runtimePort.postMessage(status(capability, message.commandId!, state, currentTimeMs));
  };
}

function loadSurface(options: { readonly wrongIdentity?: boolean; readonly deferCommands?: boolean } = {}) {
  const failed = vi.fn();
  const samples = vi.fn();
  const view = render(<HostedDemoReplaySurface replayBinding={injectedBinding} replay={replay} onFailure={failed} onSample={samples} />);
  const iframe = screen.getByTitle<HTMLIFrameElement>("Isolated same-origin synthetic replay");
  expect(iframe.hasAttribute("sandbox")).toBe(false);
  const frameWindow = iframe.contentWindow;
  if (frameWindow === null) throw new TypeError("Hosted replay frame window is unavailable in the test environment.");
  const posted = vi.spyOn(frameWindow, "postMessage").mockImplementation((data: unknown, target?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
    expect(data).toEqual({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: HOSTED_REPLAY_BOOTSTRAP_TYPE, ...binding });
    expect(target).toBe(window.location.origin);
    expect(transfer).toHaveLength(1);
    connectRuntime(transfer![0] as unknown as FakePort, options);
  });
  fireEvent.load(iframe);
  return { failed, iframe, posted, samples, view };
}

function FailureUnmountHarness({ failed }: { readonly failed: ReturnType<typeof vi.fn> }) {
  const [active, setActive] = useState(true);
  return active ? <HostedDemoReplaySurface replayBinding={injectedBinding} replay={replay} onFailure={(reason) => { failed(reason); setActive(false); }} /> : null;
}

beforeEach(() => {
  channels.length = 0;
  delete window.__REMO_REPLAY_LIFECYCLE__;
  delete window.__REMO_REPLAY_LIFECYCLE_COUNTERS__;
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("hosted demo replay surface", () => {
  it("acknowledges play, pause, resume, seek, and restart over one fixed same-origin port", async () => {
    const { failed, posted, samples } = loadSurface();
    expect(await screen.findByText("Replay paused")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start replay" }));
    expect(await screen.findByText("Playing synthetic historical evidence")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(screen.getByRole("button", { name: "Resume replay" }));
    await user.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.change(screen.getByRole("slider", { name: "Seek within replay" }), { target: { value: String(manifest.replay.durationMs) } });
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(samples.mock.calls.map(([sample]) => (sample as { command: string }).command)).toEqual(["play", "pause", "resume", "pause", "seek", "restart"]);
    expect(posted).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("fails closed on a wrong runtime binding", async () => {
    const { failed } = loadSurface({ wrongIdentity: true });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("replay.protocol-failure"));
    expect(channels.at(-1)?.port1.closed).toBe(true);
  });

  it("fails closed instead of bypassing a divergent injected bundle replay binding", () => {
    const failed = vi.fn();
    const divergentBinding = Object.freeze({
      fixtureRevision: injectedBinding.fixtureRevision,
      replay: Object.freeze({ ...injectedBinding.replay, digest: `sha256:${"0".repeat(64)}` }),
    });

    render(<HostedDemoReplaySurface replayBinding={divergentBinding} replay={replay} onFailure={failed} />);

    expect(failed).toHaveBeenCalledWith("replay.protocol-failure");
  });

  it("allows at most one pending command and times it out closed", () => {
    vi.useFakeTimers();
    const { failed } = loadSurface({ deferCommands: true });
    void act(() => undefined);
    const button = screen.getByRole("button", { name: "Start replay" });
    fireEvent.click(button);
    fireEvent.click(button);
    const runtimeMessages = channels.at(-1)!.port1.messages as { readonly type?: string }[];
    expect(runtimeMessages.filter(({ type }) => type === "play")).toHaveLength(1);
    void act(() => vi.advanceTimersByTime(1_001));
    expect(failed).toHaveBeenCalledWith("replay.timeout");
  });

  it("arms the no-load watchdog before runtime navigation and releases every resource", () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    render(<FailureUnmountHarness failed={failed} />);
    expect(screen.getByTitle("Isolated same-origin synthetic replay").getAttribute("src")).toBe("/demo-replay.html");
    void act(() => vi.advanceTimersByTime(3_001));
    expect(failed).toHaveBeenCalledWith("replay.timeout");
    expect(screen.queryByTitle("Isolated same-origin synthetic replay")).toBeNull();
    expect(replayLifecycleSnapshot()).toMatchObject({ frames: 0, channels: 0, ports: 0, timers: 0, listeners: 0 });
  });

  it("fails and unmounts immediately when a cross-origin location read throws SecurityError", () => {
    const failed = vi.fn();
    render(<FailureUnmountHarness failed={failed} />);
    const iframe = screen.getByTitle<HTMLIFrameElement>("Isolated same-origin synthetic replay");
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { get location(): Location { throw new DOMException("Blocked cross-origin access", "SecurityError"); } },
    });
    expect(() => fireEvent.load(iframe)).not.toThrow();
    expect(failed).toHaveBeenCalledWith("replay.runtime-loss");
    expect(screen.queryByTitle("Isolated same-origin synthetic replay")).toBeNull();
    expect(replayLifecycleSnapshot()).toMatchObject({ frames: 0, channels: 0, ports: 0, timers: 0, listeners: 0 });
  });

  it("settles an existing command before sending the sole destroy during navigation", () => {
    vi.useFakeTimers();
    const { view } = loadSurface({ deferCommands: true });
    void act(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Start replay" }));
    expect(replayLifecycleSnapshot().timers).toBe(1);
    view.unmount();
    const commands = (channels.at(-1)!.port1.messages as { readonly type?: string }[]).map(({ type }) => type).filter((type) => type !== "initialize");
    expect(commands).toEqual(["play", "destroy"]);
    expect(replayLifecycleSnapshot()).toMatchObject({ frames: 0, channels: 1, ports: 1, timers: 1, listeners: 1 });
    void act(() => vi.advanceTimersByTime(251));
    expect(channels.at(-1)?.port1.closed).toBe(true);
    expect(replayLifecycleSnapshot()).toMatchObject({ frames: 0, channels: 0, ports: 0, timers: 0, listeners: 0 });
  });

  it("starts paused under reduced motion and settles destroy before closing resources", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const { view } = loadSurface();
    expect(await screen.findByText("Replay paused")).toBeTruthy();
    expect(screen.getByText(/Reduced-motion preference detected/u)).toBeTruthy();
    expect((channels.at(-1)!.port1.messages as { readonly type?: string }[]).filter(({ type }) => type === "play")).toHaveLength(0);
    view.unmount();
    expect((channels.at(-1)!.port1.messages as { readonly type?: string }[]).some(({ type }) => type === "destroy")).toBe(true);
    expect(channels.at(-1)?.port1.closed).toBe(true);
    expect(replayLifecycleSnapshot()).toMatchObject({ frames: 0, channels: 0, ports: 0, timers: 0, listeners: 0 });
  });
});
