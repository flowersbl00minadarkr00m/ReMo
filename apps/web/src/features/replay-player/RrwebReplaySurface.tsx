import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayEvidence } from "../evidence-media/evidence-media-client.js";
import {
  REPLAY_BOOTSTRAP_TYPE,
  REPLAY_MAX_EVENT_BYTES,
  REPLAY_PROTOCOL_VERSION,
  REPLAY_RUNTIME_ORIGIN,
  REPLAY_RUNTIME_PATH,
  createReplayCapability,
  isReplayRuntimeMessage,
  replayEventBytes,
  replayIdentity,
  replayIdentityKey,
  type ReplayCommandName,
  type ReplayRuntimeAvailability,
  type ReplayRuntimeState,
} from "./replay-protocol.js";
import { adjustReplayLifecycle, installReplayLifecycleInstrumentation } from "./replay-lifecycle.js";
import "./RrwebReplaySurface.css";

export interface ReplayPerformanceSample {
  readonly command: "play" | "pause" | "resume" | "seek" | "restart";
  readonly acknowledgedMs: number;
  readonly firstFrameMs?: number;
  readonly measuredAt: string;
}

export type ReplaySurfaceFailure = "replay.listener-unavailable" | "replay.protocol-failure" | "replay.timeout" | "replay.runtime-loss" | "replay.player-failure";

interface Session {
  readonly port: MessagePort;
  readonly capability: string;
  readonly identityKey: string;
  readonly timers: Map<number, number>;
  readonly started: Map<number, { readonly command: ReplayPerformanceSample["command"]; readonly at: number }>;
  nextCommandId: number;
  ready: boolean;
  paintPending: boolean;
  paintConfirmed: boolean;
  destroyed: boolean;
  firstFrameMs?: number;
}

const commandFailure = (reasonCode: string): ReplaySurfaceFailure => reasonCode === "replay.first-frame-timeout"
  ? "replay.timeout"
  : reasonCode === "replay.player-failure" || reasonCode === "replay.first-frame-unavailable"
    ? "replay.player-failure"
    : "replay.protocol-failure";

export function RrwebReplaySurface({ replay, onFailure, onSample, availability = window.__REMO_REPLAY_RUNTIME__ ?? { state: "listener-unavailable", origin: REPLAY_RUNTIME_ORIGIN, reasonCode: "replay.runtime-status-missing" } }: {
  readonly replay: ReplayEvidence;
  readonly onFailure: (reasonCode: ReplaySurfaceFailure) => void;
  readonly onSample?: (sample: ReplayPerformanceSample) => void;
  readonly availability?: ReplayRuntimeAvailability;
}) {
  installReplayLifecycleInstrumentation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<Session | undefined>(undefined);
  const failureRef = useRef(onFailure);
  const sampleRef = useRef(onSample);
  const clockRef = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState<"booting" | Exclude<ReplayRuntimeState, "destroyed">>("booting");
  const [elapsed, setElapsed] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const duration = replay.capture.durationMs;

  useEffect(() => { failureRef.current = onFailure; }, [onFailure]);
  useEffect(() => { sampleRef.current = onSample; }, [onSample]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReducedMotion(media?.matches ?? false);
  }, []);

  const stopClock = useCallback(() => {
    if (clockRef.current !== undefined) {
      window.clearInterval(clockRef.current);
      adjustReplayLifecycle("timers", -1);
    }
    clockRef.current = undefined;
  }, []);

  const closeSession = useCallback((notifyRuntime: boolean) => {
    const session = sessionRef.current;
    sessionRef.current = undefined;
    stopClock();
    if (session === undefined || session.destroyed) return;
    session.destroyed = true;
    for (const timer of session.timers.values()) {
      window.clearTimeout(timer);
      adjustReplayLifecycle("timers", -1);
    }
    session.timers.clear();
    if (notifyRuntime && session.ready) {
      session.nextCommandId += 1;
      session.port.postMessage({ protocol: REPLAY_PROTOCOL_VERSION, type: "destroy", capability: session.capability, identityKey: session.identityKey, commandId: session.nextCommandId });
    }
    session.port.close();
    adjustReplayLifecycle("listeners", -1);
    adjustReplayLifecycle("ports", -1);
    adjustReplayLifecycle("channels", -1);
  }, [stopClock]);

  const fail = useCallback((reasonCode: ReplaySurfaceFailure) => {
    closeSession(true);
    failureRef.current(reasonCode);
  }, [closeSession]);

  useEffect(() => {
    if (availability.state !== "available") { fail("replay.listener-unavailable"); return; }
    const iframe = iframeRef.current;
    if (iframe === null) return;
    let disposed = false;
    adjustReplayLifecycle("frames", 1);
    adjustReplayLifecycle("listeners", 1);
    const load = () => {
      if (disposed || iframe.contentWindow === null) return;
      if (sessionRef.current !== undefined) { fail("replay.runtime-loss"); return; }
      const eventBytes = replayEventBytes(replay.events);
      if (eventBytes < 1 || eventBytes > REPLAY_MAX_EVENT_BYTES) { fail("replay.protocol-failure"); return; }
      const channel = new MessageChannel();
      const identity = replayIdentity(replay);
      const identityKey = replayIdentityKey(identity);
      const capability = createReplayCapability();
      const session: Session = { port: channel.port1, capability, identityKey, timers: new Map(), started: new Map(), nextCommandId: 0, ready: false, paintPending: false, paintConfirmed: false, destroyed: false };
      sessionRef.current = session;
      adjustReplayLifecycle("channels", 1);
      adjustReplayLifecycle("ports", 1);
      adjustReplayLifecycle("listeners", 1);
      adjustReplayLifecycle("timers", 1);
      const initTimer = window.setTimeout(() => {
        if (!session.timers.delete(0)) return;
        adjustReplayLifecycle("timers", -1);
        fail("replay.timeout");
      }, 3_000);
      session.timers.set(0, initTimer);
      channel.port1.onmessageerror = () => fail("replay.protocol-failure");
      channel.port1.onmessage = ({ data }) => {
        if (disposed || session.destroyed || !isReplayRuntimeMessage(data) || data.capability !== capability || data.identityKey !== identityKey) { fail("replay.protocol-failure"); return; }
        if (data.type === "failure") { fail(commandFailure(data.reasonCode)); return; }
        if (data.type === "frame-rebuilt") {
          if (session.ready || session.paintPending || data.reconstructedElements < 1 || data.visibleTextLength < 1) { fail("replay.protocol-failure"); return; }
          session.paintPending = true;
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            if (disposed || session.destroyed || session.ready) return;
            session.paintConfirmed = true;
            session.port.postMessage({ protocol: REPLAY_PROTOCOL_VERSION, type: "confirm-painted-frame", capability, identityKey });
          }));
          return;
        }
        if (data.currentTimeMs > duration) { fail("replay.protocol-failure"); return; }
        const timer = session.timers.get(data.commandId);
        if (timer === undefined) { fail("replay.protocol-failure"); return; }
        window.clearTimeout(timer);
        session.timers.delete(data.commandId);
        adjustReplayLifecycle("timers", -1);
        if (data.commandId === 0) {
          if (session.ready || !session.paintPending || !session.paintConfirmed || data.state !== "paused" || data.firstFrameMs === undefined) { fail("replay.protocol-failure"); return; }
          session.ready = true;
          if (data.firstFrameMs !== undefined) session.firstFrameMs = data.firstFrameMs;
        } else {
          const started = session.started.get(data.commandId);
          if (started === undefined) { fail("replay.protocol-failure"); return; }
          const validState = started.command === "play" || started.command === "resume"
            ? data.state === "playing"
            : started.command === "seek"
              ? data.state === (data.currentTimeMs >= duration ? "finished" : "paused")
              : data.state === "paused";
          if (!validState) { fail("replay.protocol-failure"); return; }
          session.started.delete(data.commandId);
          sampleRef.current?.({ command: started.command, acknowledgedMs: performance.now() - started.at, ...(started.command === "play" && session.firstFrameMs !== undefined ? { firstFrameMs: session.firstFrameMs } : {}), measuredAt: new Date().toISOString() });
        }
        setElapsed(Math.min(duration, Math.max(0, data.currentTimeMs)));
        if (data.state === "destroyed") return;
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
      channel.port1.start();
      iframe.contentWindow.postMessage({ type: REPLAY_BOOTSTRAP_TYPE, protocol: REPLAY_PROTOCOL_VERSION }, REPLAY_RUNTIME_ORIGIN, [channel.port2]);
      channel.port1.postMessage({ protocol: REPLAY_PROTOCOL_VERSION, type: "initialize", capability, identity, durationMs: replay.capture.durationMs, eventBytes, viewport: replay.capture.viewport, events: replay.events });
    };
    iframe.addEventListener("load", load);
    return () => {
      disposed = true;
      iframe.removeEventListener("load", load);
      adjustReplayLifecycle("listeners", -1);
      closeSession(true);
      adjustReplayLifecycle("frames", -1);
    };
  }, [availability, closeSession, duration, fail, replay, stopClock]);

  const sendCommand = (type: ReplayCommandName, command: ReplayPerformanceSample["command"], atMs?: number) => {
    const session = sessionRef.current;
    if (session === undefined || !session.ready || session.destroyed) return;
    session.nextCommandId += 1;
    const commandId = session.nextCommandId;
    session.started.set(commandId, { command, at: performance.now() });
    adjustReplayLifecycle("timers", 1);
    session.timers.set(commandId, window.setTimeout(() => {
      if (!session.timers.delete(commandId)) return;
      adjustReplayLifecycle("timers", -1);
      fail("replay.timeout");
    }, 1_000));
    session.port.postMessage({ protocol: REPLAY_PROTOCOL_VERSION, type, capability: session.capability, identityKey: session.identityKey, commandId, ...(atMs === undefined ? {} : { atMs }) });
  };
  const play = () => sendCommand("play", elapsed > 0 && status !== "finished" ? "resume" : "play");
  const pause = () => sendCommand("pause", "pause");
  const seek = (value: number) => sendCommand("seek", "seek", Math.min(duration, Math.max(0, value)));
  const restart = () => sendCommand("restart", "restart");
  const seconds = (milliseconds: number) => `${(milliseconds / 1_000).toFixed(1)}s`;

  if (availability.state !== "available") return null;
  return <section className="replay-surface" aria-labelledby="bounded-replay-title">
    <div className="replay-heading">
      <div><p className="detail-kicker">Historical interaction evidence</p><h3 id="bounded-replay-title">Bounded replay</h3></div>
      <span className={`replay-state ${status}`} role="status" aria-live="polite">{status === "booting" ? "Preparing isolated replay" : status === "playing" ? "Playing historical evidence" : status === "finished" ? "Replay finished" : "Replay paused"}</span>
    </div>
    <iframe ref={iframeRef} className="replay-frame" src={`${REPLAY_RUNTIME_ORIGIN}${REPLAY_RUNTIME_PATH}`} sandbox="allow-scripts allow-same-origin" title="Isolated non-interactive historical replay" />
    <div className="replay-controls" aria-label="Replay controls">
      <button type="button" onClick={play} disabled={status === "booting"}>{status === "finished" || elapsed === 0 ? "Start replay" : "Resume replay"}</button>
      <button type="button" onClick={pause} disabled={status !== "playing"}>Pause</button>
      <button type="button" onClick={restart} disabled={status === "booting"}>Restart</button>
      <label><span>Seek within replay</span><input type="range" min={0} max={Math.max(duration, 1)} step={50} value={elapsed} disabled={status === "booting"} onChange={(event) => seek(Number(event.currentTarget.value))} /></label>
      <output aria-live="polite">{seconds(elapsed)} / {seconds(duration)}</output>
    </div>
    <p className="replay-boundary">Captured at {replay.capture.origin}{replay.capture.path} · {replay.capture.viewport.width}×{replay.capture.viewport.height} · {seconds(duration)} authoritative window. Events cross one fresh capability-bound port; the isolated runtime has no application credentials or API access.</p>
    {reducedMotion ? <p className="replay-motion-note">Reduced-motion preference detected. Replay starts paused and runs only on explicit command.</p> : null}
  </section>;
}
