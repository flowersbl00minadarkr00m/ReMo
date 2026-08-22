import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";
import { adjustReplayLifecycle, installReplayLifecycleInstrumentation } from "../features/replay-player/replay-lifecycle.js";
import { HOSTED_DEMO_MEDIA_MANIFEST, loadHostedReplayAsset } from "../features/hosted-demo/hosted-demo-media.js";
import {
  HOSTED_REPLAY_FIXTURE_REVISION,
  HOSTED_REPLAY_FRAME_ID,
  HOSTED_REPLAY_MEDIA_ID,
  HOSTED_REPLAY_PARENT_ID,
  HOSTED_REPLAY_PROTOCOL_VERSION,
  hostedReplayIdentityKey,
  isTrustedHostedReplayBootstrap,
  isValidHostedReplayCommand,
  isValidHostedReplayInitialize,
  type HostedReplayBinding,
  type HostedReplayRuntimeFailureMessage,
  type HostedReplayRuntimeState,
  type HostedReplayRuntimeStatusMessage,
} from "./protocol.js";
import "./runtime.css";

const runtimeRoot = document.querySelector<HTMLElement>("#demo-replay-root");
if (runtimeRoot === null) throw new Error("Hosted replay runtime root is missing.");
const root: HTMLElement = runtimeRoot;
const binding: HostedReplayBinding = Object.freeze({
  parentId: HOSTED_REPLAY_PARENT_ID,
  frameId: HOSTED_REPLAY_FRAME_ID,
  fixtureRevision: HOSTED_REPLAY_FIXTURE_REVISION,
  mediaId: HOSTED_REPLAY_MEDIA_ID,
  digest: HOSTED_DEMO_MEDIA_MANIFEST.replay.digest,
});
const identityKey = hostedReplayIdentityKey(binding);
root.dataset.runtimeState = "waiting-bootstrap";
root.dataset.protocol = HOSTED_REPLAY_PROTOCOL_VERSION;
root.dataset.fixtureRevision = binding.fixtureRevision;
root.dataset.mediaId = binding.mediaId;
root.dataset.mediaDigest = binding.digest;
installReplayLifecycleInstrumentation();

let port: MessagePort | undefined;
let capability = "";
let player: Replayer | undefined;
let state: HostedReplayRuntimeState = "paused";
let lastCommandId = 0;
let destroyed = false;
let eventCount = 0;
let firstFrameMs: number | undefined;
let initializationStartedAt: number | undefined;
let bootstrapTimer: number | undefined;
let firstFrameTimer: number | undefined;
let loadController: AbortController | undefined;
let bootstrapListenerActive = false;
let rejectionListenerActive = false;
let pagehideListenerActive = false;
let portHandlersActive = false;
let playerHandlersActive = false;

function trackedTimeout(callback: () => void, milliseconds: number): number {
  adjustReplayLifecycle("timers", 1);
  return window.setTimeout(() => { adjustReplayLifecycle("timers", -1); callback(); }, milliseconds);
}

function clearTracked(timer: number | undefined): undefined {
  if (timer !== undefined) { window.clearTimeout(timer); adjustReplayLifecycle("timers", -1); }
  return undefined;
}

function closePorts(ports: readonly MessagePort[]): void {
  for (const transferred of ports) { try { transferred.close(); } catch { /* Rejected ports are already unusable. */ } }
}

function removeListeners(): void {
  if (bootstrapListenerActive) { window.removeEventListener("message", acceptBootstrap); bootstrapListenerActive = false; adjustReplayLifecycle("listeners", -1); }
  if (rejectionListenerActive) { window.removeEventListener("message", rejectAdditionalBootstrap); rejectionListenerActive = false; adjustReplayLifecycle("listeners", -1); }
  if (pagehideListenerActive) { window.removeEventListener("pagehide", onPagehide); pagehideListenerActive = false; adjustReplayLifecycle("listeners", -1); }
}

function boundedTime(): number {
  return Math.min(HOSTED_DEMO_MEDIA_MANIFEST.replay.durationMs, Math.max(0, player?.getCurrentTime() ?? 0));
}

function send(message: HostedReplayRuntimeStatusMessage | HostedReplayRuntimeFailureMessage): void {
  port?.postMessage(message);
}

function status(commandId: number): void {
  send({
    protocol: HOSTED_REPLAY_PROTOCOL_VERSION,
    type: "status",
    capability,
    identityKey,
    state,
    commandId,
    currentTimeMs: commandId === 0 ? 0 : boundedTime(),
    acknowledgedAt: performance.now(),
    eventCount,
    durationMs: HOSTED_DEMO_MEDIA_MANIFEST.replay.durationMs,
    ...(firstFrameMs === undefined ? {} : { firstFrameMs }),
  });
}

function teardown(terminalState: string, transferredPorts: readonly MessagePort[] = []): void {
  closePorts(transferredPorts);
  if (destroyed) return;
  destroyed = true;
  root.dataset.runtimeState = terminalState;
  removeListeners();
  bootstrapTimer = clearTracked(bootstrapTimer);
  firstFrameTimer = clearTracked(firstFrameTimer);
  loadController?.abort();
  loadController = undefined;
  if (portHandlersActive) { portHandlersActive = false; adjustReplayLifecycle("listeners", -1); }
  if (playerHandlersActive) { playerHandlersActive = false; adjustReplayLifecycle("listeners", -1); }
  try { player?.destroy(); } catch { /* Teardown remains fail-closed. */ }
  if (player !== undefined) adjustReplayLifecycle("players", -1);
  player = undefined;
  root.replaceChildren();
  if (port !== undefined) { port.close(); adjustReplayLifecycle("ports", -1); adjustReplayLifecycle("channels", -1); }
  port = undefined;
}

function fail(reasonCode: string): void {
  if (capability !== "" && port !== undefined) send({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "failure", capability, identityKey, reasonCode });
  teardown(reasonCode);
}

function reconstructedFrameIsVisible(): boolean {
  const frame = player?.iframe;
  const body = frame?.contentDocument?.body;
  const documentElement = frame?.contentDocument?.documentElement;
  if (frame === undefined || body === null || body === undefined || documentElement === null || documentElement === undefined) return false;
  return frame.getBoundingClientRect().width > 0
    && frame.getBoundingClientRect().height > 0
    && body.querySelectorAll("*").length > 0
    && body.innerText.trim().length > 0
    && documentElement.scrollWidth > 0
    && documentElement.scrollHeight > 0;
}

async function initialize(message: unknown): Promise<void> {
  if (!isValidHostedReplayInitialize(message, binding, capability !== "")) { fail("hosted-replay.initialize-rejected"); return; }
  capability = message.capability;
  initializationStartedAt = performance.now();
  root.dataset.runtimeState = "loading-fixture";
  loadController = new AbortController();
  try {
    const asset = await loadHostedReplayAsset(loadController.signal);
    if (destroyed) return;
    eventCount = asset.events.length;
    root.dataset.runtimeState = "reconstructing";
    player = new Replayer([...asset.events] as ConstructorParameters<typeof Replayer>[0], {
      root,
      liveMode: false,
      UNSAFE_replayCanvas: false,
      mouseTail: false,
      triggerFocus: false,
      skipInactive: false,
      showWarning: false,
      showDebug: false,
      pauseAnimation: true,
      useVirtualDom: true,
    });
    adjustReplayLifecycle("players", 1);
    player.disableInteract();
    if (player.iframe.getAttribute("sandbox") !== "allow-same-origin") throw new Error("Hosted replay reconstruction sandbox is not inert.");
    player.iframe.setAttribute("tabindex", "-1");
    player.iframe.setAttribute("aria-hidden", "true");
    player.iframe.classList.add("remo-hosted-reconstruction-frame");
    player.wrapper.setAttribute("inert", "");
    playerHandlersActive = true;
    adjustReplayLifecycle("listeners", 1);
    player.on("finish", () => { if (!destroyed) state = "finished"; });
    player.on("fullsnapshot-rebuilded", () => {
      if (destroyed || firstFrameMs !== undefined) return;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (destroyed || initializationStartedAt === undefined || !reconstructedFrameIsVisible()) { fail("hosted-replay.first-frame-unavailable"); return; }
        firstFrameTimer = clearTracked(firstFrameTimer);
        firstFrameMs = performance.now() - initializationStartedAt;
        state = "paused";
        root.dataset.runtimeState = "ready";
        root.dataset.visibleContentConfirmed = "true";
        root.dataset.eventCount = String(eventCount);
        root.dataset.durationMs = String(HOSTED_DEMO_MEDIA_MANIFEST.replay.durationMs);
        root.dataset.firstFrameMs = String(firstFrameMs);
        status(0);
      }));
    });
    firstFrameTimer = trackedTimeout(() => { firstFrameTimer = undefined; fail("hosted-replay.first-frame-timeout"); }, 1_500);
    const first = asset.events[0];
    const snapshot = asset.events.find(({ type }) => type === 2);
    if (first === undefined || snapshot === undefined) { fail("hosted-replay.fixture-invalid"); return; }
    player.play(Math.min(HOSTED_DEMO_MEDIA_MANIFEST.replay.durationMs, Math.max(0, snapshot.timestamp - first.timestamp + 1)));
    player.pause();
  } catch (error) {
    if (!destroyed && !(error instanceof DOMException && error.name === "AbortError")) fail(error instanceof Error && error.message.includes("digest") ? "hosted-replay.fixture-digest-mismatch" : "hosted-replay.player-failure");
  }
}

function command(message: unknown): void {
  const durationMs = HOSTED_DEMO_MEDIA_MANIFEST.replay.durationMs;
  if (player === undefined || !isValidHostedReplayCommand(message, { capability, identityKey, durationMs, lastCommandId, state, destroyed })) { fail("hosted-replay.protocol-rejected"); return; }
  lastCommandId = message.commandId;
  try {
    if (message.type === "destroy") {
      state = "destroyed";
      status(message.commandId);
      queueMicrotask(() => teardown("destroyed"));
      return;
    }
    if (message.type === "play") { player.play(state === "finished" ? 0 : boundedTime()); state = "playing"; }
    else if (message.type === "resume") { player.play(boundedTime()); state = "playing"; }
    else if (message.type === "pause") { player.pause(); state = "paused"; }
    else if (message.type === "seek") { player.pause(message.atMs); state = message.atMs >= durationMs ? "finished" : "paused"; }
    else { player.pause(0); state = "paused"; }
    status(message.commandId);
  } catch { fail("hosted-replay.player-failure"); }
}

function acceptBootstrap(event: MessageEvent): void {
  const transferredPorts = [...event.ports];
  if (!isTrustedHostedReplayBootstrap(event, { expectedSource: window.parent, expectedOrigin: window.location.origin, expectedBinding: binding, connected: port !== undefined })) {
    teardown("bootstrap-rejected", transferredPorts);
    return;
  }
  window.removeEventListener("message", acceptBootstrap);
  bootstrapListenerActive = false;
  adjustReplayLifecycle("listeners", -1);
  window.addEventListener("message", rejectAdditionalBootstrap);
  rejectionListenerActive = true;
  adjustReplayLifecycle("listeners", 1);
  bootstrapTimer = clearTracked(bootstrapTimer);
  port = event.ports[0]!;
  root.dataset.runtimeState = "waiting-initialize";
  adjustReplayLifecycle("channels", 1);
  adjustReplayLifecycle("ports", 1);
  portHandlersActive = true;
  adjustReplayLifecycle("listeners", 1);
  port.onmessage = ({ data }: MessageEvent<unknown>) => { if (capability === "") void initialize(data); else command(data); };
  port.onmessageerror = () => fail("hosted-replay.protocol-rejected");
  port.start();
  bootstrapTimer = trackedTimeout(() => { bootstrapTimer = undefined; if (capability === "") fail("hosted-replay.initialize-timeout"); }, 3_000);
}

function rejectAdditionalBootstrap(event: MessageEvent): void {
  closePorts([...event.ports]);
}

function onPagehide(): void {
  teardown("pagehide");
}

window.addEventListener("message", acceptBootstrap);
bootstrapListenerActive = true;
adjustReplayLifecycle("listeners", 1);
window.addEventListener("pagehide", onPagehide, { once: true });
pagehideListenerActive = true;
adjustReplayLifecycle("listeners", 1);
bootstrapTimer = trackedTimeout(() => { bootstrapTimer = undefined; if (port === undefined) teardown("bootstrap-timeout"); }, 3_000);
