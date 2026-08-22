// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceMediaClientError, type EvidenceMediaClient, type EvidenceMediaIdentity, type ReplayEvidence, type ScreenshotEvidence } from "./evidence-media-client.js";

vi.mock("../replay-player/RrwebReplaySurface.js", () => ({
  RrwebReplaySurface: ({ onFailure }: { readonly onFailure: (reasonCode: "replay.player-failure") => void }) => <div aria-label="validated replay"><button type="button" onClick={() => onFailure("replay.player-failure")}>Simulate player failure</button></div>,
}));

import { EvidenceMediaPanel } from "./EvidenceMediaPanel.js";

const identity: EvidenceMediaIdentity = { savePointId: "01J000000000000000000000S5", turnId: "01J000000000000000000000T5", revision: 3, manifestDigest: `sha256:${"a".repeat(64)}` };
const screenshot: ScreenshotEvidence = { blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }), digest: `sha256:${"b".repeat(64)}`, componentId: `${identity.turnId}:screenshot`, width: 640, height: 360 };
const replay: ReplayEvidence = { schemaVersion: "remo.rrweb-replay.v1", savePointId: identity.savePointId, componentId: `${identity.turnId}:rrweb`, revision: 3, manifestDigest: identity.manifestDigest, digest: `sha256:${"c".repeat(64)}`, capture: { origin: "http://127.0.0.1:4173", path: "/fixture/save-point", viewport: { width: 640, height: 360 }, startTime: 1_000, endTime: 1_020, durationMs: 20 }, events: [{ type: 4, timestamp: 1_000 }, { type: 2, timestamp: 1_020 }] };
const revokeObjectUrl = vi.fn();

function availableClient(): EvidenceMediaClient {
  return { screenshot: vi.fn(() => Promise.resolve(screenshot)), replay: vi.fn(() => Promise.resolve(replay)) };
}

beforeEach(() => {
  revokeObjectUrl.mockClear();
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:captured-screenshot"), revokeObjectURL: revokeObjectUrl });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("actual evidence media panel", () => {
  it("renders the actual object-backed PNG with capture identity and validated replay", async () => {
    render(<EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable client={availableClient()} />);
    const image = await screen.findByRole("img", { name: /Privacy-checked captured UI.*640 by 360/u });
    expect(image.getAttribute("src")).toBe("blob:captured-screenshot");
    expect(screen.getByText(`${identity.turnId}:screenshot`)).toBeTruthy();
    expect(await screen.findByLabelText("validated replay")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/masked preview/iu);
  });

  it.each([
    ["replay-unavailable", "Replay unavailable"],
    ["corrupt", "Replay evidence is corrupt"],
    ["digest-mismatch", "Replay identity or digest mismatch"],
  ] as const)("retains the valid screenshot in the truthful %s state", async (state, heading) => {
    const client: EvidenceMediaClient = { screenshot: vi.fn(() => Promise.resolve(screenshot)), replay: vi.fn(() => Promise.reject(new EvidenceMediaClientError(state, `media.${state}`))) };
    render(<EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable client={client} />);
    expect(await screen.findByRole("img")).toBeTruthy();
    expect(await screen.findByText(heading)).toBeTruthy();
    expect(screen.getByText("Screenshot only")).toBeTruthy();
  });

  it("destroys the replay surface on player failure while retaining the screenshot", async () => {
    render(<EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable client={availableClient()} />);
    expect(await screen.findByRole("img")).toBeTruthy();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Simulate player failure" }));
    expect(screen.getByText("Replay player failed safely")).toBeTruthy();
    expect(screen.getByRole("img")).toBeTruthy();
    expect(screen.queryByLabelText("validated replay")).toBeNull();
  });

  it("offers hosted mode a bounded retry that reloads only the fixed replay client", async () => {
    const replayRequest = vi.fn()
      .mockRejectedValueOnce(new EvidenceMediaClientError("replay-unavailable", "media.runtime-missing"))
      .mockResolvedValueOnce(replay);
    const client: EvidenceMediaClient = { screenshot: vi.fn(() => Promise.resolve(screenshot)), replay: replayRequest };
    const ReplaySurface = () => <div aria-label="hosted replay recovered" />;
    render(<EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable client={client} presentationMode="hosted-demo" replaySurface={ReplaySurface} />);
    expect(await screen.findByRole("img")).toBeTruthy();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Retry replay validation" }));
    expect(await screen.findByLabelText("hosted replay recovered")).toBeTruthy();
    expect(replayRequest).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry replay validation" })).toBeNull();
  });

  it("retains the screenshot and mounts a fresh hosted runtime after an in-frame failure and retry", async () => {
    const client = availableClient();
    let nextSurfaceId = 0;
    const surfaceIds: number[] = [];
    const ReplaySurface = ({ onFailure }: { readonly onFailure: (reason: "replay.runtime-loss") => void }) => {
      const [surfaceId] = useState(() => ++nextSurfaceId);
      surfaceIds.push(surfaceId);
      return <button type="button" onClick={() => onFailure("replay.runtime-loss")}>Fail hosted runtime {surfaceId}</button>;
    };
    render(<EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable client={client} presentationMode="hosted-demo" replaySurface={ReplaySurface} />);
    const image = await screen.findByRole("img");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Fail hosted runtime 1" }));
    expect(screen.getByRole("img")).toBe(image);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry replay validation" }));
    expect(await screen.findByRole("button", { name: "Fail hosted runtime 2" })).toBeTruthy();
    expect(screen.getByRole("img")).toBe(image);
    expect(client.replay).toHaveBeenCalledTimes(2);
    expect(surfaceIds).toContain(1);
    expect(surfaceIds).toContain(2);
  });

  it("never lets an out-of-order stale response replace the newly selected identity and revokes object URLs exactly", async () => {
    let resolveFirst!: (value: ScreenshotEvidence) => void;
    const first = new Promise<ScreenshotEvidence>((resolve) => { resolveFirst = resolve; });
    const secondIdentity = { ...identity, savePointId: "01J000000000000000000000S6", turnId: "01J000000000000000000000T6", manifestDigest: `sha256:${"d".repeat(64)}` };
    const secondScreenshot = { ...screenshot, componentId: `${secondIdentity.turnId}:screenshot` };
    const client: EvidenceMediaClient = {
      screenshot: vi.fn((selected: EvidenceMediaIdentity) => selected.savePointId === identity.savePointId ? first : Promise.resolve(secondScreenshot)),
      replay: vi.fn(() => Promise.reject(new EvidenceMediaClientError("replay-unavailable", "media.component-missing"))),
    };
    const view = render(<EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable={false} client={client} />);
    view.rerender(<EvidenceMediaPanel identity={secondIdentity} screenshotAvailable replayAvailable={false} client={client} />);
    expect(await screen.findByText(`${secondIdentity.turnId}:screenshot`)).toBeTruthy();
    await act(async () => { resolveFirst(screenshot); await first; });
    expect(screen.getByText(`${secondIdentity.turnId}:screenshot`)).toBeTruthy();
    expect(screen.queryByText(`${identity.turnId}:screenshot`)).toBeNull();
    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
  });

  it("aborts both media requests on identity cleanup", async () => {
    const signals: AbortSignal[] = [];
    const client: EvidenceMediaClient = {
      screenshot: vi.fn((_selected: EvidenceMediaIdentity, signal: AbortSignal) => { signals.push(signal); return new Promise<ScreenshotEvidence>(() => undefined); }),
      replay: vi.fn((_selected: EvidenceMediaIdentity, signal: AbortSignal) => { signals.push(signal); return new Promise<ReplayEvidence>(() => undefined); }),
    };
    const view = render(<EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable client={client} />);
    view.unmount();
    expect(signals).toHaveLength(2);
    await waitFor(() => expect(signals.every(({ aborted }) => aborted)).toBe(true));
  });

  it("shares pending screenshot and replay across the StrictMode probe and drains final cleanup", async () => {
    const signals: AbortSignal[] = [];
    const settled = vi.fn();
    const pending = <T,>(signal: AbortSignal) => new Promise<T>((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }).finally(settled);
    const client: EvidenceMediaClient = {
      screenshot: vi.fn((_selected, signal) => pending<ScreenshotEvidence>(signal)),
      replay: vi.fn((_selected, signal) => pending<ReplayEvidence>(signal)),
    };
    const view = render(<StrictMode><EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable client={client} /></StrictMode>);

    await waitFor(() => expect(signals).toHaveLength(2));
    expect(client.screenshot).toHaveBeenCalledTimes(1);
    expect(client.replay).toHaveBeenCalledTimes(1);
    expect(signals.every(({ aborted }) => !aborted)).toBe(true);
    view.unmount();
    await waitFor(() => expect(signals.every(({ aborted }) => aborted)).toBe(true));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
  });

  it("creates and revokes one screenshot object URL across a settled StrictMode probe", async () => {
    const client = availableClient();
    const view = render(<StrictMode><EvidenceMediaPanel identity={identity} screenshotAvailable replayAvailable client={client} /></StrictMode>);
    expect(await screen.findByRole("img")).toBeTruthy();
    expect(client.screenshot).toHaveBeenCalledTimes(1);
    expect(client.replay).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
  });
});
