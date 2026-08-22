import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryFilmstripItem } from "@remo/domain/browser";
import { BranchPreflightPanel } from "../branch-preflight/BranchPreflightPanel.js";
import {
  HOSTED_DEMO_BRANCH_SAVE_POINT_ID,
  HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION,
  createHostedDemoBranchOrchestrationClient,
  createHostedDemoBranchPreflightClient,
  originalFutureInventory,
} from "./hosted-demo-branch.js";
import type { HostedDemoFixtureBundle } from "./hosted-demo-fixture.js";
import { HOSTED_DEMO_ALTERNATE_LINEAGE_ID, HOSTED_DEMO_ORIGINAL_LINEAGE_ID, hostedDemoSessionUrl, parseHostedDemoSession, type HostedDemoSessionState } from "./hosted-demo-session.js";

export function HostedDemoBranchExperience({ fixture, items }: { readonly fixture: HostedDemoFixtureBundle; readonly items: readonly HistoryFilmstripItem[] }) {
  const [session, setSession] = useState<HostedDemoSessionState>(() => parseHostedDemoSession(window.location.search));
  const lineageStatus = useRef<HTMLParagraphElement>(null);
  const recoveryStatus = useRef<HTMLParagraphElement>(null);
  const preflightClient = useMemo(() => createHostedDemoBranchPreflightClient(fixture), [fixture]);
  const originalFuture = useMemo(() => originalFutureInventory(items), [items]);

  const replaceRecoveredState = useCallback((next: HostedDemoSessionState) => {
    if (next.recovery !== undefined) window.history.replaceState({}, "", hostedDemoSessionUrl(window.location.pathname, { branch: "not-created", lineage: HOSTED_DEMO_ORIGINAL_LINEAGE_ID }));
    setSession(next);
  }, []);

  useEffect(() => {
    if (session.recovery !== undefined) {
      window.history.replaceState({}, "", hostedDemoSessionUrl(window.location.pathname, { branch: "not-created", lineage: HOSTED_DEMO_ORIGINAL_LINEAGE_ID }));
      queueMicrotask(() => recoveryStatus.current?.focus());
    }
  }, [session.recovery]);

  useEffect(() => {
    const onPopState = () => replaceRecoveredState(parseHostedDemoSession(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [replaceRecoveredState]);

  const onCreated = useCallback(() => {
    const next: HostedDemoSessionState = { branch: "simulated-created", lineage: HOSTED_DEMO_ALTERNATE_LINEAGE_ID };
    window.history.pushState({}, "", hostedDemoSessionUrl(window.location.pathname, next));
    setSession(next);
  }, []);

  const orchestrationClient = useMemo(() => createHostedDemoBranchOrchestrationClient(fixture, { initiallyCreated: session.branch === "simulated-created", onCreated }), [fixture, onCreated, session.branch]);

  const selectLineage = useCallback((lineage: typeof HOSTED_DEMO_ORIGINAL_LINEAGE_ID | typeof HOSTED_DEMO_ALTERNATE_LINEAGE_ID) => {
    if (session.branch !== "simulated-created") return;
    const next: HostedDemoSessionState = { branch: "simulated-created", lineage };
    window.history.pushState({}, "", hostedDemoSessionUrl(window.location.pathname, next));
    setSession(next);
    queueMicrotask(() => lineageStatus.current?.focus());
  }, [session.branch]);

  return <section className="hosted-demo-branch" aria-labelledby="hosted-demo-branch-title">
    <header><p className="hosted-demo-eyebrow">Explicit simulation boundary</p><h2 id="hosted-demo-branch-title">Explore both futures without changing a repository</h2><p><strong>Simulated.</strong> No real repository is connected or changed.</p></header>
    {session.recovery === undefined ? null : <p ref={recoveryStatus} tabIndex={-1} className="hosted-demo-route-note" role="status" aria-label="Simulated branch state recovered">{session.recovery}</p>}
    <BranchPreflightPanel
      key={session.branch}
      savePointId={HOSTED_DEMO_BRANCH_SAVE_POINT_ID}
      savePointRevision={HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION}
      client={preflightClient}
      orchestrationClient={orchestrationClient}
      operationMode="simulated-demo"
      onBranchResult={() => {}}
    />
    <nav className="hosted-demo-lineage-navigation" aria-label="Original and simulated alternate futures">
      <button type="button" aria-pressed={session.lineage === HOSTED_DEMO_ORIGINAL_LINEAGE_ID} onClick={() => selectLineage(HOSTED_DEMO_ORIGINAL_LINEAGE_ID)}>Original future</button>
      <button type="button" aria-pressed={session.lineage === HOSTED_DEMO_ALTERNATE_LINEAGE_ID} disabled={session.branch !== "simulated-created"} onClick={() => selectLineage(HOSTED_DEMO_ALTERNATE_LINEAGE_ID)}>Alternate future</button>
      <p ref={lineageStatus} tabIndex={-1} role="status" aria-live="polite">{session.lineage === HOSTED_DEMO_ORIGINAL_LINEAGE_ID ? "Viewing the unchanged original fixture future." : "Viewing one fixed simulated alternate lineage. No real repository is connected or changed."}</p>
    </nav>
    {session.lineage === HOSTED_DEMO_ORIGINAL_LINEAGE_ID
      ? <section className="hosted-demo-future" aria-labelledby="original-future-title"><h3 id="original-future-title">Unchanged original fixture future</h3><p>These six immutable fixture identities are the same objects and inventory available before simulation.</p><ol>{originalFuture.map((item) => <li key={item.savePointId} data-testid="original-future-item"><span>Turn {item.sequenceNo}</span><code>{item.savePointId}</code><small>{item.state === "tombstone" ? "Safe tombstone identity" : item.majorTurnLabel}</small></li>)}</ol></section>
      : <section className="hosted-demo-future simulated" aria-labelledby="alternate-future-title"><p className="hosted-demo-eyebrow">Simulated · no mutation authority</p><h3 id="alternate-future-title">One fixed simulated alternate lineage</h3><p>No real repository is connected or changed. This browser-session projection is not persisted.</p><dl><div><dt>Operation</dt><dd><code>{fixture.simulatedBranch.operationId}</code></dd></div><div><dt>Lineage</dt><dd><code>{fixture.simulatedBranch.lineageId}</code></dd></div><div><dt>Root evidence</dt><dd><code>{fixture.simulatedBranch.savePointId}</code></dd></div></dl></section>}
  </section>;
}
