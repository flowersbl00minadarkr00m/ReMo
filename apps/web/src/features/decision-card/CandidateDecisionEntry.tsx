import { useEffect, useRef, useState } from "react";
import type { CandidateProjection, DecisionRecord } from "@remo/domain/browser";
import type { DecisionClient, DecisionProjection } from "./decision-client.js";
import "./DecisionCard.css";
import "./DecisionEntryExtensions.css";

export function CandidateDecisionEntry({ candidate, client, onSaved }: { readonly candidate: CandidateProjection; readonly client: DecisionClient; readonly onSaved: (record: DecisionRecord) => void }) {
  const [question, setQuestion] = useState("");
  const [firstOption, setFirstOption] = useState("");
  const [secondOption, setSecondOption] = useState("");
  const [selection, setSelection] = useState<"option-a" | "option-b" | "">("");
  const [owner, setOwner] = useState("");
  const [uncertainty, setUncertainty] = useState<"low" | "medium" | "high" | "">("");
  const [expectedEffect, setExpectedEffect] = useState("");
  const [expectedEffectInferred, setExpectedEffectInferred] = useState(false);
  const [verification, setVerification] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [state, setState] = useState<"recovering" | "idle" | "saving" | "saved" | "error">(client.readCandidate === undefined ? "idle" : "recovering");
  const [message, setMessage] = useState("");
  const status = useRef<HTMLParagraphElement>(null);
  const onSavedRef = useRef(onSaved);
  const recoveryRef = useRef<{
    readonly client: DecisionClient;
    readonly turnId: string;
    readonly savePointId: string | undefined;
    readonly controller: AbortController;
    readonly promise: Promise<DecisionProjection | undefined>;
    pending: boolean;
    consumers: number;
  }>();
  onSavedRef.current = onSaved;
  const binding = candidate.confirmationBinding;
  const evidenceOptions = candidate.components.filter(({ availability, componentType }) => availability === "available" && componentType !== "decision").map(({ componentType, label }) => ({ id: `${candidate.turnId}:${componentType}`, label }));

  useEffect(() => {
    const readCandidate = client.readCandidate;
    if (readCandidate === undefined) return;
    let recovery = recoveryRef.current;
    if (recovery === undefined || recovery.client !== client || recovery.turnId !== candidate.turnId || recovery.savePointId !== binding?.savePointId || !recovery.pending || recovery.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = readCandidate(candidate.turnId, controller.signal);
      recovery = { client, turnId: candidate.turnId, savePointId: binding?.savePointId, controller, promise, pending: true, consumers: 0 };
      void promise.then(() => { recovery!.pending = false; }, () => { recovery!.pending = false; });
      recoveryRef.current = recovery;
    }
    recovery.consumers += 1;
    let active = true;
    void recovery.promise.then((projection) => {
      if (!active) return;
      if (projection === undefined) { setState("idle"); return; }
      const record = projection.current;
      if (record.decisionId !== `decision-${candidate.turnId}` || record.savePointId !== binding?.savePointId || record.turnId !== candidate.turnId || record.revision !== 1) throw new Error("Existing candidate decision identity does not match this candidate.");
      setState("saved");
      setMessage(`Recovered decision revision ${record.revision} recorded before promotion. Outcome remains unknown.`);
      onSavedRef.current(record);
    }).catch((error: unknown) => {
      if (!active || recovery.controller.signal.aborted) return;
      setState("error");
      setMessage(error instanceof Error ? error.message : "Existing candidate decision recovery failed.");
      queueMicrotask(() => status.current?.focus());
    });
    return () => {
      active = false;
      recovery.consumers -= 1;
      queueMicrotask(() => {
        if (recovery.pending && recovery.consumers === 0) recovery.controller.abort();
      });
    };
  }, [binding?.savePointId, candidate.turnId, client]);

  async function save(): Promise<void> {
    if (binding === undefined || state === "saving" || state === "saved") return;
    setState("saving"); setMessage("Saving the contemporaneous decision before durable promotion.");
    try {
      const record = await client.createCandidate(candidate.turnId, {
        expectedCandidateRevision: binding.candidateRevision,
        expectedCandidateManifestDigest: binding.candidateManifestDigest,
        decisionId: `decision-${candidate.turnId}`,
        content: {
          question: { value: question, provenance: "user-supplied", sourceComponentIds: [] },
          options: { value: [{ id: "option-a", label: firstOption }, { id: "option-b", label: secondOption }], provenance: "user-supplied", sourceComponentIds: [] },
          selectedOptionId: { ...(selection === "" ? {} : { value: selection }), provenance: selection === "" ? "unknown" : "user-supplied", sourceComponentIds: [] },
          owner: { value: owner, provenance: "user-supplied", sourceComponentIds: [] },
          uncertainty: { value: { level: uncertainty, source: "human" }, provenance: "user-supplied", sourceComponentIds: [] },
          evidenceComponentIds: evidence,
          expectedEffect: { value: expectedEffect, provenance: expectedEffectInferred ? "inferred" : "user-supplied", sourceComponentIds: evidence },
          verification: { value: verification, provenance: "user-supplied", sourceComponentIds: evidence },
          outcome: { provenance: "unknown", sourceComponentIds: [] },
        },
      });
      setState("saved"); setMessage(`Decision revision ${record.revision} saved before promotion. Outcome remains unknown.`); onSaved(record);
    } catch (error) {
      setState("error"); setMessage(error instanceof Error ? error.message : "Decision entry failed."); queueMicrotask(() => status.current?.focus());
    }
  }

  const valid = state !== "recovering" && binding !== undefined && question.trim() !== "" && firstOption.trim() !== "" && secondOption.trim() !== "" && selection !== "" && owner.trim() !== "" && uncertainty !== "" && expectedEffect.trim() !== "" && verification.trim() !== "" && evidence.length > 0;
  return <section className="decision-entry" aria-labelledby="decision-entry-title">
    <div className="decision-entry-heading"><p>Turn-boundary record</p><h2 id="decision-entry-title">Decision evidence before promotion</h2><span>Plain text only · outcome starts unknown</span></div>
    <div className="decision-entry-grid">
      <label>Decision question<textarea value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={512} disabled={state === "saved"} /></label>
      <fieldset><legend>Considered options and selection</legend><label><input type="radio" name="selected-decision-option" checked={selection === "option-a"} onChange={() => setSelection("option-a")} disabled={state === "saved"} /><input aria-label="First considered option" value={firstOption} onChange={(event) => setFirstOption(event.target.value)} maxLength={160} disabled={state === "saved"} /></label><label><input type="radio" name="selected-decision-option" checked={selection === "option-b"} onChange={() => setSelection("option-b")} disabled={state === "saved"} /><input aria-label="Second considered option" value={secondOption} onChange={(event) => setSecondOption(event.target.value)} maxLength={160} disabled={state === "saved"} /></label></fieldset>
      <label>Decision owner<input value={owner} onChange={(event) => setOwner(event.target.value)} maxLength={512} disabled={state === "saved"} /></label>
      <label>Expressed uncertainty<select value={uncertainty} onChange={(event) => setUncertainty(event.target.value as typeof uncertainty)} disabled={state === "saved"}><option value="">Choose a level</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><small>Source: human · user-supplied</small></label>
      <fieldset className="decision-evidence-picker"><legend>Evidence references</legend>{evidenceOptions.map((option) => <label key={option.id}><input type="checkbox" checked={evidence.includes(option.id)} disabled={state === "saved"} onChange={(event) => setEvidence((current) => event.target.checked ? [...current, option.id] : current.filter((id) => id !== option.id))} />{option.label}<code>{option.id}</code></label>)}</fieldset>
      <label>Expected effect<textarea value={expectedEffect} onChange={(event) => setExpectedEffect(event.target.value)} maxLength={512} disabled={state === "saved"} /></label>
      <label className="decision-inline-check"><input type="checkbox" checked={expectedEffectInferred} onChange={(event) => setExpectedEffectInferred(event.target.checked)} disabled={state === "saved"} />Proposed from observable evidence — keep inferred until confirmed</label>
      <label>Verification plan<textarea value={verification} onChange={(event) => setVerification(event.target.value)} maxLength={512} disabled={state === "saved"} /></label>
    </div>
    <div className="decision-entry-action"><p ref={status} tabIndex={state === "error" ? -1 : undefined} role={state === "error" ? "alert" : "status"}>{message || (state === "recovering" ? "Checking for an existing candidate decision revision." : "No decision revision has been recorded.")}</p><button type="button" className="button secondary-button" disabled={!valid || state === "saving" || state === "saved" || state === "recovering"} onClick={() => void save()}>{state === "recovering" ? "Checking decision…" : state === "saving" ? "Saving decision…" : state === "saved" ? "Decision recorded" : "Record decision before promotion"}</button></div>
  </section>;
}
