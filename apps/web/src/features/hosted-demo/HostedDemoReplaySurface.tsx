import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceReplaySurfaceProps } from "../evidence-media/EvidenceMediaPanel.js";
import { adjustReplayLifecycle, installReplayLifecycleInstrumentation } from "../replay-player/replay-lifecycle.js";
import {
  HOSTED_REPLAY_BOOTSTRAP_TYPE,
  HOSTED_REPLAY_FIXTURE_REVISION,
  HOSTED_REPLAY_FRAME_ID,
  HOSTED_REPLAY_MEDIA_ID,
  HOSTED_REPLAY_PARENT_ID,
  HOSTED_REPLAY_PROTOCOL_VERSION,
  HOSTED_REPLAY_RUNTIME_PATH,
  createHostedReplayCapability,
  hostedReplayIdentityKey,
  isHostedReplayRuntimeMessage,
  type HostedReplayBinding,
  type HostedReplayCommandName,
  type HostedReplayRuntimeState,
} from "../../demo-replay-runtime/protocol.js";
import type { HostedDemoReplayManifestEntry } from "./hosted-demo-fixture-source.js";

export interface HostedDemoBundleReplayBinding {
  readonly fixtureRevision: string;
  readonly replay: HostedDemoReplayManifestEntry;
}

interface HostedDemoReplaySurfaceProps extends EvidenceReplaySurfaceProps {
  readonly replayBinding: HostedDemoBundleReplayBinding | undefined;
}

interface Session {
  readonly port: MessagePort;
  readonly capability: string;
  readonly identityKey: string;
  readonly pending: Map<number, { readonly command: "play" | "pause" | "seek" | "restart" | "resume" | "destroy"; readonly startedAt: number; readonly timer: number }>;
  nextCommandId: number;
  ready: boolean;
  destroyed: boolean;
  initialTimer?: number;
}

const HOSTED_REPLAY_MEDIA_PATH = "/hosted-demo/turn-4-rrweb.json";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function protocolBinding(value: HostedDemoBundleReplayBinding | undefined): HostedReplayBinding | undefined {
  if (value === undefined
    || value.fixtureRevision !== HOSTED_REPLAY_FIXTURE_REVISION
    || value.replay.kind !== "replay"
    || value.replay.id !== HOSTED_REPLAY_MEDIA_ID
    || value.replay.path !== HOSTED_REPLAY_MEDIA_PATH
    || value.replay.mediaType !== "application/json"
    || !SHA256_PATTERN.test(value.replay.digest)) return undefined;
  return Object.freeze({
    parentId: HOSTED_REPLAY_PARENT_ID,
    frameId: HOSTED_REPLAY_FRAME_ID,
    fixtureRevision: HOSTED_REPLAY_FIXTURE_REVISION,
    mediaId: HOSTED_REPLAY_MEDIA_ID,
    digest: value.replay.digest,
  });
}

function expectedReplay(replay: EvidenceReplaySurfaceProps["replay"], binding: HostedDemoBundleReplayBinding): boolean {
  const manifest = binding.replay;
  return replay.savePointId === manifest.savePointId
    && replay.componentId === manifest.componentId
    && replay.revision === manifest.revision
    && replay.manifestDigest === manifest.manifestDigest
    && replay.digest === manifest.digest
    && replay.capture.viewport.width === manifest.viewport.width
    && replay.capture.viewport.height === manifest.viewport.height
    && replay.capture.startTime === manifest.startTime
    && replay.capture.endTime === manifest.endTime
    && replay.capture.durationMs === manifest.durationMs
    && replay.events.length === manifest.eventCount;
}

export function HostedDemoReplaySurface({ replayBinding, replay, onFailure, onSample }: HostedDemoReplaySurfaceProps) {
  installReplayLifecycleInstrumentation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<Session>();
  const clockRef = useRef<number>();
  const failureRef = useRef(onFailure);
  const sampleRef = useRef(onSample);
  const [status, setStatus] = useState<"booting" | Exclude<HostedReplayRuntimeState, "destroyed">>("booting");
  const [elapsed, setElapsed] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const duration = replay.capture.durationMs;
  failureRef.current = onFailure;
  sampleRef.current = onSample;

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReducedMotion(media?.matches ?? false);
  }, []);

  const stopClock = useCallback(() => {
    if (clockRef.current === undefined) return;
    window.clearInterval(clockRef.current);
    adjustReplayLifecycle("timers", -1);
    clockRef.current = undefined;
  }, []);

  const clearPending = useCallback((session: Session) => {
    for (const { timer } of session.pending.values()) {
      window.clearTimeout(timer);
      adjustReplayLifecycle("timers", -1);
    }
    session.pending.clear();
  }, []);

  const closeSession = useCallback((session: Session | undefined) => {
    if (session === undefined || session.destroyed) return;
    session.destroyed = true;
    if (session.initialTimer !== undefined) { window.clearTimeout(session.initialTimer); adjustReplayLifecycle("timers", -1); session.initialTimer = undefined; }
    clearPending(session);
    session.port.onmessage = null;
    session.port.onmessageerror = null;
    session.port.close();
    adjustReplayLifecycle("listeners", -1);
    adjustReplayLifecycle("ports", -1);
    adjustReplayLifecycle("channels", -1);
    if (sessionRef.current === session) sessionRef.current = undefined;
  }, [clearPending]);

  const fail = useCallback((reasonCode: "replay.protocol-failure" | "replay.timeout" | "replay.runtime-loss" | "replay.player-failure") => {
    stopClock();
    closeSession(sessionRef.current);
    failureRef.current(reasonCode);
  }, [closeSession, stopClock]);

  useEffect(() => {
    const binding = protocolBinding(replayBinding);
    if (binding === undefined || replayBinding === undefined || !expectedReplay(replay, replayBinding)) { fail("replay.protocol-failure"); return; }
    const iframe = iframeRef.current;
    if (iframe === null || typeof MessageChannel === "undefined") { fail("replay.runtime-loss"); return; }
    let disposed = false;
    let loaded = false;
    let loadTimer: number | undefined;
    adjustReplayLifecycle("frames", 1);
    adjustReplayLifecycle("listeners", 1);

    const clearLoadTimer = () => {
      if (loadTimer === undefined) return;
      window.clearTimeout(loadTimer);
      adjustReplayLifecycle("timers", -1);
      loadTimer = undefined;
    };

    const load = () => {
      if (disposed) return;
      if (loaded) { fail("replay.runtime-loss"); return; }
      loaded = true;
      clearLoadTimer();
      let frameWindow: Window | null;
      let frameOrigin: string;
      try {
        frameWindow = iframe.contentWindow;
        frameOrigin = frameWindow?.location.origin ?? "";
      } catch {
        fail("replay.runtime-loss");
        return;
      }
      if (frameWindow === null || frameOrigin !== window.location.origin) { fail("replay.runtime-loss"); return; }
      const channel = new MessageChannel();
      const capability = createHostedReplayCapability();
      const identityKey = hostedReplayIdentityKey(binding);
      const session: Session = { port: channel.port1, capability, identityKey, pending: new Map(), nextCommandId: 0, ready: false, destroyed: false };
      sessionRef.current = session;
      adjustReplayLifecycle("channels", 1);
      adjustReplayLifecycle("ports", 1);
      adjustReplayLifecycle("listeners", 1);
      session.port.onmessageerror = () => fail("replay.protocol-failure");
      session.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (session.destroyed) return;
        if (!isHostedReplayRuntimeMessage(data, { capability, identityKey, durationMs: duration })) { fail("replay.protocol-failure"); return; }
        if (disposed && !(data.type === "status" && data.state === "destroyed")) return;
        if (data.type === "failure") { fail(data.reasonCode === "hosted-replay.player-failure" ? "replay.player-failure" : "replay.protocol-failure"); return; }
        if (data.commandId === 0) {
          if (session.ready || data.state !== "paused" || data.currentTimeMs !== 0 || data.firstFrameMs === undefined) { fail("replay.protocol-failure"); return; }
          if (session.initialTimer !== undefined) { window.clearTimeout(session.initialTimer); adjustReplayLifecycle("timers", -1); session.initialTimer = undefined; }
          session.ready = true;
          setStatus("paused");
          setElapsed(0);
          return;
        }
        const pending = session.pending.get(data.commandId);
        if (pending === undefined) { fail("replay.protocol-failure"); return; }
        const expectedState = pending.command === "play" || pending.command === "resume"
          ? "playing"
          : pending.command === "seek" && data.currentTimeMs >= duration
            ? "finished"
            : pending.command === "destroy"
              ? "destroyed"
              : "paused";
        if (data.state !== expectedState) { fail("replay.protocol-failure"); return; }
        window.clearTimeout(pending.timer);
        adjustReplayLifecycle("timers", -1);
        session.pending.delete(data.commandId);
        if (pending.command !== "destroy") sampleRef.current?.({ command: pending.command, acknowledgedMs: performance.now() - pending.startedAt, ...(pending.command === "play" && data.firstFrameMs !== undefined ? { firstFrameMs: data.firstFrameMs } : {}), measuredAt: new Date().toISOString() });
        if (data.state === "destroyed") { closeSession(session); return; }
        setElapsed(data.currentTimeMs);
        setStatus(data.state);
        if (data.state === "playing") {
          stopClock();
          const baseline = performance.now() - data.currentTimeMs;
          adjustReplayLifecycle("timers", 1);
          clockRef.current = window.setInterval(() => {
            const next = Math.min(duration, performance.now() - baseline);
            setElapsed(next);
            if (next >= duration) { stopClock(); setStatus("finished"); }
          }, 50);
        } else stopClock();
      };
      session.port.start();
      adjustReplayLifecycle("timers", 1);
      session.initialTimer = window.setTimeout(() => {
        session.initialTimer = undefined;
        adjustReplayLifecycle("timers", -1);
        fail("replay.timeout");
      }, 3_000);
      frameWindow.postMessage({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: HOSTED_REPLAY_BOOTSTRAP_TYPE, ...binding }, window.location.origin, [channel.port2]);
      session.port.postMessage({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "initialize", capability, ...binding });
    };

    iframe.addEventListener("load", load);
    adjustReplayLifecycle("timers", 1);
    loadTimer = window.setTimeout(() => {
      loadTimer = undefined;
      adjustReplayLifecycle("timers", -1);
      fail("replay.timeout");
    }, 3_000);
    iframe.src = HOSTED_REPLAY_RUNTIME_PATH;
    return () => {
      disposed = true;
      iframe.removeEventListener("load", load);
      adjustReplayLifecycle("listeners", -1);
      clearLoadTimer();
      stopClock();
      const session = sessionRef.current;
      if (session !== undefined && !session.destroyed) {
        if (session.ready) {
          clearPending(session);
          session.nextCommandId += 1;
          const commandId = session.nextCommandId;
          adjustReplayLifecycle("timers", 1);
          const timer = window.setTimeout(() => closeSession(session), 250);
          session.pending.set(commandId, { command: "destroy", startedAt: performance.now(), timer });
          session.port.postMessage({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type: "destroy", capability: session.capability, identityKey: session.identityKey, commandId });
        } else closeSession(session);
      }
      adjustReplayLifecycle("frames", -1);
    };
  }, [clearPending, closeSession, duration, fail, replay, replayBinding, stopClock]);

  const sendCommand = (type: HostedReplayCommandName, command: "play" | "pause" | "seek" | "restart" | "resume", atMs?: number) => {
    const session = sessionRef.current;
    if (session === undefined || !session.ready || session.destroyed || session.pending.size > 0) return;
    session.nextCommandId += 1;
    const commandId = session.nextCommandId;
    adjustReplayLifecycle("timers", 1);
    const timer = window.setTimeout(() => {
      if (!session.pending.delete(commandId)) return;
      adjustReplayLifecycle("timers", -1);
      fail("replay.timeout");
    }, 1_000);
    session.pending.set(commandId, { command, startedAt: performance.now(), timer });
    session.port.postMessage({ protocol: HOSTED_REPLAY_PROTOCOL_VERSION, type, capability: session.capability, identityKey: session.identityKey, commandId, ...(atMs === undefined ? {} : { atMs }) });
  };
  const play = () => elapsed > 0 && status !== "finished" ? sendCommand("resume", "resume") : sendCommand("play", "play");
  const seconds = (milliseconds: number) => `${(milliseconds / 1_000).toFixed(1)}s`;

  return <section className="replay-surface hosted-demo-replay" aria-labelledby="hosted-bounded-replay-title" data-protocol={HOSTED_REPLAY_PROTOCOL_VERSION}>
    <div className="replay-heading">
      <div><p className="detail-kicker">Synthetic historical interaction evidence</p><h3 id="hosted-bounded-replay-title">Bounded hosted replay</h3></div>
      <span className={`replay-state ${status}`} role="status" aria-live="polite">{status === "booting" ? "Preparing isolated replay" : status === "playing" ? "Playing synthetic historical evidence" : status === "finished" ? "Replay finished" : "Replay paused"}</span>
    </div>
    <iframe ref={iframeRef} className="replay-frame" title="Isolated same-origin synthetic replay" />
    <div className="replay-controls" aria-label="Replay controls">
      <button type="button" onClick={play} disabled={status === "booting"}>{status === "finished" || elapsed === 0 ? "Start replay" : "Resume replay"}</button>
      <button type="button" onClick={() => sendCommand("pause", "pause")} disabled={status !== "playing"}>Pause</button>
      <button type="button" onClick={() => sendCommand("restart", "restart")} disabled={status === "booting"}>Restart</button>
      <label><span>Seek within replay</span><input type="range" min={0} max={Math.max(duration, 1)} step={50} value={elapsed} disabled={status === "booting"} onChange={(event) => sendCommand("seek", "seek", Math.min(duration, Math.max(0, Number(event.currentTarget.value))))} /></label>
      <output aria-live="polite">{seconds(elapsed)} / {seconds(duration)}</output>
    </div>
    <p className="replay-boundary">Committed synthetic fixture · {replay.capture.viewport.width}×{replay.capture.viewport.height} · {replay.events.length} events · {seconds(duration)} bounded window. The isolated runtime receives no URL, markup, event payload, repository credential, or local replay token from this page.</p>
    {reducedMotion ? <p className="replay-motion-note">Reduced-motion preference detected. Replay starts paused and runs only on explicit command.</p> : null}
  </section>;
}
