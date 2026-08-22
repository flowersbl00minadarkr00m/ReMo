import {
  discardCandidate,
  requestConfirmIntent,
  type CandidateProjection,
  type ConfirmIntent,
} from "@remo/domain/browser";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DurableSaveProjection } from "./promotion-client.js";
import { CandidateDecisionEntry } from "../decision-card/CandidateDecisionEntry.js";
import type { DecisionClient } from "../decision-card/decision-client.js";

interface CandidateReviewProps {
  readonly candidate: CandidateProjection;
  readonly fixtureLabel?: string;
  readonly onConfirmIntent?: (intent: ConfirmIntent) => void;
  readonly onPromote?: (intent: Extract<ConfirmIntent, { status: "ready-for-durable-promotion" }>) => Promise<DurableSaveProjection>;
  readonly onDiscard?: (candidate: CandidateProjection) => void;
  readonly decisionClient?: DecisionClient;
}

type PromotionState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly message: string; readonly retryable: boolean }
  | { readonly status: "durable"; readonly save: DurableSaveProjection };

const STATE_COPY = {
  candidate: { label: "Candidate — not yet saved", explanation: "Privacy and evidence checks pass. It remains non-durable until the local repository confirms the explicit promotion." },
  quarantined: { label: "Candidate quarantined", explanation: "A privacy gate failed. Unsafe replay and screenshot bytes were released; only a metadata receipt remains." },
  inconsistent: { label: "Candidate inconsistent", explanation: "Source and rendered evidence disagree. Reproducibility and confirmation are blocked." },
  incomplete: { label: "Candidate incomplete", explanation: "A required component or correlation proof is missing. Safe local evidence remains labeled and confirmation is blocked." },
  discarded: { label: "Candidate discarded", explanation: "The in-memory candidate evidence was released. Source history was not changed." },
} as const;

function CanonicalState({ label, value, explanation, tone }: { readonly label: string; readonly value: string; readonly explanation: string; readonly tone: string }) {
  return <div className={`candidate-state ${tone}`}><span className="candidate-state-icon" aria-hidden="true">{tone === "pass" ? "✓" : tone === "warn" ? "!" : "×"}</span><span><small>{label}</small><strong>{value}</strong><span>{explanation}</span></span></div>;
}

function Preview({ kind, available }: { readonly kind: "Screenshot" | "Replay"; readonly available: boolean }) {
  return available ? (
    <figure className="candidate-preview">
      <div className={`preview-frame ${kind.toLowerCase()}`} role="img" aria-label={`${kind} preview is privacy-cleared; sensitive fixture regions are masked in purple.`}><span aria-hidden="true">Masked</span></div>
      <figcaption><strong>{kind}</strong><span>Privacy-cleared immutable evidence · sensitive regions masked</span></figcaption>
    </figure>
  ) : (
    <div className="candidate-preview unavailable" role="note"><strong>{kind} unavailable</strong><span>No visual payload is available for ordinary viewing in this state.</span></div>
  );
}

function utc(value: string): string {
  return `${new Date(value).toLocaleString("en-CA", { timeZone: "UTC" })} UTC`;
}

export function CandidateReview({ candidate, fixtureLabel, onConfirmIntent, onPromote, onDiscard, decisionClient }: CandidateReviewProps) {
  const [projection, setProjection] = useState(candidate);
  const [promotion, setPromotion] = useState<PromotionState>({ status: "idle" });
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [decisionSaved, setDecisionSaved] = useState(false);
  const blockingSummary = useRef<HTMLDivElement>(null);
  const promotionFailure = useRef<HTMLDivElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  const discardDialog = useRef<HTMLDivElement>(null);
  const discardWasOpen = useRef(false);
  const discardCloseFocus = useRef<"trigger" | "heading">("trigger");
  const pageHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (["quarantined", "inconsistent", "incomplete"].includes(projection.state)) blockingSummary.current?.focus();
  }, [projection.state]);
  useEffect(() => {
    if (promotion.status === "failed") promotionFailure.current?.focus();
  }, [promotion.status]);
  useEffect(() => {
    if (confirmingDiscard) {
      discardWasOpen.current = true;
      discardCloseFocus.current = "trigger";
      discardDialog.current?.focus();
    } else if (discardWasOpen.current) {
      discardWasOpen.current = false;
      queueMicrotask(() => {
        if (discardCloseFocus.current === "heading") pageHeading.current?.focus();
        else if (discardButton.current?.isConnected === true && !discardButton.current.disabled) discardButton.current.focus();
        else pageHeading.current?.focus();
      });
    }
  }, [confirmingDiscard]);

  async function confirm(): Promise<void> {
    if (promotion.status === "pending" || promotion.status === "durable") return;
    if (decisionClient !== undefined && !decisionSaved) {
      setAnnouncement("Record the contemporaneous decision before durable promotion.");
      return;
    }
    const intent = requestConfirmIntent(projection);
    if (intent.status === "blocked") {
      setAnnouncement("Confirmation remains blocked until every blocking check passes.");
      blockingSummary.current?.focus();
      return;
    }
    onConfirmIntent?.(intent);
    setPromotion({ status: "pending" });
    setAnnouncement("Durable promotion pending. ReMo is writing the privacy-cleared bundle to local storage.");
    try {
      if (onPromote === undefined) throw new Error("The local promotion service is unavailable. Start the authenticated loopback service, then retry the same candidate.");
      const save = await onPromote(intent);
      if (save.turnId !== projection.turnId) throw new Error("The durable result did not match this candidate turn.");
      setPromotion({ status: "durable", save });
      setAnnouncement(`Durable save created with identity ${save.savePointId}. It is unpinned and expires ${utc(save.expiresAt)}.`);
      pageHeading.current?.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The local durable save failed.";
      const retryable = typeof error === "object" && error !== null && "retryable" in error ? (error as { retryable?: unknown }).retryable === true : true;
      setPromotion({ status: "failed", message, retryable });
      setAnnouncement(`Durable promotion failed. ${message}`);
    }
  }

  function cancelDiscard(): void {
    discardCloseFocus.current = "trigger";
    setConfirmingDiscard(false);
  }

  function completeDiscard(): void {
    const discarded = discardCandidate(projection);
    onDiscard?.(discarded);
    setProjection(discarded);
    discardCloseFocus.current = "heading";
    setConfirmingDiscard(false);
    setAnnouncement("Candidate discarded. In-memory previews were released; source history is unchanged.");
  }

  function trapDiscardFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDiscard();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (buttons.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = buttons[0]!;
    const last = buttons.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      first.focus();
    }
  }

  const stateCopy = STATE_COPY[projection.state];
  const durable = promotion.status === "durable" ? promotion.save : undefined;
  const isBlocked = !projection.canConfirm || (decisionClient !== undefined && !decisionSaved);
  const privacyLabel = projection.privacy.status === "passed" ? "Pass" : "Quarantined";
  return (
    <div className={`candidate-layout state-${durable === undefined ? projection.state : "durable"}${decisionClient === undefined ? "" : " has-decision-entry"}`}>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      <header className="candidate-heading">
        <div>
          {fixtureLabel ? <p className="candidate-kicker">{fixtureLabel}</p> : null}
          <h1 ref={pageHeading} tabIndex={-1}>Review candidate</h1>
          <p>Inspect why this bounded turn was nominated and what ReMo can safely claim.</p>
        </div>
        <span className={durable === undefined ? "non-durable-pill" : "durable-pill"}>{durable === undefined ? "Non-durable" : "Durable · unpinned"}</span>
      </header>

      <div className="candidate-columns">
        <div className="candidate-primary">
          <section className="candidate-hero" aria-labelledby="candidate-state-title">
            <span className="candidate-hero-symbol" aria-hidden="true">{durable !== undefined ? "✓" : projection.state === "candidate" ? "−" : "!"}</span>
            <div><h2 id="candidate-state-title">{durable === undefined ? stateCopy.label : "Durable save created"}</h2><p>{durable === undefined ? stateCopy.explanation : "The repository confirmed one immutable local manifest. Repeated confirmation returns this same identity and digest."}</p></div>
          </section>

          <section className="nomination-strip" aria-labelledby="nomination-title">
            <div><small>Turn identity</small><code>{projection.turnId}</code></div>
            <div><small id="nomination-title">Nomination signals</small><strong>{projection.nominationCategories.join(", ") || "None"}</strong></div>
            <div><small>Boundary events</small><strong>{projection.nominationBoundaries.join(", ") || "None"}</strong></div>
          </section>

          <section className="candidate-state-grid" aria-label="Candidate trust states">
            <CanonicalState label="Privacy" value={privacyLabel} explanation={projection.privacy.status === "passed" ? "Canary, fields, scope, and mask regions passed." : "Unsafe payloads were not retained."} tone={projection.privacy.status === "passed" ? "pass" : "danger"} />
            <CanonicalState label="Integrity" value={projection.integrity.state} explanation={projection.integrity.state === "complete" ? "Required component identities agree." : "See blocking reason codes."} tone={projection.integrity.state === "complete" ? "pass" : "danger"} />
            <CanonicalState label="Fidelity" value={projection.fidelity.state} explanation={projection.reproducible ? "Future eligibility claim only; rewind is unavailable." : "Reproducibility is not claimed."} tone={projection.fidelity.state === "editable-eligible" ? "warn" : "danger"} />
          </section>

          <section className="preview-grid" aria-labelledby="preview-title">
            <h2 id="preview-title">Rendered evidence</h2>
            <Preview kind="Screenshot" available={projection.screenshotPreviewAvailable} />
            <Preview kind="Replay" available={projection.replayPreviewAvailable} />
          </section>

          {decisionClient === undefined ? null : <CandidateDecisionEntry candidate={projection} client={decisionClient} onSaved={() => { setDecisionSaved(true); setAnnouncement("Contemporaneous decision revision recorded. Durable promotion is now available."); }} />}

          <section className="evidence-card" aria-labelledby="evidence-title">
            <h2 id="evidence-title">Evidence join</h2>
            {projection.components.length === 0 ? <p className="empty-evidence">Component payloads are hidden because this candidate is quarantined. The receipt identifies only failed component classes and reason codes.</p> : (
              <div className="evidence-table-wrap"><table><thead><tr><th>Component</th><th>Status</th><th>Authority</th><th>Provenance</th></tr></thead><tbody>{projection.components.map((component) => <tr key={component.componentType}><th scope="row">{component.label}</th><td><span className={`component-status ${component.identityStatus}`}>{component.identityStatus}</span>{component.availability !== "available" ? ` · ${component.availability}` : ""}</td><td>{component.authority}</td><td>{component.provenance}</td></tr>)}</tbody></table></div>
            )}
          </section>
        </div>

        <aside className="candidate-aside" aria-label="Before confirmation">
          <section className="before-confirm-card">
            <h2>{durable === undefined ? "Before you confirm" : "Durable local save"}</h2>
            <ul>
              {durable === undefined ? <>
                <li><span aria-hidden="true">{isBlocked ? "×" : "✓"}</span><strong>{isBlocked ? "Blocking checks remain" : "All blocking checks passed"}</strong></li>
                <li><span aria-hidden="true">◷</span><span><strong>Candidate expires in 7 days</strong><small>{utc(projection.expiresAt)}</small></span></li>
                <li><span aria-hidden="true">⌂</span><span><strong>Local, in memory</strong><small>Not yet written to durable storage</small></span></li>
                <li><span aria-hidden="true">!</span><span><strong>Explicit confirmation required</strong><small>Readiness is not persistence</small></span></li>
              </> : <>
                <li><span aria-hidden="true">✓</span><span><strong>{durable.savePointId}</strong><small>Stable save-point identity</small></span></li>
                <li><span aria-hidden="true">#</span><span><strong className="durable-digest">{durable.manifestDigest}</strong><small>Immutable manifest digest</small></span></li>
                <li><span aria-hidden="true">◷</span><span><strong>Expires 30 days after promotion</strong><small>{utc(durable.expiresAt)}</small></span></li>
                <li><span aria-hidden="true">⌂</span><span><strong>Unpinned</strong><small>Created {utc(durable.createdAt)} · promoted {utc(durable.promotedAt)}</small></span></li>
              </>}
            </ul>
          </section>
          {isBlocked ? <div className="candidate-blocking" ref={blockingSummary} tabIndex={-1} role="alert"><h2>Confirmation blocked</h2><p>{decisionClient !== undefined && !decisionSaved && projection.canConfirm ? "Record the bounded contemporaneous decision before durable promotion." : projection.state === "quarantined" ? "Privacy takes precedence. Recapture only after the mask policy is corrected." : projection.blockingReasons.includes("candidate.confirmation-binding-missing") ? "The server-issued confirmation binding is unavailable. This preview cannot create a durable save." : "Resolve the named evidence state, then re-evaluate the same candidate identity."}</p><ul>{decisionClient !== undefined && !decisionSaved && projection.canConfirm ? <li><code>decision.contemporaneous-record-required</code></li> : projection.blockingReasons.map((reason) => <li key={reason}><code>{reason}</code></li>)}</ul></div> : null}
          {promotion.status === "failed" ? <div className="candidate-blocking promotion-failure" ref={promotionFailure} tabIndex={-1} role="alert"><h2>Durable save not created</h2><p>{promotion.message}</p><code>{promotion.retryable ? "promotion.retryable" : "promotion.blocked"}</code></div> : null}
        </aside>
      </div>

      {confirmingDiscard ? <div className="discard-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-copy" tabIndex={-1} ref={discardDialog} onKeyDown={trapDiscardFocus}><div><h2 id="discard-title">Discard this candidate?</h2><p id="discard-copy">This releases in-memory candidate evidence. It does not delete or alter source history.</p><div><button className="button secondary-button" type="button" onClick={cancelDiscard}>Keep candidate</button><button className="button danger-button" type="button" onClick={completeDiscard}>Discard safely</button></div></div></div> : null}

      <footer className="candidate-footer">
        <p><strong>{durable === undefined ? stateCopy.label : "Durable save confirmed"}.</strong> {durable === undefined ? "Candidate and durable save states remain distinct." : "Stored locally; rewind, timeline, branching, and document support are not claimed."}</p>
        {durable === undefined ? <div><button ref={discardButton} className="button secondary-button" type="button" onClick={() => setConfirmingDiscard(true)} disabled={projection.state === "discarded" || promotion.status === "pending"}>Discard</button><button className="button primary-button" type="button" onClick={() => void confirm()} disabled={isBlocked || promotion.status === "pending"}>{promotion.status === "pending" ? "Saving locally…" : promotion.status === "failed" && promotion.retryable ? "Retry durable save" : "Confirm durable save"}</button></div> : null}
      </footer>
    </div>
  );
}
