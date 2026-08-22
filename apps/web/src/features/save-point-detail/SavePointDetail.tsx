import { useEffect, useRef, useState } from "react";
import type { EvidenceDetailComponent, EvidenceDetailProjection } from "./save-point-fixtures.js";
import { LifecyclePanel } from "../lifecycle/LifecyclePanel.js";
import type { LifecycleClient, LifecycleView } from "../lifecycle/lifecycle-client.js";
import { EvidenceMediaPanel } from "../evidence-media/EvidenceMediaPanel.js";
import type { EvidenceMediaClient } from "../evidence-media/evidence-media-client.js";
import "./SavePointDetail.css";

function State({ label, value, explanation, tone }: { readonly label: string; readonly value: string; readonly explanation: string; readonly tone: "pass" | "warn" | "danger" }) {
  return <div className={`detail-state ${tone}`}><span className="detail-state-mark" aria-hidden="true">{tone === "pass" ? "✓" : "!"}</span><span><small>{label}</small><strong>{value}</strong><span>{explanation}</span></span></div>;
}

function ComponentRow({ component }: { readonly component: EvidenceDetailComponent }) {
  const availabilityClass = component.availability === "Available" ? "available" : component.availability === "Unreachable" ? "unreachable" : "conflicting";
  const authorityLabel = component.authorityMode === "fixture" ? `Synthetic ${component.authority} authority` : `${component.authority} authority`;
  const policyLabel = component.policyCategory.status === "available" ? `${component.policyCategory.category} policy` : "Policy category unavailable";
  return <li className="detail-component">
    <div className="component-heading">
      <span className="component-symbol" aria-hidden="true">{component.type === "source" ? "</>" : component.type === "screenshot" ? "▧" : component.type === "trace" ? "◎" : "◇"}</span>
      <span><strong>{component.label}</strong><small>{authorityLabel} · {component.provenance}</small></span>
      <span className={`availability ${availabilityClass}`}>{component.availability}</span>
    </div>
    <p>{component.description}</p>
    <div className="component-meta"><span>{policyLabel} <code>{component.policyRevision}</code></span>{component.local ? <span>Stored locally</span> : <span>External authority</span>}</div>
    {component.externalUrl === undefined ? null : <a className="detail-link" href={component.externalUrl} target="_blank" rel="noopener noreferrer">{component.externalLabel}<span aria-hidden="true"> ↗</span></a>}
  </li>;
}

function PolicyRevisionRow({ label, projection }: { readonly label: string; readonly projection: EvidenceDetailProjection["policyRevisions"][keyof EvidenceDetailProjection["policyRevisions"]] }) {
  return <div><dt>{label}</dt><dd>{projection.status === "available" ? <code>{projection.revision}</code> : <><strong>Unavailable</strong><span>{projection.reason === "category-mismatch" ? `Expected ${projection.expectedCategory}; category mismatch; no substitution.` : `Expected ${projection.expectedCategory}; revision is not mapped.`}</span></>}</dd></div>;
}

export function SavePointDetail({ detail, onReconcile, lifecycleClient, evidenceMediaClient }: { readonly detail: EvidenceDetailProjection; readonly onReconcile?: () => Promise<EvidenceDetailProjection>; readonly lifecycleClient?: LifecycleClient; readonly evidenceMediaClient?: EvidenceMediaClient }) {
  const [displayedDetail, setDisplayedDetail] = useState(detail);
  const [retryState, setRetryState] = useState<"idle" | "requested" | "succeeded" | "failed">("idle");
  const [blockedLifecycle, setBlockedLifecycle] = useState<"quarantined" | "deleted" | "expired">();
  const summaryRef = useRef<HTMLElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const incomplete = displayedDetail.integrity.state === "Incomplete";
  const inconsistent = displayedDetail.integrity.state === "Inconsistent";
  const reconcile = async (): Promise<void> => {
    if (onReconcile === undefined) return;
    setRetryState("requested");
    try {
      const projection = await onReconcile();
      if (projection.savePointId !== displayedDetail.savePointId || projection.turnId !== displayedDetail.turnId || projection.stablePath !== displayedDetail.stablePath) throw new Error("Reconciliation changed the displayed identity.");
      setDisplayedDetail(projection);
      setRetryState("succeeded");
    } catch { setRetryState("failed"); }
  };
  useEffect(() => {
    if (retryState === "succeeded") summaryRef.current?.focus();
    if (retryState === "failed") retryRef.current?.focus();
  }, [retryState]);
  const announcement = retryState === "requested"
    ? "Correlation retry requested for this same save identity."
    : retryState === "succeeded"
      ? `Correlation updated. Integrity is now ${displayedDetail.integrity.state}.`
      : retryState === "failed"
        ? "Correlation remains unavailable. Local evidence is unchanged."
        : "";
  const retention = displayedDetail.retention as EvidenceDetailProjection["retention"] & { readonly createdAt?: string; readonly originalExpiresAt?: string; readonly pinnedAt?: string; readonly state?: "active" | "quarantined" };
  const lifecycle: LifecycleView = {
    subject: "durable",
    id: displayedDetail.savePointId,
    turnId: displayedDetail.turnId,
    savePointId: displayedDetail.savePointId,
    revision: displayedDetail.revision ?? 1,
    state: retention.state ?? "active",
    createdAt: retention.createdAt ?? retention.promotedAt,
    promotedAt: retention.promotedAt,
    originalExpiresAt: retention.originalExpiresAt ?? retention.expiresAt,
    expiresAt: retention.expiresAt,
    pinned: retention.pinned,
    ...(retention.pinnedAt === undefined ? {} : { pinnedAt: retention.pinnedAt }),
  };
  const screenshotAvailable = displayedDetail.components.some(({ type, availability }) => type === "screenshot" && availability === "Available");
  const replayAvailable = displayedDetail.components.some(({ type, availability }) => type === "rrweb" && availability === "Available");
  return <article className="save-detail" data-integrity={displayedDetail.integrity.state.toLocaleLowerCase("en-US")}>
    <header className="detail-heading">
      <div><p className="detail-kicker">Durable local save</p><h1>Save point {displayedDetail.displayId}</h1><p>{displayedDetail.nominationReason}</p></div>
      <span className="durable-badge">Durable</span>
    </header>

    <section className="detail-summary" aria-label="Trust summary" ref={summaryRef} tabIndex={-1}>
      <State label="Integrity" value={displayedDetail.integrity.state} explanation={displayedDetail.integrity.explanation} tone={displayedDetail.integrity.state === "Complete" ? "pass" : inconsistent ? "danger" : "warn"} />
      <State label="Fidelity" value={displayedDetail.fidelity.state} explanation={displayedDetail.fidelity.explanation} tone={displayedDetail.fidelity.state === "Editable eligible" ? "pass" : inconsistent ? "danger" : "warn"} />
      <State label="Privacy" value={displayedDetail.privacy.state} explanation={displayedDetail.privacy.explanation} tone="pass" />
    </section>

    {incomplete || inconsistent ? <section className={`detail-limitation ${inconsistent ? "danger" : "warn"}`} role="alert">
      <div><strong>{inconsistent ? "Authority conflict blocks trust" : "External trace unavailable"}</strong><p>{inconsistent ? "The conflicting identity cannot be promoted or treated as editable evidence." : "ReMo has not uploaded local evidence to compensate. The safely captured source, recording, screenshot, and verification remain available here."}</p></div>
      {incomplete ? <button className="button secondary-button" type="button" ref={retryRef} disabled={onReconcile === undefined || retryState === "requested"} onClick={() => void reconcile()}>{retryState === "requested" ? "Retrying trace correlation" : "Retry trace correlation"}</button> : null}
    </section> : null}
    <p className={`detail-live${retryState === "failed" ? " error" : ""}`} role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

    <div className="detail-columns">
      <div className="detail-primary">
        {blockedLifecycle === undefined ? <><section className="detail-card" id="local-screenshot">
          <EvidenceMediaPanel identity={{ savePointId: displayedDetail.savePointId, turnId: displayedDetail.turnId, revision: displayedDetail.revision ?? 1, manifestDigest: displayedDetail.manifestDigest }} screenshotAvailable={screenshotAvailable} replayAvailable={replayAvailable} {...(evidenceMediaClient === undefined ? {} : { client: evidenceMediaClient })} />
        </section>
        <section className="detail-card component-card" aria-labelledby="components-title">
          <div className="card-heading"><h2 id="components-title">Evidence components</h2><p>Authority, provenance, availability, and policy are explicit for every required component.</p></div>
          <ul>{displayedDetail.components.map((component) => <ComponentRow component={component} key={component.type} />)}</ul>
        </section></> : <section className="detail-card lifecycle-blocked" role="alert" tabIndex={-1}><p className="detail-kicker">Local evidence blocked</p><h2>{blockedLifecycle === "quarantined" ? "This save is quarantined" : blockedLifecycle === "deleted" ? "Controlled local evidence was deleted" : "This save expired"}</h2><p>{blockedLifecycle === "quarantined" ? "Ordinary payload viewing and promotion are blocked. Use redaction to regenerate a new candidate revision from safe source material." : "No local payload is displayed. Git and Langfuse remain external authorities that ReMo does not claim to delete."}</p></section>}
      </div>
      <aside className="detail-aside" aria-label="Save metadata">
        <section className="detail-card">
          <h2>Identity</h2>
          <dl className="metadata-list">
            <div><dt>Save identity</dt><dd><code>{displayedDetail.savePointId}</code></dd></div>
            <div><dt>Turn identity</dt><dd><code>{displayedDetail.turnId}</code></dd></div>
            <div><dt>Boundary</dt><dd><code>{displayedDetail.boundaryRevision}</code></dd></div>
            <div><dt>Stable URL</dt><dd><code>{displayedDetail.stablePath}</code></dd></div>
          </dl>
        </section>
        <LifecyclePanel initial={lifecycle} {...(lifecycleClient === undefined ? {} : { client: lifecycleClient })} onBlocked={setBlockedLifecycle} />
        <section className="detail-card">
          <h2>Policy revisions</h2>
          <dl className="metadata-list">{Object.entries(displayedDetail.policyRevisions).map(([label, projection]) => <PolicyRevisionRow key={label} label={label} projection={projection} />)}</dl>
        </section>
        <section className="detail-card digest-card"><h2>Manifest digest</h2><code>{displayedDetail.manifestDigest}</code></section>
      </aside>
    </div>
  </article>;
}
