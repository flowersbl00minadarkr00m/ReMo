import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { BRANCH_PREFLIGHT_CHECK_IDS, branchPreflightCheckName, validateBranchPreflightConfirmation, type BranchPreflightReceipt } from "@remo/domain/browser";
import type { BranchPreflightClient } from "./branch-preflight-client.js";
import type { BranchOrchestrationClient, BranchResult } from "./branch-orchestration-client.js";
import "./BranchPreflightPanel.css";

type Status = "closed" | "loading" | "ready" | "blocked" | "cancelled" | "error" | "confirming" | "confirmed" | "stale" | "expired";

type OperationMode = "real-local" | "simulated-demo";

function BranchResultView({ result, operationMode, focusRef }: { readonly result: BranchResult; readonly operationMode: OperationMode; readonly focusRef: Ref<HTMLDivElement> }) {
  if (operationMode === "simulated-demo") return <div ref={focusRef} tabIndex={-1} className={`branch-recovery branch-result ${result.state}`} role={result.state === "succeeded" ? "status" : "alert"} aria-label={result.state === "succeeded" ? "Simulated alternate lineage ready" : "Simulated alternate lineage unavailable"} aria-live="assertive"><strong>{result.state === "succeeded" ? "Simulated alternate lineage ready" : "Simulated alternate lineage unavailable"}</strong><p><strong>Simulated.</strong> No real repository is connected or changed. This fixed browser-session projection performed no Git, filesystem, service, or storage mutation.</p><dl><div><dt>State</dt><dd>{result.state}</dd></div><div><dt>Simulated operation</dt><dd><code>{result.operationId}</code></dd></div><div><dt>Simulated lineage</dt><dd><code>{result.lineageId ?? "unavailable"}</code></dd></div></dl>{result.reasonCodes.length === 0 ? null : <p>Reasons: {result.reasonCodes.join(", ")}</p>}</div>;
  return <div ref={focusRef} tabIndex={-1} className={`branch-recovery branch-result ${result.state}`} role={result.state === "succeeded" ? "status" : "alert"} aria-live="assertive"><strong>{result.state === "succeeded" ? "Alternate lineage verified" : result.state === "failed-no-effect" ? "Branch failed with no effect" : result.state === "recovery-required" ? "Recovery required" : "Alternate lineage unavailable"}</strong><p>{result.state === "succeeded" ? "Git and the original future were verified before this lineage became navigable." : "The alternate lineage is not usable. ReMo performed no automatic Git cleanup."}</p><dl><div><dt>State</dt><dd>{result.state}</dd></div><div><dt>Branch</dt><dd><code>{result.branchRef}</code></dd></div><div><dt>Worktree</dt><dd><code>{result.worktreeRelativePath}</code></dd></div></dl>{result.reasonCodes.length === 0 ? null : <p>Reasons: {result.reasonCodes.join(", ")}</p>}</div>;
}

export function BranchPreflightPanel({ savePointId, savePointRevision, client, orchestrationClient, onBranchResult, operationMode = "real-local" }: {
  readonly savePointId: string;
  readonly savePointRevision: number;
  readonly client: BranchPreflightClient;
  readonly orchestrationClient?: BranchOrchestrationClient;
  readonly onBranchResult?: (result: BranchResult) => void;
  readonly operationMode?: OperationMode;
}) {
  const [status, setStatus] = useState<Status>("closed");
  const [receipt, setReceipt] = useState<BranchPreflightReceipt>();
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<BranchResult>();
  const controller = useRef<AbortController | undefined>(undefined);
  const invoke = useRef<HTMLButtonElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const resultFocus = useRef<HTMLDivElement>(null);
  const firstBlocker = useRef<HTMLLIElement>(null);
  const identity = `${savePointId}:${savePointRevision}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  const restoreInvoker = useCallback(() => queueMicrotask(() => invoke.current?.focus()), []);
  const run = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    const requestIdentity = identity;
    setReceipt(undefined); setResult(undefined); setMessage(""); setStatus("loading");
    void client.preflight(savePointId, savePointRevision, next.signal).then((value) => {
      if (next.signal.aborted || currentIdentity.current !== requestIdentity) return;
      setReceipt(value); setStatus(value.ready ? "ready" : "blocked");
    }, (error: unknown) => {
      if (next.signal.aborted || currentIdentity.current !== requestIdentity) return;
      setMessage(error instanceof Error ? error.message : "Branch preflight failed closed."); setStatus("error");
    });
  }, [client, identity, savePointId, savePointRevision]);

  useLayoutEffect(() => {
    controller.current?.abort();
    controller.current = undefined;
    setReceipt(undefined);
    setResult(undefined);
    setMessage("");
    setStatus("closed");
  }, [identity]);

  useEffect(() => {
    if (orchestrationClient === undefined) return;
    const next = new AbortController();
    controller.current = next;
    const requestIdentity = identity;
    void orchestrationClient.list(savePointId, next.signal).then((operations) => {
      if (next.signal.aborted || currentIdentity.current !== requestIdentity) return;
      const latest = operations.filter((operation) => operation.savePointId === savePointId && operation.savePointRevision === savePointRevision).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, "en-US"))[0];
      if (latest === undefined) return;
      setResult(latest);
      setStatus("confirmed");
    }, (error: unknown) => {
      if (next.signal.aborted || currentIdentity.current !== requestIdentity) return;
      setMessage(error instanceof Error ? error.message : operationMode === "simulated-demo" ? "Simulated branch state is unavailable." : "Durable branch state is unavailable.");
      setStatus("error");
    });
    return () => next.abort();
  }, [identity, operationMode, orchestrationClient, savePointId, savePointRevision]);

  useEffect(() => {
    if (status === "ready") resultHeading.current?.focus();
    if (status === "blocked") firstBlocker.current?.focus();
    if (status === "confirmed" && result !== undefined) resultFocus.current?.focus();
  }, [result, status]);

  useEffect(() => {
    if (receipt === undefined || !receipt.ready || status === "confirmed" || operationMode === "simulated-demo") return;
    const remaining = Date.parse(receipt.expiresAt) - Date.now();
    if (remaining <= 0) { setStatus("expired"); return; }
    const timer = window.setTimeout(() => setStatus("expired"), remaining);
    return () => window.clearTimeout(timer);
  }, [operationMode, receipt, status]);

  useEffect(() => () => controller.current?.abort(), []);

  const cancel = () => { controller.current?.abort(); setStatus("cancelled"); setMessage("Preflight cancelled before any branch operation or journal. Historical viewing is unchanged."); restoreInvoker(); };
  const close = () => { controller.current?.abort(); setStatus("closed"); setReceipt(undefined); setResult(undefined); restoreInvoker(); };
  const confirmBoundary = () => {
    if (receipt === undefined) return;
    const next = new AbortController(); controller.current = next; setStatus("confirming");
    const requestIdentity = identity;
    if (orchestrationClient !== undefined) {
      const idempotencyKey = `branch-${receipt.target.operationId}`;
      void orchestrationClient.confirm(receipt, `Alternate from ${savePointId}`, idempotencyKey, next.signal).then((branchResult) => {
        if (next.signal.aborted || currentIdentity.current !== requestIdentity) return;
        if (branchResult.savePointId !== savePointId || branchResult.savePointRevision !== savePointRevision || branchResult.preflightDigest !== receipt.digest || branchResult.operationId !== receipt.target.operationId) {
          setMessage("Branch result identity did not match the confirmed receipt. The alternate lineage remains unavailable.");
          setStatus("error");
          return;
        }
        setResult(branchResult);
        setStatus("confirmed");
        onBranchResult?.(branchResult);
      }, (error: unknown) => {
        if (!next.signal.aborted && currentIdentity.current === requestIdentity) {
          setMessage(error instanceof Error ? error.message : "Branch confirmation was interrupted. Restart reconciliation is required.");
          setStatus("error");
        }
      });
      return;
    }
    void client.preflight(savePointId, savePointRevision, next.signal).then((fresh) => {
      if (next.signal.aborted || currentIdentity.current !== requestIdentity) return;
      if (!fresh.ready) { setReceipt(fresh); setStatus("blocked"); return; }
      const validation = validateBranchPreflightConfirmation(receipt, { now: new Date(), savePointRevision: fresh.savePointRevision, originalFutureDigest: fresh.originalFutureDigest, policyRevision: fresh.policyRevision, inputDigest: fresh.inputDigest });
      if (!validation.valid) { setMessage(`Fresh confirmation is required: ${validation.reasonCode}.`); setStatus(validation.reasonCode === "preflight.expired" ? "expired" : "stale"); return; }
      setMessage("Confirmation boundary ready. No branch client is mounted in this read-only test surface."); setStatus("confirmed");
    }, (error: unknown) => { if (!next.signal.aborted && currentIdentity.current === requestIdentity) { setMessage(error instanceof Error ? error.message : "Fresh confirmation validation failed."); setStatus("stale"); } });
  };

  const firstBlockedId = receipt?.checks.find(({ state }) => state === "block")?.id;
  const simulated = operationMode === "simulated-demo";

  return <section className={`branch-preflight${simulated ? " simulated-demo" : ""}`} aria-labelledby="branch-preflight-title">
    <div className="branch-preflight-invocation"><div><p>{simulated ? "Explicitly simulated action" : "Deliberate source action"}</p><h2 id="branch-preflight-title">{simulated ? "Simulated branch from here" : "Branch from here"}</h2><span>{simulated ? "Simulated. No real repository is connected or changed." : "Separate from read-only replay. Preflight never changes Git or lineage."}</span></div><button ref={invoke} type="button" onClick={run} aria-expanded={status !== "closed"}>{simulated ? "Run simulated preflight" : "Branch from here"}</button></div>
    {status === "closed" ? null : <div className="branch-preflight-panel" role="region" aria-label="Branch preflight results">
      <div className="branch-preflight-panel-heading"><div><p>30-second read-only receipt</p><h3 ref={resultHeading} tabIndex={-1}>{status === "loading" ? "Inspecting ten ordered checks" : status === "ready" || status === "confirming" || status === "confirmed" ? "Preflight passed" : status === "blocked" ? "Preflight blocked" : status === "expired" ? "Preflight expired" : status === "stale" ? "Preflight became stale" : status === "cancelled" ? "Preflight cancelled" : "Preflight unavailable"}</h3></div><button type="button" className="branch-close" onClick={close} disabled={status === "confirming" && orchestrationClient !== undefined}>Close branch preflight</button></div>
      {status === "loading" ? <><p role="status" aria-live="polite">Read-only inspection is in progress. You can cancel before any journal or mutation.</p><ol className="branch-checks pending">{BRANCH_PREFLIGHT_CHECK_IDS.map((id) => <li key={id}><span>Pending</span><strong>{branchPreflightCheckName(id)}</strong></li>)}</ol><button type="button" onClick={cancel}>Cancel preflight</button></> : null}
      {receipt === undefined ? status === "loading" ? null : result !== undefined ? <BranchResultView result={result} operationMode={operationMode} focusRef={resultFocus} /> : <div className="branch-recovery" role={status === "error" ? "alert" : "status"}><p>{message}</p><button type="button" onClick={run}>Run fresh preflight</button></div> : <>
        <ol className="branch-checks">{receipt.checks.map((check) => <li key={check.id} ref={check.id === firstBlockedId ? firstBlocker : undefined} tabIndex={check.id === firstBlockedId ? -1 : undefined} className={`branch-check-${check.state}`}><span>{check.state === "pass" ? "Pass" : "Block"}</span><div><strong>{check.name}</strong><p>{check.explanation}</p>{check.reasonCode === undefined ? null : <code>{check.reasonCode}</code>}{check.recovery === undefined ? null : <p>{check.recovery}</p>}<small>Evidence {check.evidenceDigest}</small></div></li>)}</ol>
        <dl className="branch-identities"><div><dt>{simulated ? "Simulated operation" : "Operation"}</dt><dd><code>{receipt.target.operationId}</code></dd></div><div><dt>{simulated ? "Simulated branch label" : "Derived branch ref"}</dt><dd><code>{receipt.target.branchRef}</code></dd></div><div><dt>{simulated ? "Simulated workspace label" : "Derived worktree"}</dt><dd><code>{receipt.target.worktreeRelativePath}</code></dd></div><div><dt>Integrity-bound receipt digest</dt><dd><code>{receipt.digest}</code></dd></div>{simulated ? null : <div><dt>Expires</dt><dd>{receipt.expiresAt}</dd></div>}</dl>
        <aside className="branch-integrity-note" aria-label="Receipt integrity boundary"><strong>Receipt integrity boundary</strong><p>{simulated ? "This fixed digest validates the synthetic demonstration receipt. It grants no authenticity or mutation authority." : "This digest binds receipt integrity; it is not an authenticity token. The mutation stage must re-run preflight inside its lock before any journal or Git effect."}</p></aside>
        {status === "ready" ? <div className="branch-confirmation"><strong>{simulated ? "Final simulated confirmation" : "Final branch confirmation"}</strong><p>{simulated ? "Simulated. No real repository is connected or changed. Confirmation creates one fixed in-memory lineage projection and URL state only; it performs no Git, filesystem, service, or storage operation." : "The service will re-run this preflight under its mutation lock, durably journal one intent, and create only the derived locked worktree. This action is not cancellable after journaling."}</p><button type="button" onClick={confirmBoundary}>{simulated ? "Confirm simulated branch" : orchestrationClient === undefined ? "Continue to confirmation boundary" : "Confirm and create alternate lineage"}</button></div> : null}
        {status === "confirming" ? <div className="branch-recovery" role="status" aria-live="assertive"><p>{simulated ? "Creating the one fixed simulated result in browser memory. No real repository is connected or changed." : orchestrationClient === undefined ? "Revalidating the receipt without mutation…" : "Confirming one durable branch intent. Do not close ReMo until a terminal or recovery state appears."}</p>{orchestrationClient === undefined ? <button type="button" onClick={cancel}>Cancel preflight</button> : null}</div> : null}
        {status === "confirmed" && result === undefined ? <div className="branch-recovery success" role="status" aria-label="Confirmation boundary ready"><p>{message}</p></div> : null}
        {status === "confirmed" && result !== undefined ? <BranchResultView result={result} operationMode={operationMode} focusRef={resultFocus} /> : null}
        {status === "expired" || status === "stale" || status === "blocked" ? <div className="branch-recovery" role="alert"><p>{status === "blocked" ? "Resolve the named blocker. Historical replay remains available." : message || "The receipt is no longer fresh. The checks remain visible for review."}</p><button type="button" onClick={run}>Run fresh preflight</button></div> : null}
      </>}
    </div>}
  </section>;
}
