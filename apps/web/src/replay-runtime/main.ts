import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";
import {
  REPLAY_PROTOCOL_VERSION,
  isTrustedReplayBootstrap,
  isValidReplayCommandMessage,
  isValidReplayInitializeMessage,
  isValidReplayPaintConfirmationMessage,
  replayIdentityKey,
  type ReplayInitializeMessage,
  type ReplayRuntimeFailureMessage,
  type ReplayRuntimeFrameRebuiltMessage,
  type ReplayRuntimeState,
  type ReplayRuntimeStatusMessage,
} from "../features/replay-player/replay-protocol.js";
import { adjustReplayLifecycle, installReplayLifecycleInstrumentation } from "../features/replay-player/replay-lifecycle.js";
import "./runtime.css";

const runtimeRoot = document.querySelector<HTMLElement>("#replay-root");
if (runtimeRoot === null) throw new Error("Replay runtime root is missing.");
const root: HTMLElement = runtimeRoot;
root.dataset.runtimeState = "waiting-bootstrap";
installReplayLifecycleInstrumentation();

let port: MessagePort | undefined;
let player: Replayer | undefined;
let capability = "";
let identityKey = "";
let durationMs = 0;
let state: ReplayRuntimeState = "paused";
let lastCommandId = 0;
let destroyed = false;
let firstFrameMs: number | undefined;
let firstFrameTimer: number | undefined;
let bootstrapTimer: number | undefined;
let initializationStartedAt: number | undefined;
let frameRebuilt = false;
let paintConfirmed = false;
let bootstrapListenerActive = false;
let rejectionListenerActive = false;
let pagehideListenerActive = false;
let portHandlersActive = false;
let playerHandlersActive = false;

function setTrackedTimer(callback: () => void, timeoutMs: number): number {
  adjustReplayLifecycle("timers", 1);
  return window.setTimeout(() => {
    adjustReplayLifecycle("timers", -1);
    callback();
  }, timeoutMs);
}

function clearTrackedTimer(timer: number | undefined): undefined {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    adjustReplayLifecycle("timers", -1);
  }
  return undefined;
}

function closeTransferredPorts(ports: readonly MessagePort[]): void {
  for (const transferred of ports) {
    try { transferred.close(); } catch { /* A rejected transferred port is already unusable. */ }
  }
}

function removeBootstrapListener(): void {
  if (!bootstrapListenerActive) return;
  window.removeEventListener("message", acceptBootstrap);
  bootstrapListenerActive = false;
  adjustReplayLifecycle("listeners", -1);
}

function rejectTransferredPorts(event: MessageEvent): void {
  closeTransferredPorts([...event.ports]);
}

function addRejectionListener(): void {
  if (rejectionListenerActive) return;
  window.addEventListener("message", rejectTransferredPorts);
  rejectionListenerActive = true;
  adjustReplayLifecycle("listeners", 1);
}

function removeRejectionListener(): void {
  if (!rejectionListenerActive) return;
  window.removeEventListener("message", rejectTransferredPorts);
  rejectionListenerActive = false;
  adjustReplayLifecycle("listeners", -1);
}

function removePagehideListener(): void {
  if (!pagehideListenerActive) return;
  window.removeEventListener("pagehide", onPagehide);
  pagehideListenerActive = false;
  adjustReplayLifecycle("listeners", -1);
}

function boundedTime(): number {
  if (lastCommandId === 0 && firstFrameMs !== undefined) return 0;
  return Math.min(durationMs, Math.max(0, player?.getCurrentTime() ?? 0));
}

function send(message: ReplayRuntimeStatusMessage | ReplayRuntimeFailureMessage | ReplayRuntimeFrameRebuiltMessage): void {
  if (!destroyed || message.type === "failure" || (message.type === "status" && message.state === "destroyed")) port?.postMessage(message);
}

function status(commandId: number): void {
  send({ protocol: REPLAY_PROTOCOL_VERSION, type: "status", capability, identityKey, state, commandId, currentTimeMs: boundedTime(), acknowledgedAt: performance.now(), ...(firstFrameMs === undefined ? {} : { firstFrameMs }) });
}

function teardown(notify: boolean, terminalState = "destroyed", transferredPorts: readonly MessagePort[] = []): void {
  closeTransferredPorts(transferredPorts);
  if (destroyed) return;
  if (notify && capability !== "" && identityKey !== "") {
    state = "destroyed";
    status(lastCommandId);
  }
  destroyed = true;
  root.dataset.runtimeState = terminalState;
  removeBootstrapListener();
  removeRejectionListener();
  removePagehideListener();
  firstFrameTimer = clearTrackedTimer(firstFrameTimer);
  bootstrapTimer = clearTrackedTimer(bootstrapTimer);
  if (portHandlersActive) {
    portHandlersActive = false;
    adjustReplayLifecycle("listeners", -1);
  }
  if (playerHandlersActive) {
    playerHandlersActive = false;
    adjustReplayLifecycle("listeners", -1);
  }
  try { player?.destroy(); } catch { /* Destruction is best-effort after the port is failed closed. */ }
  if (player !== undefined) adjustReplayLifecycle("players", -1);
  player = undefined;
  root.replaceChildren();
  if (port !== undefined) {
    port.close();
    adjustReplayLifecycle("ports", -1);
    adjustReplayLifecycle("channels", -1);
  }
  port = undefined;
}

function fail(reasonCode: string): void {
  if (capability !== "" && identityKey !== "") send({ protocol: REPLAY_PROTOCOL_VERSION, type: "failure", capability, identityKey, reasonCode });
  teardown(false, reasonCode);
}

function reconstructedFrameIsVisible(): boolean {
  const frame = player?.iframe;
  const documentElement = frame?.contentDocument?.documentElement;
  const body = frame?.contentDocument?.body;
  if (frame === undefined || documentElement === null || documentElement === undefined || body === null || body === undefined) return false;
  const frameRect = frame.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const visibleText = body.innerText.trim();
  const visibleElements = body.querySelectorAll("*").length;
  const visibleTextElement = [...body.querySelectorAll<HTMLElement>("*")].find((element) => {
    if (element.children.length > 0 || element.innerText.trim().length < 1) return false;
    const rect = element.getBoundingClientRect();
    const style = frame.contentWindow?.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < documentElement.clientWidth
      && rect.top < documentElement.clientHeight
      && style?.visibility !== "hidden"
      && style?.display !== "none"
      && style?.opacity !== "0";
  });
  return frameRect.width > 0
    && frameRect.height > 0
    && documentElement.scrollWidth > 0
    && documentElement.scrollHeight > 0
    && (bodyRect.width > 0 || documentElement.scrollWidth > 0)
    && (bodyRect.height > 0 || documentElement.scrollHeight > 0)
    && visibleElements > 0
    && visibleText.length > 0
    && visibleTextElement !== undefined;
}

function initialize(message: ReplayInitializeMessage): void {
  if (player !== undefined || capability !== "") { fail("replay.duplicate-initialize"); return; }
  capability = message.capability;
  identityKey = replayIdentityKey(message.identity);
  durationMs = message.durationMs;
  initializationStartedAt = performance.now();
  root.dataset.runtimeState = "initializing";
  try {
    player = new Replayer([...message.events] as ConstructorParameters<typeof Replayer>[0], {
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
    if (player.iframe.getAttribute("sandbox") !== "allow-same-origin") throw new Error("Reconstruction iframe sandbox is not inert.");
    player.iframe.setAttribute("tabindex", "-1");
    player.iframe.setAttribute("aria-hidden", "true");
    player.iframe.setAttribute("width", String(message.viewport.width));
    player.iframe.setAttribute("height", String(message.viewport.height));
    player.iframe.classList.add("remo-reconstruction-frame");
    player.wrapper.setAttribute("inert", "");
    player.wrapper.classList.add("remo-reconstruction-wrapper");
    playerHandlersActive = true;
    adjustReplayLifecycle("listeners", 1);
    player.on("finish", () => { if (!destroyed) state = "finished"; });
    player.on("fullsnapshot-rebuilded", () => {
      if (frameRebuilt || destroyed) return;
      const body = player?.iframe.contentDocument?.body;
      const reconstructedElements = body?.querySelectorAll("*").length ?? 0;
      const visibleTextLength = body?.innerText.trim().length ?? 0;
      if (reconstructedElements < 1 || visibleTextLength < 1) { fail("replay.first-frame-unavailable"); return; }
      frameRebuilt = true;
      root.dataset.fullSnapshotRebuilt = "true";
      root.dataset.runtimeState = "awaiting-painted-frame";
      send({ protocol: REPLAY_PROTOCOL_VERSION, type: "frame-rebuilt", capability, identityKey, reconstructedElements, visibleTextLength });
    });
    firstFrameTimer = setTrackedTimer(() => {
      firstFrameTimer = undefined;
      fail("replay.first-frame-timeout");
    }, 1_000);
    const firstEvent = message.events[0];
    const fullSnapshot = message.events.find((event) => event.type === 2);
    if (firstEvent === undefined || fullSnapshot === undefined) { fail("replay.first-frame-unavailable"); return; }
    const reconstructionOffsetMs = Math.min(durationMs, Math.max(0, fullSnapshot.timestamp - firstEvent.timestamp + 1));
    player.play(reconstructionOffsetMs);
    player.pause();
  } catch {
    fail("replay.player-failure");
  }
}

function confirmPaintedFrame(message: unknown): void {
  if (!isValidReplayPaintConfirmationMessage(message, { capability, identityKey, frameRebuilt, confirmed: paintConfirmed, destroyed })) { fail("replay.protocol-failure"); return; }
  if (!reconstructedFrameIsVisible() || initializationStartedAt === undefined) { fail("replay.first-frame-unavailable"); return; }
  paintConfirmed = true;
  firstFrameTimer = clearTrackedTimer(firstFrameTimer);
  firstFrameMs = performance.now() - initializationStartedAt;
  state = "paused";
  root.dataset.runtimeState = "ready";
  root.dataset.paintBoundaryConfirmed = "true";
  root.dataset.visibleContentConfirmed = "true";
  root.dataset.firstFrameMs = String(firstFrameMs);
  status(0);
}

function command(message: unknown): void {
  if (player === undefined || !isValidReplayCommandMessage(message, { capability, identityKey, durationMs, lastCommandId, state, destroyed })) { fail("replay.protocol-failure"); return; }
  lastCommandId = message.commandId;
  try {
    if (message.type === "destroy") { teardown(true); return; }
    if (message.type === "play") {
      if (state !== "paused" && state !== "finished") { fail("replay.invalid-state"); return; }
      player.play(state === "finished" ? 0 : boundedTime());
      state = "playing";
    } else if (message.type === "pause") {
      if (state !== "playing") { fail("replay.invalid-state"); return; }
      player.pause();
      state = "paused";
    } else if (message.type === "seek") {
      if (message.atMs === undefined) { fail("replay.out-of-range"); return; }
      player.pause(message.atMs);
      state = message.atMs >= durationMs ? "finished" : "paused";
    } else {
      player.pause(0);
      state = "paused";
    }
    status(message.commandId);
  } catch {
    fail("replay.player-failure");
  }
}

function acceptBootstrap(event: MessageEvent): void {
  const transferredPorts = [...event.ports];
  if (!isTrustedReplayBootstrap(event, window.parent, port !== undefined)) {
    teardown(false, "bootstrap-rejected", transferredPorts);
    return;
  }
  removeBootstrapListener();
  addRejectionListener();
  bootstrapTimer = clearTrackedTimer(bootstrapTimer);
  root.dataset.runtimeState = "waiting-initialize";
  port = event.ports[0]!;
  adjustReplayLifecycle("channels", 1);
  adjustReplayLifecycle("ports", 1);
  portHandlersActive = true;
  adjustReplayLifecycle("listeners", 1);
  port.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (destroyed) return;
    if (player === undefined) {
      if (!isValidReplayInitializeMessage(data, capability !== "")) { teardown(false, "initialize-rejected"); return; }
      bootstrapTimer = clearTrackedTimer(bootstrapTimer);
      initialize(data);
      return;
    }
    if ((data as { readonly type?: unknown } | null)?.type === "confirm-painted-frame") {
      confirmPaintedFrame(data);
      return;
    }
    command(data);
  };
  port.onmessageerror = () => fail("replay.protocol-failure");
  port.start();
  bootstrapTimer = setTrackedTimer(() => {
    bootstrapTimer = undefined;
    if (player === undefined) teardown(false, "initialize-timeout");
  }, 3_000);
}

function onPagehide(): void {
  teardown(false, "pagehide");
}

window.addEventListener("message", acceptBootstrap);
bootstrapListenerActive = true;
adjustReplayLifecycle("listeners", 1);
window.addEventListener("pagehide", onPagehide, { once: true });
pagehideListenerActive = true;
adjustReplayLifecycle("listeners", 1);
bootstrapTimer = setTrackedTimer(() => {
  bootstrapTimer = undefined;
  if (port === undefined) teardown(false, "bootstrap-timeout");
}, 3_000);
