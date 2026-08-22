import { useEffect, useState } from "react";

const DEFAULT_TURN = { repository: "C:/path/to/ReMo", route: "http://127.0.0.1:4173/fixture/save-point", turnId: "01J000000000000000000000T3" } as const;
export type StopSettlement = { readonly status: "candidate" | "no-candidate" };
interface ActiveTurnProps { readonly repository?: string; readonly route?: string; readonly turnId?: string; readonly startedAt?: string; readonly now?: () => number; readonly onStop: () => Promise<StopSettlement> }
function elapsedText(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")} elapsed`;
}
function ScopeValue({ label, value }: { readonly label: string; readonly value: string }) { return <div className="turn-scope-value"><dt>{label}</dt><dd><code>{value}</code></dd></div>; }

export function ActiveTurn({ repository = DEFAULT_TURN.repository, route = DEFAULT_TURN.route, turnId = DEFAULT_TURN.turnId, startedAt, now = Date.now, onStop }: ActiveTurnProps) {
  const [status, setStatus] = useState<"recording" | "stopping" | "stopped" | "failed">("recording");
  const [effectiveStartedAt] = useState(() => startedAt ?? new Date(now()).toISOString());
  const [clock, setClock] = useState(() => now());
  useEffect(() => {
    if (status !== "recording") return undefined;
    const interval = window.setInterval(() => setClock(now()), 1000);
    return () => window.clearInterval(interval);
  }, [now, status]);
  async function stop(): Promise<void> {
    if (status === "stopping" || status === "stopped") return;
    setStatus("stopping");
    try { await onStop(); setStatus("stopped"); }
    catch { setStatus("failed"); }
  }
  const statusCopy = {
    recording: ["Recording", elapsedText(effectiveStartedAt, clock)],
    stopping: ["Stopping", "Waiting for capture and source settlement"],
    stopped: ["Stopped", "Capture stopped and settled"],
    failed: ["Stop failed", "Capture state could not be confirmed"],
  } as const;
  const [statusLabel, statusDetail] = statusCopy[status];
  return (
    <div className="turn-layout">
      <header className="turn-heading">
        <div><p className="turn-kicker">Controlled fixture capture</p><h1>Bounded turn in progress</h1><p>Only the binding fixture route and source allowlist are in scope.</p></div>
        <button className="button stop-button" type="button" onClick={() => void stop()} disabled={status === "stopping" || status === "stopped"} aria-label={status === "failed" ? "Retry stopping capture" : "Stop capture immediately"}><span aria-hidden="true">■</span> {status === "failed" ? "Retry stop" : status === "stopping" ? "Stopping…" : "Stop"}</button>
      </header>
      <div className="turn-columns">
        <section className="turn-card active-turn-card" aria-labelledby="active-turn-title">
          <div className={`recording-banner ${status}`} role="status" aria-live="polite"><span className="capture-dot" aria-hidden="true" /><strong>{statusLabel}</strong><span>{statusDetail}</span></div>
          {status === "failed" ? <p className="stop-error" role="alert">Stop could not be confirmed. Check the local control service, then retry.</p> : null}
          <div className="section-heading"><h2 id="active-turn-title">Active turn</h2><p>Stable identity and exact scope remain visible for the whole window.</p></div>
          <dl className="turn-scope-grid"><ScopeValue label="Repository" value={repository} /><ScopeValue label="Exact route" value={route} /><ScopeValue label="Turn identity" value={turnId} /><ScopeValue label="Capture root" value="[data-remo-fixture-root]" /></dl>
        </section>
        <aside className="turn-card turn-boundary-card" aria-labelledby="capture-boundary-title">
          <h2 id="capture-boundary-title">Capture boundary</h2>
          <ul><li><strong>Included</strong><span>Fixture DOM structure and allowlisted browser state</span></li><li><strong>Included</strong><span>Read-only Git evidence under the fixture source</span></li><li><strong>Excluded</strong><span>Raw keystrokes, clipboard, private messages, and other apps</span></li><li><strong>Fail closed</strong><span>Navigation, popup, frame, path drift, or uncertainty stops capture</span></li></ul>
        </aside>
      </div>
      <footer className="turn-footer"><p>No candidate or durable save point exists until this turn settles and later checks pass.</p></footer>
    </div>
  );
}
