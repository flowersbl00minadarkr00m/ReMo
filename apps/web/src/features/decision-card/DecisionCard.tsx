import { useEffect, useMemo, useRef, useState } from "react";
import type { DecisionField, DecisionOption, DecisionRecord, DecisionUncertainty } from "@remo/domain/browser";
import { createLoopbackDecisionClient, type DecisionClient, type DecisionProjection } from "./decision-client.js";
import "./DecisionCard.css";
import "./DecisionEntryExtensions.css";

const field = <T,>(label: string, value: DecisionField<T>, render: (input: T) => string = String) => <div className="decision-field"><dt>{label}</dt><dd><strong>{value.value === undefined ? "Unknown" : render(value.value)}</strong><span className={`provenance provenance-${value.provenance}`}>{value.provenance}</span><small>Recorded {value.recordedAt}{value.confirmedAt === undefined ? "" : ` · confirmed ${value.confirmedAt} · provenance unchanged`}</small></dd></div>;

function optionSummary(record: DecisionRecord): string {
  if (record.options.value === undefined) return "Unknown";
  return record.options.value.map(({ id, label }) => `${id === record.selectedOptionId.value ? "Selected — " : ""}${label}`).join(" · ");
}

function changedSummary(previous: DecisionRecord | undefined, record: DecisionRecord): string {
  if (previous === undefined) return "Contemporaneous base revision";
  const fields = ["question", "options", "selectedOptionId", "owner", "uncertainty", "expectedEffect", "verification", "outcome"] as const;
  const changed = fields.filter((name) => JSON.stringify(previous[name]) !== JSON.stringify(record[name]));
  return changed.length === 0 ? "Evidence references updated" : `Changed: ${changed.join(", ")}`;
}

export function DecisionCard({ savePointId, turnId, majorTurnExplanation, client: providedClient }: { readonly savePointId: string; readonly turnId: string; readonly majorTurnExplanation: string; readonly client?: DecisionClient }) {
  const client = useMemo(() => providedClient ?? createLoopbackDecisionClient({ origin: window.location.origin, ...(window.__REMO_SAVE_POINT_SESSION__?.sessionToken === undefined ? {} : { sessionToken: window.__REMO_SAVE_POINT_SESSION__.sessionToken }) }), [providedClient]);
  const [state, setState] = useState<{ readonly status: "loading" } | { readonly status: "missing" } | { readonly status: "error" } | { readonly status: "ready"; readonly value: DecisionProjection }>({ status: "loading" });
  const readRef = useRef<{
    readonly client: DecisionClient;
    readonly savePointId: string;
    readonly turnId: string;
    readonly controller: AbortController;
    readonly promise: Promise<DecisionProjection | undefined>;
    pending: boolean;
    consumers: number;
  }>();
  useEffect(() => {
    setState({ status: "loading" });
    let read = readRef.current;
    if (read === undefined || read.client !== client || read.savePointId !== savePointId || read.turnId !== turnId || !read.pending || read.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = client.read(savePointId, controller.signal);
      read = { client, savePointId, turnId, controller, promise, pending: true, consumers: 0 };
      const created = read;
      void promise.then(() => { created.pending = false; }, () => { created.pending = false; });
      readRef.current = read;
    }
    const consumed = read;
    consumed.consumers += 1;
    let active = true;
    void consumed.promise.then((value) => {
      if (active && !consumed.controller.signal.aborted) setState(value === undefined ? { status: "missing" } : value.current.turnId !== turnId ? { status: "error" } : { status: "ready", value });
    }, () => {
      if (active && !consumed.controller.signal.aborted) setState({ status: "error" });
    });
    return () => {
      active = false;
      consumed.consumers -= 1;
      queueMicrotask(() => {
        if (consumed.consumers !== 0) return;
        if (consumed.pending) consumed.controller.abort();
        if (readRef.current === consumed) readRef.current = undefined;
      });
    };
  }, [client, savePointId, turnId]);
  if (state.status === "loading") return <section className="decision-card state" aria-label="Decision evidence" role="status"><h2>Loading decision evidence</h2></section>;
  if (state.status === "missing") return <section className="decision-card state" aria-label="Decision evidence"><p className="decision-kicker">Structured decision evidence</p><h2>Decision context unknown</h2><p>No structured decision revision is preserved for this turn. ReMo has not reconstructed rationale, ownership, certainty, options, or outcome.</p></section>;
  if (state.status === "error") return <section className="decision-card state error" aria-label="Decision evidence" role="alert"><h2>Decision evidence unavailable</h2><p>The decision identity or revision chain could not be validated. No partial story is displayed.</p></section>;
  const record = state.value.current;
  return <section className="decision-card" aria-labelledby="decision-card-title">
    <header><div><p className="decision-kicker">Structured decision evidence · revision {record.revision}</p><h2 id="decision-card-title">{record.question.value ?? "Decision question unknown"}</h2><p><strong>Why this was a major turn:</strong> {majorTurnExplanation}</p></div><span className="decision-digest">{record.digest}</span></header>
    <dl className="decision-fields">
      {field<string>("Question", record.question)}
      {field<readonly DecisionOption[]>("Options and selection", record.options, () => optionSummary(record))}
      {field<string>("Selected option", record.selectedOptionId, (id) => record.options.value?.find((option: DecisionOption) => option.id === id)?.label ?? id)}
      {field<string>("Owner", record.owner)}
      {field<DecisionUncertainty>("Uncertainty", record.uncertainty, (value) => `${value.level} · source ${value.source}`)}
      {field<string>("Expected effect", record.expectedEffect)}
      {field<string>("Verification", record.verification)}
      {field<string>("Known outcome", record.outcome)}
    </dl>
    <div className="decision-evidence"><h3>Evidence references</h3>{record.evidenceComponentIds.length === 0 ? <p>Unknown — no evidence reference was recorded.</p> : <ul>{record.evidenceComponentIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul>}</div>
    <details className="decision-revisions"><summary>Revision and supersession trail ({state.value.revisions.length})</summary><ol>{state.value.revisions.map((revision, index) => <li key={revision.digest}><strong>Revision {revision.revision}</strong><span>{changedSummary(state.value.revisions[index - 1], revision)}</span><code>{revision.digest}</code><small>{revision.predecessorDigest === undefined ? "No predecessor — original preserved revision" : `Predecessor ${revision.predecessorDigest}`}</small></li>)}</ol></details>
  </section>;
}
