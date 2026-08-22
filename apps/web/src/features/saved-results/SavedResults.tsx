import { useEffect, useMemo, useState } from "react";
import { createLoopbackSavedResultsClient, type SavedResultSummary, type SavedResultsClient } from "./saved-results-client.js";
import "./SavedResults.css";

type SortKey = "save" | "turn" | "saved" | "integrity" | "retention";
type LoadState = { readonly status: "loading" } | { readonly status: "error" } | { readonly status: "ready"; readonly results: readonly SavedResultSummary[] };

const DATE_FORMAT = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Vancouver" });

function retention(result: SavedResultSummary): string {
  return result.pinned ? "Pinned locally" : `Expires ${DATE_FORMAT.format(new Date(result.expiresAt))}`;
}

function compare(key: SortKey, left: SavedResultSummary, right: SavedResultSummary): number {
  const values: Record<SortKey, readonly [string | number, string | number]> = {
    save: [left.displayId, right.displayId],
    turn: [left.turnNumber, right.turnNumber],
    saved: [left.savedAt, right.savedAt],
    integrity: [left.integrity, right.integrity],
    retention: [retention(left), retention(right)],
  };
  const [a, b] = values[key];
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "en-US", { numeric: true });
}

function Status({ label, value }: { readonly label: string; readonly value: string }) {
  return <span className="result-status"><span>{label}:</span><strong>{value}</strong></span>;
}

export function SavedResults({ client: providedClient }: { readonly client?: SavedResultsClient }) {
  const client = useMemo(() => providedClient ?? createLoopbackSavedResultsClient(window.location.origin), [providedClient]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [sortKey, setSortKey] = useState<SortKey>("save");
  const [descending, setDescending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    client.list(controller.signal).then(
      (results) => { if (!controller.signal.aborted) setState({ status: "ready", results }); },
      () => { if (!controller.signal.aborted) setState({ status: "error" }); },
    );
    return () => controller.abort();
  }, [client]);

  const results = state.status === "ready" ? state.results : [];
  const sorted = useMemo(() => [...results].sort((left, right) => {
    const primary = compare(sortKey, left, right);
    const neutral = primary === 0 ? left.savePointId.localeCompare(right.savePointId, "en-US") : primary;
    return descending ? -neutral : neutral;
  }), [descending, results, sortKey]);

  return <section className="saved-results" aria-labelledby="saved-results-title">
    <header className="results-heading">
      <div><p className="results-context">Durable local evidence</p><h1 id="saved-results-title">Saved results</h1><p>Open any individual save point to inspect its evidence and current local state.</p></div>
      {state.status === "ready" ? <p className="result-count"><strong>{state.results.length}</strong><span>{state.results.length === 1 ? "saved result" : "saved results"}</span></p> : null}
    </header>

    {state.status === "loading" ? <div className="results-message" role="status"><strong>Loading saved results</strong><p>Reading the local collection. No result is being synthesized.</p></div> : null}
    {state.status === "error" ? <div className="results-message error" role="alert"><strong>Saved results unavailable</strong><p>The local collection could not be read. Check that the ReMo service is running, then reload this page.</p><button type="button" onClick={() => window.location.reload()}>Reload saved results</button></div> : null}
    {state.status === "ready" && state.results.length === 0 ? <div className="results-message"><strong>No saved results yet</strong><p>Complete a qualifying turn and explicitly confirm its candidate to create the first durable result.</p><a href="/boundary/setup">Configure capture boundary</a></div> : null}

    {state.status === "ready" && state.results.length > 0 ? <>
      <div className="results-toolbar" aria-label="Collection sorting">
        <label>Sort by<select value={sortKey} onChange={(event) => setSortKey(event.currentTarget.value as SortKey)}><option value="save">Save ID</option><option value="turn">Turn number</option><option value="saved">Saved time</option><option value="integrity">Integrity</option><option value="retention">Retention</option></select></label>
        <button type="button" aria-label={`Sort ${descending ? "ascending" : "descending"}`} onClick={() => setDescending((value) => !value)}>{descending ? "Descending" : "Ascending"}<span aria-hidden="true">{descending ? "↓" : "↑"}</span></button>
      </div>
      <div className="results-table-wrap">
        <table><caption className="visually-hidden">Individually addressable durable save points</caption><thead><tr><th scope="col">Save</th><th scope="col">Turn</th><th scope="col">Saved</th><th scope="col">Trust state</th><th scope="col">Retention</th><th scope="col"><span className="visually-hidden">Action</span></th></tr></thead>
          <tbody>{sorted.map((result) => <tr key={result.savePointId}>
            <th scope="row"><strong>{result.displayId}</strong><code>{result.savePointId}</code></th>
            <td><strong>Turn {result.turnNumber}</strong><code>{result.turnId}</code></td>
            <td><time dateTime={result.savedAt}>{DATE_FORMAT.format(new Date(result.savedAt))}</time></td>
            <td><Status label="Integrity" value={result.integrity} /><Status label="Fidelity" value={result.fidelity} /></td>
            <td><strong>{result.pinned ? "Pinned" : "Unpinned"}</strong><span>{retention(result)}</span></td>
            <td><a className="open-result" href={result.stablePath}>Open <span className="visually-hidden">{result.displayId}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg></a></td>
          </tr>)}</tbody>
        </table>
      </div>
    </> : null}
  </section>;
}
