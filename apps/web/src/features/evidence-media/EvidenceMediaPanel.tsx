import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { RrwebReplaySurface, type ReplayPerformanceSample, type ReplaySurfaceFailure } from "../replay-player/RrwebReplaySurface.js";
import { adjustReplayLifecycle } from "../replay-player/replay-lifecycle.js";
import { createEvidenceMediaClient, EvidenceMediaClientError, type EvidenceMediaClient, type EvidenceMediaIdentity, type ReplayEvidence, type ScreenshotEvidence } from "./evidence-media-client.js";
import { useSharedMediaRequest } from "./use-shared-media-request.js";
import "./EvidenceMediaPanel.css";

type MediaState = "loading" | "available" | "replay-unavailable" | "corrupt" | "digest-mismatch" | "unsafe-content" | "listener-unavailable" | "protocol-failure" | "timeout" | "runtime-loss" | "player-failure";

function failure(error: unknown): { readonly state: MediaState; readonly reasonCode: string } {
  if (error instanceof EvidenceMediaClientError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return { state: "replay-unavailable", reasonCode: "media.request-aborted" };
  return { state: "replay-unavailable", reasonCode: "media.request-failed" };
}

function StateNotice({ state, reasonCode, kind }: { readonly state: Exclude<MediaState, "loading" | "available">; readonly reasonCode: string; readonly kind: "screenshot" | "replay" }) {
  const copy = state === "digest-mismatch"
    ? { heading: `${kind === "screenshot" ? "Screenshot" : "Replay"} identity or digest mismatch`, body: "This evidence is blocked because it does not match the selected save point. No cross-turn media is displayed." }
    : state === "unsafe-content"
      ? { heading: `${kind === "screenshot" ? "Screenshot" : "Replay"} contains unsafe content`, body: "Active or external content was rejected before reconstruction. Safely viewable evidence remains available." }
      : state === "corrupt"
      ? { heading: `${kind === "screenshot" ? "Screenshot" : "Replay"} evidence is corrupt`, body: "The local bytes failed validation. ReMo has not reconstructed or replaced the captured evidence." }
      : state === "listener-unavailable"
        ? { heading: "Replay runtime unavailable", body: "The isolated replay listener could not be used. The validated screenshot remains available and the application stays online." }
        : state === "protocol-failure" || state === "timeout" || state === "runtime-loss"
          ? { heading: state === "timeout" ? "Replay runtime timed out" : state === "runtime-loss" ? "Replay runtime was lost" : "Replay protocol failed safely", body: "The isolated session was destroyed. The validated screenshot remains available and no replay completeness claim is made." }
      : state === "player-failure"
        ? { heading: "Replay player failed safely", body: "The validated screenshot remains available. Interactive reconstruction has been destroyed and no completeness claim is made." }
        : { heading: `${kind === "screenshot" ? "Screenshot" : "Replay"} unavailable`, body: kind === "replay" ? "The privacy-checked screenshot remains the available historical evidence; bounded replay is not claimed." : "No captured screenshot is available. ReMo does not show a generated or styled substitute." };
  return <div className={`media-state media-state-${state}`} role={state === "replay-unavailable" ? "status" : "alert"}>
    <strong>{copy.heading}</strong><p>{copy.body}</p><code>{reasonCode}</code>
  </div>;
}

export interface EvidenceReplaySurfaceProps {
  readonly replay: ReplayEvidence;
  readonly onFailure: (reasonCode: ReplaySurfaceFailure) => void;
  readonly onSample?: (sample: ReplayPerformanceSample) => void;
}

interface EvidenceMediaPanelProps {
  readonly identity: EvidenceMediaIdentity;
  readonly screenshotAvailable: boolean;
  readonly replayAvailable: boolean;
  readonly client?: EvidenceMediaClient;
  readonly replaySurface?: ComponentType<EvidenceReplaySurfaceProps>;
  readonly presentationMode?: "local" | "hosted-demo";
}

export function EvidenceMediaPanel(props: EvidenceMediaPanelProps) {
  const profileSameDocumentLifecycle = useRef(new URLSearchParams(window.location.search).get("replayLifecycleProfile") === "same-document").current;
  const expectedPath = `/save-points/${props.identity.savePointId}`;
  const [selected, setSelected] = useState(() => !profileSameDocumentLifecycle || window.location.pathname === expectedPath);

  useEffect(() => {
    if (!profileSameDocumentLifecycle) return;
    const syncSelection = () => setSelected(window.location.pathname === expectedPath);
    window.addEventListener("popstate", syncSelection);
    return () => window.removeEventListener("popstate", syncSelection);
  }, [expectedPath, profileSameDocumentLifecycle]);

  return selected ? <MountedEvidenceMediaPanel {...props} /> : null;
}

function MountedEvidenceMediaPanel({ identity, screenshotAvailable, replayAvailable, client, replaySurface: ReplaySurface = RrwebReplaySurface, presentationMode = "local" }: EvidenceMediaPanelProps) {
  const sessionToken = window.__REMO_SAVE_POINT_SESSION__?.sessionToken;
  const resolvedClient = useMemo(() => client ?? (sessionToken === undefined ? undefined : createEvidenceMediaClient({ origin: window.location.origin, sessionToken })), [client, sessionToken]);
  const [screenshotState, setScreenshotState] = useState<MediaState>(screenshotAvailable ? "loading" : "replay-unavailable");
  const [screenshotReason, setScreenshotReason] = useState(screenshotAvailable ? "" : "media.component-missing");
  const [screenshot, setScreenshot] = useState<ScreenshotEvidence | undefined>(undefined);
  const [screenshotUrl, setScreenshotUrl] = useState<string | undefined>(undefined);
  const objectUrlRef = useRef<string | undefined>(undefined);
  const [replayState, setReplayState] = useState<MediaState>(replayAvailable ? "loading" : "replay-unavailable");
  const [replayReason, setReplayReason] = useState(replayAvailable ? "" : "media.component-missing");
  const [replay, setReplay] = useState<ReplayEvidence | undefined>(undefined);
  const [samples, setSamples] = useState<readonly ReplayPerformanceSample[]>([]);
  const [replayRetryRevision, setReplayRetryRevision] = useState(0);
  const identityKey = `${identity.savePointId}:${identity.turnId}:${identity.revision}:${identity.manifestDigest}`;
  const revokeScreenshotUrl = useCallback(() => {
    if (objectUrlRef.current === undefined) return;
    URL.revokeObjectURL(objectUrlRef.current);
    adjustReplayLifecycle("objectUrls", -1);
    objectUrlRef.current = undefined;
  }, []);

  useEffect(() => {
    revokeScreenshotUrl();
    setScreenshot(undefined); setScreenshotUrl(undefined); setReplay(undefined); setSamples([]);
    setReplayRetryRevision(0);
    setScreenshotState(screenshotAvailable && resolvedClient !== undefined ? "loading" : "replay-unavailable");
    setScreenshotReason(screenshotAvailable ? resolvedClient === undefined ? "media.authentication-required" : "" : "media.component-missing");
    setReplayState(replayAvailable && resolvedClient !== undefined ? "loading" : "replay-unavailable");
    setReplayReason(replayAvailable ? resolvedClient === undefined ? "media.authentication-required" : "" : "media.component-missing");
    return revokeScreenshotUrl;
  }, [identityKey, replayAvailable, resolvedClient, revokeScreenshotUrl, screenshotAvailable]);

  useSharedMediaRequest({
    enabled: screenshotAvailable && resolvedClient !== undefined,
    requestKey: `screenshot:${identityKey}`,
    source: resolvedClient,
    request: (source, signal) => source.screenshot(identity, signal),
    onResolve: (result) => {
      revokeScreenshotUrl();
      const url = URL.createObjectURL(result.blob);
      adjustReplayLifecycle("objectUrls", 1);
      objectUrlRef.current = url;
      setScreenshot(result); setScreenshotUrl(url); setScreenshotState("available");
    },
    onReject: (error: unknown) => {
      const result = failure(error); setScreenshotState(result.state); setScreenshotReason(result.reasonCode);
    },
  });

  useSharedMediaRequest({
    enabled: replayAvailable && resolvedClient !== undefined,
    requestKey: `replay:${identityKey}:${replayRetryRevision}`,
    source: resolvedClient,
    request: (source, signal) => source.replay(identity, signal),
    onResolve: (result) => { setReplay(result); setReplayState("available"); },
    onReject: (error: unknown) => {
      const result = failure(error); setReplayState(result.state); setReplayReason(result.reasonCode);
    },
  });

  const playerFailure = useCallback((reasonCode: ReplaySurfaceFailure) => {
    const state: MediaState = reasonCode === "replay.listener-unavailable" ? "listener-unavailable"
      : reasonCode === "replay.timeout" ? "timeout"
        : reasonCode === "replay.runtime-loss" ? "runtime-loss"
          : reasonCode === "replay.protocol-failure" ? "protocol-failure"
            : "player-failure";
    setReplay(undefined); setReplayState(state); setReplayReason(reasonCode);
  }, []);
  const recordSample = useCallback((sample: ReplayPerformanceSample) => setSamples((current) => [...current, sample].slice(-40)), []);
  const screenshotOnly = screenshotState === "available" && replayState !== "available";
  const retryReplay = () => {
    setReplay(undefined);
    setReplayState("loading");
    setReplayReason("");
    setReplayRetryRevision((revision) => revision + 1);
  };

  return <section className="evidence-media" aria-labelledby="actual-evidence-title" data-save-point-id={identity.savePointId}>
    <div className="evidence-media-heading">
      <div><p className="detail-kicker">{presentationMode === "hosted-demo" ? "Synthetic fixture evidence" : "Safe local evidence"}</p><h2 id="actual-evidence-title">Actual captured UI and bounded replay</h2><p>{presentationMode === "hosted-demo" ? "Committed synthetic media is loaded only after fixed identity, privacy, size, and digest checks." : "Immutable media is fetched from this save point only after durable identity, lifecycle, privacy, size, and digest checks."}</p></div>
      {screenshotOnly ? <span className="screenshot-only-badge">Screenshot only</span> : null}
    </div>
    {screenshotState === "loading" ? <div className="media-loading" role="status">Loading authenticated captured screenshot…</div> : null}
    {screenshotState === "available" && screenshot !== undefined && screenshotUrl !== undefined ? <figure className="captured-screenshot">
      <img src={screenshotUrl} width={screenshot.width} height={screenshot.height} alt={`Privacy-checked captured UI for save point ${identity.savePointId}; viewport ${screenshot.width} by ${screenshot.height}.`} />
      <figcaption><strong>Immutable captured screenshot</strong><span>Viewport {screenshot.width}×{screenshot.height} · capture identity <code>{screenshot.componentId}</code></span><span>Digest <code>{screenshot.digest}</code></span></figcaption>
    </figure> : null}
    {screenshotState !== "loading" && screenshotState !== "available" ? <StateNotice state={screenshotState} reasonCode={screenshotReason} kind="screenshot" /> : null}

    {replayState === "loading" ? <div className="media-loading" role="status">Validating bounded replay evidence…</div> : null}
    {replayState === "available" && replay !== undefined ? <ReplaySurface replay={replay} onFailure={playerFailure} onSample={recordSample} /> : null}
    {replayState !== "loading" && replayState !== "available" ? <StateNotice state={replayState} reasonCode={replayReason} kind="replay" /> : null}
    {presentationMode === "hosted-demo" && replayState !== "loading" && replayState !== "available" ? <button type="button" className="replay-retry" onClick={retryReplay}>Retry replay validation</button> : null}
    <output className="replay-performance" aria-label="Replay performance samples" data-sample-count={samples.length} data-latest-command={samples.at(-1)?.command} data-latest-command-ms={samples.at(-1)?.acknowledgedMs} data-first-frame-ms={samples.at(-1)?.firstFrameMs} data-measured-at={samples.at(-1)?.measuredAt}>
      {samples.length === 0 ? "Replay performance is measured when a command is used." : `Latest command acknowledged in ${samples.at(-1)!.acknowledgedMs.toFixed(1)} ms${samples.at(-1)!.firstFrameMs === undefined ? "" : `; first safe frame in ${samples.at(-1)!.firstFrameMs!.toFixed(1)} ms`}.`}
    </output>
  </section>;
}
