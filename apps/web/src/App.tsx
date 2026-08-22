import type { ReactElement, ReactNode } from "react";
import { isValidProductSavePointId, matchProductRoute, type CandidateProjection, type ProductRouteBootstrap, type RouteRecoveryState } from "@remo/domain/browser";
import { ReMoBrand } from "./components/brand/ReMoBrand.js";
import { BoundarySetup } from "./features/boundary/BoundarySetup.js";
import { ActiveTurn } from "./features/capture/ActiveTurn.js";
import { createLoopbackTurnClient } from "./features/capture/turn-client.js";
import { CandidateReview } from "./features/candidate/CandidateReview.js";
import { createCandidateFixture, type CandidateFixtureState } from "./features/candidate/candidate-fixtures.js";
import { createLoopbackPromotionClient, type PromotionClient } from "./features/candidate/promotion-client.js";
import { SavePointDetail } from "./features/save-point-detail/SavePointDetail.js";
import { createLoopbackReconcileClient, type ReconcileClient } from "./features/save-point-detail/save-point-client.js";
import type { EvidenceDetailProjection } from "./features/save-point-detail/save-point-fixtures.js";
import { createLoopbackLifecycleClient, type LifecycleClient } from "./features/lifecycle/lifecycle-client.js";
import { SavedResults } from "./features/saved-results/SavedResults.js";
import { ReplayWorkspace } from "./features/history-filmstrip/ReplayWorkspace.js";
import { DecisionCardRouteMount } from "./features/decision-card/DecisionCardRouteMount.js";
import { createLoopbackDecisionClient, type DecisionClient } from "./features/decision-card/decision-client.js";
import { ComparisonWorkspace } from "./features/comparison/ComparisonWorkspace.js";

export interface ActiveTurnBootstrap { readonly repository: string; readonly route: string; readonly turnId: string; readonly startedAt: string; readonly sessionToken: string }

declare global {
  interface Window {
    __REMO_ACTIVE_TURN__?: ActiveTurnBootstrap;
    __REMO_CANDIDATE__?: CandidateProjection;
    __REMO_PROMOTION_SESSION__?: { readonly sessionToken: string };
    __REMO_CANDIDATE_FIXTURE_LABEL__?: string;
    __REMO_DECISION_ENTRY_REQUIRED__?: boolean;
    __REMO_SAVE_POINT__?: EvidenceDetailProjection;
    __REMO_SAVE_POINT_SESSION__?: { readonly sessionToken: string };
    __REMO_ROUTE_BOOTSTRAP__?: ProductRouteBootstrap;
  }
}

function RailIcon({ kind }: { kind: "boundary" | "turn" | "review" | "evidence" | "settings" }): ReactElement {
  const paths = {
    boundary: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6m-6 4h4" /></>,
    turn: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10m-4-4 4 4 4-4" /></>,
    review: <><path d="M7 3h8l4 4v14H7Z" /><path d="M15 3v5h4M10 12h6m-6 4h6" /></>,
    evidence: <><path d="M4 6h16v14H4Z" /><path d="M8 3h8v6H8Zm0 10h8m-8 4h5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2" /></>,
  };
  return <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>;
}

function candidateFixtureFromUrl(): CandidateProjection {
  const state = new URLSearchParams(window.location.search).get("state");
  const allowed = ["candidate", "quarantined", "inconsistent", "incomplete"] as const;
  return createCandidateFixture(allowed.includes(state as CandidateFixtureState) ? state as CandidateFixtureState : "candidate");
}

function promotionSessionToken(): string | undefined {
  return window.__REMO_PROMOTION_SESSION__?.sessionToken;
}

function isSupportedOrigin(location: Location): boolean {
  return location.protocol === "http:" && location.hostname === "127.0.0.1";
}

function RecoveryState({ state }: { readonly state: Exclude<RouteRecoveryState, "ready"> }): ReactElement {
  const copy: Record<Exclude<RouteRecoveryState, "ready">, { readonly heading: string; readonly body: string }> = {
    "bootstrap-absent": { heading: "Application bootstrap unavailable", body: "The local service did not provide the identity or session bootstrap needed for this workflow. No evidence or action is being claimed." },
    missing: { heading: "Save point not found", body: "This stable address has no surviving local save-point identity. ReMo has not invented a result or requested protected evidence." },
    deleted: { heading: "Save point deleted", body: "The ReMo-controlled local evidence was deleted. External Git and Langfuse authorities remain outside ReMo's deletion control." },
    expired: { heading: "Save point expired", body: "The local retention window has ended. No local payload is displayed; surviving history remains available." },
    quarantined: { heading: "Save point quarantined", body: "Ordinary evidence viewing is blocked while this identity is quarantined. No protected payload is rendered." },
    "unsupported-policy": { heading: "Policy category unavailable", body: "The supplied policy revision is not in the closed mapping. ReMo has not substituted another category or authority value." },
    malformed: { heading: "Malformed save point address", body: "This address does not contain a valid save-point identity. No save point was selected or requested; surviving history remains available." },
  };
  const message = copy[state];
  return <section className="route-state" role="alert" aria-labelledby="route-state-title">
    <p className="route-state-kicker">Truth-safe recovery</p>
    <h1 id="route-state-title">{message.heading}</h1>
    <p>{message.body}</p>
    <a className="button secondary-button" href="/save-points">Open saved results</a>
  </section>;
}

function UnsupportedOriginState(): ReactElement {
  return <section className="route-state" role="alert" aria-labelledby="unsupported-origin-title">
    <p className="route-state-kicker">Fail-closed origin check</p>
    <h1 id="unsupported-origin-title">Unsupported origin</h1>
    <p>This app must be opened from the exact IPv4 loopback origin. Protected evidence, tokens, and media requests are disabled here.</p>
    <a className="button secondary-button" href="/save-points">Open saved results</a>
  </section>;
}

function RegisteredRouteState({ title, body }: { readonly title: string; readonly body: string }): ReactElement {
  return <section className="route-state" role="status" aria-labelledby="registered-route-title">
    <p className="route-state-kicker">Registered route</p>
    <h1 id="registered-route-title">{title}</h1>
    <p>{body}</p>
    <a className="button secondary-button" href="/save-points">Open saved results</a>
  </section>;
}

function ComparisonReturnLink(): ReactElement | null {
  const query = new URLSearchParams(window.location.search);
  const left = query.get("compareLeft");
  const right = query.get("compareRight");
  if (left === null || right === null || left === right || !isValidProductSavePointId(left) || !isValidProductSavePointId(right)) return null;
  return <a className="button secondary-button" href={`/compare?${new URLSearchParams({ left, right })}`}>Return to selected comparison pair</a>;
}

function AppShell({ children, path, savePoint }: { readonly children: ReactNode; readonly path: string; readonly savePoint?: EvidenceDetailProjection }): ReactElement {
  const routeId = matchProductRoute(path)?.id;
  const isBoundarySetup = routeId === "boundary-setup";
  const isActiveTurn = routeId === "capture-active";
  const isCandidate = routeId === "candidate-review";
  const isSavedResults = routeId === "save-points";
  const isSavePoint = routeId === "save-point-detail";
  const isReplay = routeId === "replay" || routeId === "replay-detail";
  const isCompare = routeId === "compare";
  return <div className="app-shell">
    <header className="app-bar">
      <ReMoBrand />
      <span className="product-context" aria-label="Feature VS-002">/ <strong>VS-002</strong></span>
    </header>
    <div className="app-body">
      <nav className="app-rail" aria-label="VS-002 workflow">
        <ul>
          <li className={isBoundarySetup ? "active" : undefined}><a href="/boundary/setup" aria-current={isBoundarySetup ? "page" : undefined}><RailIcon kind="boundary" /><span><strong>Boundary setup</strong><small>Preflight</small></span></a></li>
          <li className={isActiveTurn ? "active" : undefined}><a href="/capture/active" aria-current={isActiveTurn ? "page" : undefined}><RailIcon kind="turn" /><span><strong>Run turn</strong><small>{isActiveTurn ? "Recording" : "Recording off"}</small></span></a></li>
          <li className={isCandidate ? "active" : undefined}><a href="/candidate/review" aria-current={isCandidate ? "page" : undefined}><RailIcon kind="review" /><span><strong>Review</strong><small>{isCandidate ? "Candidate" : "After turn"}</small></span></a></li>
          <li className={isSavedResults ? "active" : undefined}><a href="/save-points" aria-current={isSavedResults ? "page" : undefined}><RailIcon kind="evidence" /><span><strong>Saved results</strong><small>Durable evidence</small></span></a></li>
          <li className={isReplay ? "active" : undefined}><a href="/replay" aria-current={isReplay ? "page" : undefined}><RailIcon kind="evidence" /><span><strong>Replay</strong><small>{isReplay ? "Read-only history" : "Bounded playback"}</small></span></a></li>
          <li className={isCompare ? "active" : undefined}><a href="/compare" aria-current={isCompare ? "page" : undefined}><RailIcon kind="review" /><span><strong>Compare</strong><small>{isCompare ? "Before and after" : "Evidence comparison"}</small></span></a></li>
          {isSavePoint && savePoint !== undefined ? <li className="active"><a href={savePoint.stablePath} aria-current="page"><RailIcon kind="evidence" /><span><strong>Evidence</strong><small>{savePoint.displayId}</small></span></a></li> : null}
        </ul>
      </nav>
      <main className="app-main">{children}</main>
    </div>
  </div>;
}

export function App({ activeTurn = window.__REMO_ACTIVE_TURN__, candidate = window.__REMO_CANDIDATE__, promotionClient, reconcileClient, lifecycleClient, decisionClient }: { readonly activeTurn?: ActiveTurnBootstrap; readonly candidate?: CandidateProjection; readonly promotionClient?: PromotionClient; readonly reconcileClient?: ReconcileClient; readonly lifecycleClient?: LifecycleClient; readonly decisionClient?: DecisionClient }): ReactElement {
  const location = globalThis.location;
  const path = location.pathname;
  const route = matchProductRoute(path);
  const isActiveTurn = route?.id === "capture-active";
  const isCandidate = route?.id === "candidate-review";
  const isSavedResults = route?.id === "save-points";
  const replaySavePointId = route?.id === "replay-detail" ? route.params.id : undefined;
  const isReplayDetail = replaySavePointId !== undefined;
  const savePointRoute = route?.id === "save-point-detail" ? route.params.id : undefined;
  const isSavePoint = savePointRoute !== undefined;
  const isMalformedSavePoint = isSavePoint && !isValidProductSavePointId(savePointRoute);
  const savePoint = window.__REMO_SAVE_POINT__;
  const routeBootstrap = window.__REMO_ROUTE_BOOTSTRAP__;
  const replayRouteState: "not-replay-detail" | RouteRecoveryState = !isReplayDetail
    ? "not-replay-detail"
    : !isValidProductSavePointId(replaySavePointId)
      ? "malformed"
      : routeBootstrap?.route !== path
        ? savePoint === undefined ? "bootstrap-absent" : savePoint.savePointId === replaySavePointId ? "ready" : "missing"
        : routeBootstrap.state;
  const savePointRouteState: "not-save-point" | "unavailable" | "mismatch" | "ready" | "bootstrap-absent" | "missing" | "deleted" | "expired" | "quarantined" | "unsupported-policy" | "malformed" = !isSavePoint
    ? "not-save-point"
    : isMalformedSavePoint
      ? "malformed"
    : routeBootstrap?.route !== path
      ? savePoint === undefined ? "unavailable" : savePoint.savePointId !== savePointRoute || savePoint.stablePath !== path ? "mismatch" : "ready"
      : routeBootstrap.state === "ready"
        ? savePoint === undefined ? "unavailable" : savePoint.savePointId !== savePointRoute || savePoint.stablePath !== path ? "mismatch" : "ready"
        : routeBootstrap.state;
  const savePointSessionToken = window.__REMO_SAVE_POINT_SESSION__?.sessionToken;

  if (!isSupportedOrigin(location)) return <AppShell path={path}><UnsupportedOriginState /></AppShell>;

  const detailClient = reconcileClient ?? (savePoint === undefined || savePointSessionToken === undefined ? undefined : createLoopbackReconcileClient({ origin: location.origin, sessionToken: savePointSessionToken }));
  const detailLifecycleClient = lifecycleClient ?? (savePoint === undefined || savePointSessionToken === undefined ? undefined : createLoopbackLifecycleClient({ origin: location.origin, sessionToken: savePointSessionToken }));
  const serverCandidate = candidate !== undefined;
  const turnClient = isActiveTurn && activeTurn !== undefined
    ? createLoopbackTurnClient({ origin: location.origin, turnId: activeTurn.turnId, sessionToken: activeTurn.sessionToken })
    : undefined;
  const sessionToken = promotionSessionToken();
  const durableClient = isCandidate && serverCandidate
    ? promotionClient ?? (sessionToken === undefined ? undefined : createLoopbackPromotionClient({ origin: location.origin, sessionToken }))
    : undefined;
  const structuredDecisionClient = decisionClient ?? (sessionToken === undefined ? undefined : createLoopbackDecisionClient({ origin: location.origin, sessionToken }));

  const content = isSavedResults
    ? <SavedResults />
    : savePointRouteState === "ready"
      ? <SavePointDetail detail={savePoint!} {...(detailLifecycleClient === undefined ? {} : { lifecycleClient: detailLifecycleClient })} {...(detailClient === undefined ? {} : { onReconcile: () => detailClient.reconcile(savePoint!.savePointId) })} />
      : savePointRouteState === "unavailable"
        ? <section className="route-error" role="alert"><h1>Evidence detail unavailable</h1><p>The local service did not provide evidence for this stable save-point route. No durable state is being synthesized.</p></section>
        : savePointRouteState === "mismatch"
          ? <section className="route-error" role="alert"><h1>Evidence identity mismatch</h1><p>The local service response does not match this stable save-point URL. The evidence view is blocked.</p></section>
          : savePointRouteState === "bootstrap-absent" || savePointRouteState === "missing" || savePointRouteState === "deleted" || savePointRouteState === "expired" || savePointRouteState === "quarantined" || savePointRouteState === "unsupported-policy" || savePointRouteState === "malformed"
            ? <RecoveryState state={savePointRouteState} />
            : isCandidate
              ? candidate === undefined
                ? <CandidateReview candidate={candidateFixtureFromUrl()} fixtureLabel="Bootstrap absent - client preview fixture - non-promotable" />
                : <CandidateReview candidate={candidate} {...(window.__REMO_CANDIDATE_FIXTURE_LABEL__ === undefined ? {} : { fixtureLabel: window.__REMO_CANDIDATE_FIXTURE_LABEL__ })} {...(durableClient === undefined ? {} : { onPromote: (intent) => durableClient.promote(intent) })} {...(window.__REMO_DECISION_ENTRY_REQUIRED__ === true && structuredDecisionClient !== undefined ? { decisionClient: structuredDecisionClient } : {})} />
              : isActiveTurn
                ? activeTurn === undefined || turnClient === undefined
                  ? <section className="route-error" role="alert"><h1>Active turn unavailable</h1><p>The local control service did not provide an authenticated active-turn bootstrap. No recording state is being claimed.</p></section>
                  : <ActiveTurn repository={activeTurn.repository} route={activeTurn.route} turnId={activeTurn.turnId} startedAt={activeTurn.startedAt} onStop={() => turnClient.stop([{ kind: "human-intervention", boundaryId: "user-stop", occurredAt: new Date().toISOString() }])} />
                : route?.id === "replay-detail" && replayRouteState !== "ready" && replayRouteState !== "deleted"
                  ? <RecoveryState state={replayRouteState as Exclude<RouteRecoveryState, "ready">} />
                  : route?.id === "replay" || route?.id === "replay-detail"
                    ? <div className="replay-decision-extension"><ComparisonReturnLink /><ReplayWorkspace {...(replaySavePointId === undefined ? {} : { initialSavePointId: replaySavePointId })} {...(replayRouteState === "ready" && savePoint?.revision !== undefined ? { initialDetail: { ...savePoint, revision: savePoint.revision } } : {})} /><DecisionCardRouteMount /></div>
                  : route?.id === "compare"
                    ? <ComparisonWorkspace />
                    : route === undefined
                      ? <section className="route-error" role="alert"><h1>Workflow route not found</h1><p>Open a registered ReMo workflow route to continue.</p></section>
                      : <BoundarySetup />;

  return <AppShell path={path} {...(savePointRouteState === "ready" ? { savePoint } : {})}>{content}</AppShell>;
}
