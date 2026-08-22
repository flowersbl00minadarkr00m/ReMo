import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LifecycleClientError, type LifecycleClient, type LifecycleExport, type LifecycleView } from "./lifecycle-client.js";
import "./LifecyclePanel.css";

interface PendingConfirmation { readonly kind: "unpin-expired" | "quarantine" | "delete"; readonly intentKey: string }

function dateTime(value: string | undefined): string {
  if (value === undefined) return "Not applicable";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
}

function downloadExport(exported: LifecycleExport): void {
  const raw = atob(exported.bytesBase64);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function LifecyclePanel({ initial, client, onBlocked, createIntentId = () => crypto.randomUUID() }: { readonly initial: LifecycleView; readonly client?: LifecycleClient; readonly onBlocked: (state: "quarantined" | "deleted" | "expired") => void; readonly createIntentId?: () => string }) {
  const [lifecycle, setLifecycle] = useState(initial);
  const [busy, setBusy] = useState<string>();
  const [confirmation, setConfirmation] = useState<PendingConfirmation>();
  const [announcement, setAnnouncement] = useState("");
  const [failedAction, setFailedAction] = useState<(() => Promise<void>)>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmationWasOpen = useRef(false);

  useEffect(() => {
    if (confirmation !== undefined) {
      confirmationWasOpen.current = true;
      dialogRef.current?.focus();
    } else if (confirmationWasOpen.current) {
      confirmationWasOpen.current = false;
      queueMicrotask(() => {
        const trigger = confirmationTriggerRef.current;
        if (trigger?.isConnected === true && !trigger.disabled) trigger.focus();
        else panelRef.current?.focus();
      });
    }
  }, [confirmation]);
  useEffect(() => { if (failedAction !== undefined) retryRef.current?.focus(); }, [failedAction]);

  const execute = async (label: string, action: () => Promise<LifecycleView | LifecycleExport | { readonly complete: true }>, activeIntentKey?: string): Promise<void> => {
    if (client === undefined) return;
    setBusy(label);
    setFailedAction(undefined);
    try {
      const result = await action();
      if ("state" in result) {
        if (result.subject === "durable") setLifecycle(result);
        if (result.state === "quarantined" || result.state === "expired") onBlocked(result.state);
      }
      if ("bytesBase64" in result) downloadExport(result);
      if ("complete" in result) { setLifecycle((current) => ({ ...current, state: "deleted" })); onBlocked("deleted"); }
      setConfirmation(undefined);
      setAnnouncement(label === "export" ? "Bounded ZIP export created with a SHA-256 inventory." : label === "delete" ? "Controlled local evidence deleted. External Git and Langfuse records were not deleted." : label === "redaction" ? "Redaction succeeded. A new candidate revision was created; the durable manifest was not edited." : `${label} succeeded for this save only.`);
    } catch (error) {
      if (error instanceof LifecycleClientError && (error.code === "lifecycle.expired" || error.code === "lifecycle.quarantined")) {
        const state = error.code === "lifecycle.expired" ? "expired" : "quarantined";
        setLifecycle((current) => ({ ...current, state }));
        onBlocked(state);
        setAnnouncement(state === "expired" ? "This save expired. Ordinary local evidence is no longer available." : "This save is quarantined. Ordinary local evidence viewing is blocked.");
      } else if (error instanceof LifecycleClientError && error.confirmationRequired && label === "unpin") {
        setConfirmation({ kind: "unpin-expired", intentKey: activeIntentKey ?? "invalid-missing-intent" });
        setAnnouncement("The original retention deadline has passed. Confirm immediate expiry to unpin.");
      } else if (error instanceof LifecycleClientError && !error.retryable) {
        setAnnouncement(`${label} failed and cannot be retried in the current state. Local evidence is unchanged.`);
      } else {
        setAnnouncement(`${label} failed. Local evidence is unchanged and the action can be retried.`);
        setFailedAction(() => () => execute(label, action, activeIntentKey));
      }
    } finally { setBusy(undefined); }
  };

  const unavailable = client === undefined;
  const intentKey = (action: string): string => {
    const id = createIntentId();
    if (!/^[A-Za-z0-9._-]{1,80}$/u.test(id)) throw new Error("Lifecycle intent identity is invalid.");
    return `lifecycle-${action}-${id}`;
  };
  const confirm = (): void => {
    if (confirmation?.kind === "unpin-expired") void execute("unpin", () => client!.unpin(lifecycle.savePointId, true, confirmation.intentKey), confirmation.intentKey);
    if (confirmation?.kind === "quarantine") void execute("quarantine", () => client!.quarantine(lifecycle.savePointId, confirmation.intentKey), confirmation.intentKey);
    if (confirmation?.kind === "delete") void execute("delete", () => client!.delete(lifecycle.savePointId, confirmation.intentKey), confirmation.intentKey);
  };
  const trapDialogFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (buttons.length === 0) { event.preventDefault(); event.currentTarget.focus(); return; }
    const first = buttons[0]!;
    const last = buttons.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      first.focus();
    }
  };
  return <section className="detail-card lifecycle-panel" aria-labelledby="lifecycle-title" tabIndex={-1} ref={panelRef}>
    <h2 id="lifecycle-title">Retention and lifecycle</h2>
    <dl className="metadata-list">
      <div><dt>State</dt><dd>{lifecycle.state === "active" ? "Retained locally" : lifecycle.state}</dd></div>
      <div><dt>Pin state</dt><dd>{lifecycle.pinned ? "Pinned — automatic expiry suspended" : "Unpinned"}</dd></div>
      <div><dt>Created</dt><dd><time dateTime={lifecycle.createdAt}>{dateTime(lifecycle.createdAt)}</time></dd></div>
      <div><dt>Promoted</dt><dd>{lifecycle.promotedAt === undefined ? "Not durable" : <time dateTime={lifecycle.promotedAt}>{dateTime(lifecycle.promotedAt)}</time>}</dd></div>
      <div><dt>Original deadline</dt><dd><time dateTime={lifecycle.originalExpiresAt}>{dateTime(lifecycle.originalExpiresAt)}</time></dd></div>
    </dl>
    <div className="lifecycle-actions" aria-label="Safe lifecycle actions">
      <button type="button" disabled={unavailable || busy !== undefined || lifecycle.state !== "active"} onClick={(event) => { confirmationTriggerRef.current = event.currentTarget; const key = intentKey(lifecycle.pinned ? "unpin" : "pin"); void execute(lifecycle.pinned ? "unpin" : "pin", () => lifecycle.pinned ? client!.unpin(lifecycle.savePointId, false, key) : client!.pin(lifecycle.savePointId, key), key); }}>{busy === "pin" || busy === "unpin" ? "Updating retention" : lifecycle.pinned ? "Unpin" : "Pin"}</button>
      <button type="button" disabled={unavailable || busy !== undefined || lifecycle.state !== "active"} onClick={() => { const key = intentKey("export"); void execute("export", () => client!.export(lifecycle.savePointId, key), key); }}>Export ZIP</button>
      {lifecycle.state === "quarantined" ? <button type="button" disabled={unavailable || busy !== undefined} onClick={() => { const key = intentKey("redact"); void execute("redaction", () => client!.redact(lifecycle.savePointId, ["screenshot"], key), key); }}>Redact and regenerate candidate</button> : <button type="button" className="warning-action" disabled={unavailable || busy !== undefined || lifecycle.state !== "active"} onClick={(event) => { confirmationTriggerRef.current = event.currentTarget; setConfirmation({ kind: "quarantine", intentKey: intentKey("quarantine") }); }}>Quarantine</button>}
      <button type="button" className="danger-action" disabled={unavailable || busy !== undefined || lifecycle.state === "deleted"} onClick={(event) => { confirmationTriggerRef.current = event.currentTarget; setConfirmation({ kind: "delete", intentKey: intentKey("delete") }); }}>Delete local evidence</button>
    </div>
    {unavailable ? <p className="lifecycle-help">Authenticated lifecycle controls are unavailable. No action has been taken.</p> : null}
    {announcement === "" ? null : <p className="detail-live" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>}
    {failedAction === undefined ? null : <button ref={retryRef} type="button" className="retry-action" onClick={() => void failedAction()}>Retry failed action</button>}
    {confirmation === undefined ? null : <div className="lifecycle-dialog-backdrop"><div className="lifecycle-dialog" role="alertdialog" aria-modal="true" aria-labelledby="lifecycle-confirm-title" aria-describedby="lifecycle-confirm-copy" tabIndex={-1} ref={dialogRef} onKeyDown={trapDialogFocus}>
      <h3 id="lifecycle-confirm-title">{confirmation.kind === "delete" ? "Delete controlled local evidence?" : confirmation.kind === "quarantine" ? "Quarantine this save?" : "Unpin and expire immediately?"}</h3>
      <p id="lifecycle-confirm-copy">{confirmation.kind === "delete" ? "This removes only ReMo-controlled local rows, unshared blobs, manifests, and renders. Git and Langfuse remain external." : confirmation.kind === "quarantine" ? "Ordinary evidence viewing and promotion will be blocked. A redacted candidate can be regenerated without editing this durable manifest." : "The original deadline has passed. Confirming removes the expired local evidence now; pinning did not reset the deadline."}</p>
      <div><button type="button" onClick={() => setConfirmation(undefined)}>Cancel</button><button type="button" className="danger-action" onClick={confirm}>{confirmation.kind === "delete" ? "Delete local evidence" : confirmation.kind === "quarantine" ? "Quarantine save" : "Unpin and expire"}</button></div>
    </div></div>}
  </section>;
}
