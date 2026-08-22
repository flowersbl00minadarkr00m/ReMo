import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ComparisonProjection, ComparisonSide, HistoryAnchor } from "@remo/domain/browser";
import { createEvidenceMediaClient, type EvidenceMediaClient, type ScreenshotEvidence } from "../evidence-media/evidence-media-client.js";
import { createLoopbackComparisonClient, type ComparisonClient } from "./comparison-client.js";
import "./ComparisonWorkspace.css";

function selectedOption(side: ComparisonSide): string {
  return `${side.displayId ?? side.savePointId} · lineage ${side.context?.lineageId ?? "unavailable"} · ${side.savePointId}`;
}
interface RequestLease {
  settle(): void;
  abortIfPending(): void;
}

interface RequestLifecycle {
  readonly pendingCount: number;
  begin(controller: AbortController): RequestLease;
}

function useRequestLifecycle(): RequestLifecycle {
  const active = useRef(new Map<symbol, AbortController>());
  const mounted = useRef(true);
  const [pendingCount, setPendingCount] = useState(0);
  const publish = useCallback(() => { if (mounted.current) setPendingCount(active.current.size); }, []);
  const begin = useCallback((controller: AbortController): RequestLease => {
    const id = Symbol("comparison-request");
    let pending = true;
    active.current.set(id, controller);
    publish();
    const settle = () => {
      if (!pending) return;
      pending = false;
      active.current.delete(id);
      publish();
    };
    return {
      settle,
      abortIfPending: () => {
        if (!pending) return;
        controller.abort();
        settle();
      },
    };
  }, [publish]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of active.current.values()) controller.abort();
      active.current.clear();
    };
  }, []);
  return useMemo(() => ({ pendingCount, begin }), [begin, pendingCount]);
}

function Screenshot({ side, client, lifecycle, synthetic }: { readonly side: ComparisonSide; readonly client?: EvidenceMediaClient; readonly lifecycle: RequestLifecycle; readonly synthetic: boolean }) {
  const [state, setState] = useState<{ readonly status: "loading" } | { readonly status: "unavailable"; readonly reason: string } | { readonly status: "ready"; readonly value: ScreenshotEvidence; readonly url: string }>({ status: side.screenshot.availability === "available" ? "loading" : "unavailable", reason: "No safely available screenshot is projected for this side." });
  useLayoutEffect(() => {
    if (side.screenshot.availability !== "available" || side.turnId === undefined || side.revision === undefined || side.manifestDigest === undefined || client === undefined) {
      setState({ status: "unavailable", reason: side.state === "deleted" ? "Deleted side — protected media is not fetched." : "Actual captured screenshot unavailable." });
      return;
    }
    const controller = new AbortController();
    const request = lifecycle.begin(controller);
    let objectUrl: string | undefined;
    setState({ status: "loading" });
    client.screenshot({ savePointId: side.savePointId, turnId: side.turnId, revision: side.revision, manifestDigest: side.manifestDigest }, controller.signal).then((value) => {
      request.settle();
      if (controller.signal.aborted) return;
      if (value.componentId !== side.screenshot.componentId || value.digest !== side.screenshot.digest || value.width !== side.screenshot.width || value.height !== side.screenshot.height) {
        setState({ status: "unavailable", reason: "Screenshot failed its authenticated projection binding checks." });
        return;
      }
      objectUrl = URL.createObjectURL(value.blob);
      setState({ status: "ready", value, url: objectUrl });
    }, () => {
      request.settle();
      if (!controller.signal.aborted) setState({ status: "unavailable", reason: "Screenshot failed its authenticated identity or safety checks." });
    });
    return () => { request.abortIfPending(); if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl); };
  }, [client, lifecycle.begin, side.manifestDigest, side.revision, side.savePointId, side.screenshot, side.state, side.turnId]);
  if (state.status === "loading") return <div className="comparison-media-state" role="status">Loading actual immutable screenshot…</div>;
  if (state.status === "unavailable") return <div className="comparison-media-state unavailable"><strong>Screenshot unavailable</strong><span>{state.reason}</span></div>;
  return <figure className="comparison-screenshot"><img src={state.url} width={state.value.width} height={state.value.height} alt={`${side.role === "before" ? "Before" : "After"} captured UI for ${side.savePointId}; viewport ${state.value.width} by ${state.value.height}.`} /><figcaption>Actual immutable {synthetic ? "synthetic fixture " : ""}screenshot · {state.value.width}×{state.value.height}<code>{state.value.digest}</code></figcaption></figure>;
}

function EvidenceRow({ label, value, detail }: { readonly label: string; readonly value: string; readonly detail?: string }) {
  return <div className="comparison-evidence-row"><dt>{label}</dt><dd><strong>{value}</strong>{detail === undefined ? null : <span>{detail}</span>}</dd></div>;
}

function Side({ side, mediaClient, pair, lifecycle, synthetic, replayAvailable }: { readonly side: ComparisonSide; readonly mediaClient?: EvidenceMediaClient; readonly pair: { readonly left: string; readonly right: string }; readonly lifecycle: RequestLifecycle; readonly synthetic: boolean; readonly replayAvailable: boolean }) {
  const role = side.role === "before" ? "Before · left" : "After · right";
  const returnQuery = new URLSearchParams({ compareLeft: pair.left, compareRight: pair.right });
  return <article className={`comparison-side comparison-side-${side.role}`} aria-labelledby={`comparison-${side.role}-title`} tabIndex={0}>
    <header className="comparison-side-identity"><p className="comparison-role">{role}</p><h2 id={`comparison-${side.role}-title`}>{side.displayId ?? "Unavailable save point"}</h2><code>{side.savePointId}</code><strong>Lineage {side.context?.lineageId ?? "unavailable"}</strong><span className={`side-state side-state-${side.state}`}>{side.state}</span></header>
    <Screenshot side={side} client={mediaClient} lifecycle={lifecycle} synthetic={synthetic} />
    <dl className="comparison-evidence">
      <EvidenceRow label="Source change" value={side.source.state} detail={side.source.summary} />
      <EvidenceRow label="Decision" value={side.decision.state} detail={side.decision.state === "available" ? `${side.decision.question ?? "Question unknown"} · selected ${side.decision.selectedOption ?? "unknown"} · ${side.decision.provenance ?? "unknown"}` : "No rationale, option, or owner is fabricated."} />
      <EvidenceRow label="Verification" value={side.verification.state} detail={side.verification.summary} />
      <EvidenceRow label="Integrity" value={side.integrity.state} detail={side.integrity.explanation} />
      <EvidenceRow label="Fidelity" value={side.fidelity.state} detail={side.fidelity.explanation} />
      <EvidenceRow label="Capture route" value={side.context?.route ?? "Unavailable"} />
      <EvidenceRow label="Viewport" value={side.context === undefined ? "Unavailable" : `${side.context.viewport.width}×${side.context.viewport.height}`} detail={side.context?.provenance === "fixture-contract" ? "Binding fixture contract" : "Observed"} />
      <EvidenceRow label="Fixture" value={side.context?.fixture ?? "Unavailable"} />
      <EvidenceRow label="Dependencies" value={side.context?.dependencyDigest ?? "Unavailable"} />
      <EvidenceRow label="Policies" value={side.context === undefined ? "Unavailable" : Object.entries(side.context.policyRevisions).map(([key, value]) => `${key}: ${value}`).join(" · ")} />
      <EvidenceRow label="Lineage" value={side.context?.lineageId ?? "Unavailable"} />
    </dl>
    {side.replayPath === undefined ? null : <a className="comparison-source-link" href={`${side.replayPath}?${returnQuery}`}>{replayAvailable ? "Open this source turn and bounded replay" : "Open this source turn"}</a>}
  </article>;
}

export function ComparisonWorkspace({ client: providedClient, mediaClient: providedMediaClient, defaultPair, presentationMode = "local" }: { readonly client?: ComparisonClient; readonly mediaClient?: EvidenceMediaClient; readonly defaultPair?: { readonly left: string; readonly right: string }; readonly presentationMode?: "local" | "hosted-demo" }) {
  const requestLifecycle = useRequestLifecycle();
  const client = useMemo(() => providedClient ?? createLoopbackComparisonClient({ origin: window.location.origin }), [providedClient]);
  const mediaClient = useMemo(() => providedMediaClient ?? (window.__REMO_SAVE_POINT_SESSION__?.sessionToken === undefined ? undefined : createEvidenceMediaClient({ origin: window.location.origin, sessionToken: window.__REMO_SAVE_POINT_SESSION__.sessionToken })), [providedMediaClient]);
  const initialPair = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    const explicit = query.has("left") || query.has("right");
    return {
      left: explicit ? query.get("left") ?? "" : defaultPair?.left ?? "",
      right: explicit ? query.get("right") ?? "" : defaultPair?.right ?? "",
    };
  }, [defaultPair?.left, defaultPair?.right]);
  const [history, setHistory] = useState<readonly HistoryAnchor[]>([]);
  const [left, setLeft] = useState(initialPair.left);
  const [right, setRight] = useState(initialPair.right);
  const [state, setState] = useState<{ readonly status: "selecting" | "loading" } | { readonly status: "error"; readonly message: string } | { readonly status: "ready"; readonly value: ComparisonProjection }>({ status: left !== "" && right !== "" ? "loading" : "selecting" });
  const comparisonRequest = useRef<{ readonly controller: AbortController; readonly lease: RequestLease } | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    const request = requestLifecycle.begin(controller);
    client.history(controller.signal).then((page) => {
      request.settle();
      if (!controller.signal.aborted) setHistory(page.anchors);
    }, () => {
      request.settle();
      if (!controller.signal.aborted) setState({ status: "error", message: "History choices are unavailable. No pair was inferred." });
    });
    return () => { request.abortIfPending(); };
  }, [client, requestLifecycle.begin]);
  const load = useCallback((before: string, after: string, updateUrl: boolean) => {
    if (before === "" || after === "") { setState({ status: "error", message: "Select both a before and an after save point." }); return; }
    if (before === after) { setState({ status: "error", message: "Before and after must be distinct save points." }); return; }
    comparisonRequest.current?.lease.abortIfPending();
    const controller = new AbortController();
    const request = { controller, lease: requestLifecycle.begin(controller) };
    comparisonRequest.current = request;
    setState({ status: "loading" });
    void client.compare(before, after, controller.signal).then((value) => {
      request.lease.settle();
      if (comparisonRequest.current === request) comparisonRequest.current = undefined;
      if (controller.signal.aborted) return;
      if (updateUrl) window.history.replaceState(null, "", `/compare?${new URLSearchParams({ left: before, right: after })}`);
      setState({ status: "ready", value });
    }, (error: unknown) => {
      request.lease.settle();
      if (comparisonRequest.current === request) comparisonRequest.current = undefined;
      if (!controller.signal.aborted) setState({ status: "error", message: error instanceof Error ? error.message : "Comparison evidence is unavailable." });
    });
  }, [client, requestLifecycle.begin]);
  useEffect(() => {
    if (initialPair.left !== "" && initialPair.right !== "") load(initialPair.left, initialPair.right, false);
    return () => { comparisonRequest.current?.lease.abortIfPending(); };
  }, [initialPair, load]);
  const submit = (event: FormEvent) => { event.preventDefault(); load(left, right, true); };
  return <section className="comparison-workspace" aria-labelledby="comparison-title" aria-busy={requestLifecycle.pendingCount > 0}>
    <header className="comparison-heading"><p className="comparison-kicker">{presentationMode === "hosted-demo" ? "Synthetic fixture · qualified evidence juxtaposition" : "S-004 · qualified evidence juxtaposition"}</p><h1 id="comparison-title">Before and after, without an automated verdict</h1><p>Choose two explicit save points. ReMo shows their actual screenshots and preserved evidence; it does not compute pixels, semantics, causality, a score, a winner, or a quality verdict.</p></header>
    <form className="comparison-picker" onSubmit={submit} aria-label="Comparison pair">
      <label><span>Before · left</span><select value={left} onChange={(event) => setLeft(event.currentTarget.value)}><option value="">Select a save point</option>{history.map((anchor) => <option key={`left-${anchor.savePointId}`} value={anchor.savePointId}>{`Turn ${anchor.sequenceNo} · ${anchor.lineageId} · ${anchor.state} · ${anchor.savePointId}`}</option>)}</select></label>
      <label><span>After · right</span><select value={right} onChange={(event) => setRight(event.currentTarget.value)}><option value="">Select a save point</option>{history.map((anchor) => <option key={`right-${anchor.savePointId}`} value={anchor.savePointId}>{`Turn ${anchor.sequenceNo} · ${anchor.lineageId} · ${anchor.state} · ${anchor.savePointId}`}</option>)}</select></label>
      <button type="submit">Compare selected turns</button>
    </form>
    {state.status === "selecting" ? <div className="comparison-state" role="status">Select an explicit distinct pair to begin.</div> : null}
    {state.status === "loading" ? <div className="comparison-state" role="status">Building the safe comparison projection…</div> : null}
    {state.status === "error" ? <div className="comparison-state error" role="alert"><strong>Comparison unavailable</strong><span>{state.message}</span></div> : null}
    {state.status === "ready" ? <>
      <section className={`comparison-qualification ${state.value.parityClaimAllowed ? "qualified" : "blocked"}`} aria-labelledby="comparison-qualification-title"><div><p>{state.value.parityClaimAllowed ? "Context matched · no equivalence verdict" : "Mismatch blocks equivalence"}</p><h2 id="comparison-qualification-title">Comparison qualification</h2></div><ul>{state.value.qualifiers.map((qualifier, index) => <li key={`${qualifier.code}-${index}`}><strong>{qualifier.severity === "blocks-equivalence" ? "Mismatch" : "Qualification"} · {qualifier.code}</strong><span>{qualifier.explanation}</span></li>)}</ul></section>
      <p className="comparison-pair-identity"><strong>Selected pair:</strong> Before {selectedOption(state.value.left)}; After {selectedOption(state.value.right)}.</p>
      <div className="comparison-sides"><Side side={state.value.left} mediaClient={mediaClient} lifecycle={requestLifecycle} pair={{ left: state.value.left.savePointId, right: state.value.right.savePointId }} synthetic={presentationMode === "hosted-demo"} replayAvailable /><Side side={state.value.right} mediaClient={mediaClient} lifecycle={requestLifecycle} pair={{ left: state.value.left.savePointId, right: state.value.right.savePointId }} synthetic={presentationMode === "hosted-demo"} replayAvailable={presentationMode !== "hosted-demo"} /></div>
    </> : null}
  </section>;
}
