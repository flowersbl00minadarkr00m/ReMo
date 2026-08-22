import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { historyMediaBinding, isValidProductSavePointId, projectHistoryFilmstrip, type HistoryFilmstripItem } from "@remo/domain/browser";
import { ReadOnlyTransport } from "../transport/ReadOnlyTransport.js";
import { EvidenceMediaPanel } from "../evidence-media/EvidenceMediaPanel.js";
import { createEvidenceMediaClient, type EvidenceMediaClient } from "../evidence-media/evidence-media-client.js";
import { BranchPreflightPanel } from "../branch-preflight/BranchPreflightPanel.js";
import { createLoopbackBranchPreflightClient, type BranchPreflightClient } from "../branch-preflight/branch-preflight-client.js";
import { createLoopbackBranchOrchestrationClient, type BranchOrchestrationClient, type BranchResult } from "../branch-preflight/branch-orchestration-client.js";
import { HistoryFilmstrip } from "./HistoryFilmstrip.js";
import { createLoopbackHistoryClient, type HistoryClient } from "./history-client.js";
import "./ReplayWorkspace.css";

export interface HistoryDetailSummary {
  readonly savePointId: string;
  readonly turnId: string;
  readonly nominationReason: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly components: readonly { readonly type: string; readonly availability: string }[];
  readonly integrity: { readonly state: string };
  readonly fidelity: { readonly state: string };
}

type LoadState = { readonly status: "loading" } | { readonly status: "error" } | { readonly status: "ready"; readonly items: readonly HistoryFilmstripItem[]; readonly lineages: NonNullable<Awaited<ReturnType<HistoryClient["list"]>>["lineages"]> };
type DetailState = { readonly status: "idle" | "loading" | "error"; readonly key?: string } | { readonly status: "ready"; readonly key: string; readonly value: HistoryDetailSummary };

const detailKey = ({ savePointId, turnId }: Pick<HistoryDetailSummary, "savePointId" | "turnId">): string => `${savePointId}\u0000${turnId}`;
const integrityLabel = (value: HistoryFilmstripItem["integrity"]): string => value === "complete" ? "Complete" : value === "incomplete" ? "Incomplete" : value === "quarantined" ? "Quarantined" : "Deleted";
const fidelityLabel = (value: HistoryFilmstripItem["fidelity"]): string => value === "editable-eligible" ? "Editable eligible" : value === "degraded" ? "Degraded" : "Unavailable";
const requestedLineage = (): string => new URLSearchParams(window.location.search).get("lineage") ?? "lineage:original";
const replaySelectionUrl = (savePointId: string, lineageId = "lineage:original"): string => `/replay/${encodeURIComponent(savePointId)}${lineageId === "lineage:original" ? "" : `?lineage=${encodeURIComponent(lineageId)}`}`;

function isDetail(value: unknown, savePointId: string): value is HistoryDetailSummary {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  const integrity = detail.integrity as Record<string, unknown> | undefined;
  const fidelity = detail.fidelity as Record<string, unknown> | undefined;
  return detail.savePointId === savePointId && typeof detail.turnId === "string" && typeof detail.nominationReason === "string" && Number.isSafeInteger(detail.revision) && Number(detail.revision) > 0 && /^sha256:[0-9a-f]{64}$/u.test(String(detail.manifestDigest)) && Array.isArray(detail.components) && typeof integrity?.state === "string" && typeof fidelity?.state === "string";
}

async function loadDetail(savePointId: string, signal: AbortSignal): Promise<HistoryDetailSummary> {
  const response = await fetch(`/api/save-points/${encodeURIComponent(savePointId)}`, { method: "GET", credentials: "same-origin", signal });
  if (!response.ok) throw new Error("Selected history detail is unavailable.");
  const value = await response.json() as unknown;
  if (!isDetail(value, savePointId)) throw new Error("Selected history detail identity is invalid.");
  return value;
}

export function ReplayWorkspace({ client: providedClient, detail = loadDetail, initialDetail, initialSavePointId, mediaClient: providedMediaClient, branchPreflightClient: providedBranchPreflightClient, branchOrchestrationClient: providedBranchOrchestrationClient, onSelectionSample }: {
  readonly client?: HistoryClient;
  readonly detail?: (savePointId: string, signal: AbortSignal) => Promise<HistoryDetailSummary>;
  readonly initialSavePointId?: string;
  readonly initialDetail?: HistoryDetailSummary;
  readonly mediaClient?: EvidenceMediaClient;
  readonly branchPreflightClient?: BranchPreflightClient;
  readonly branchOrchestrationClient?: BranchOrchestrationClient;
  readonly onSelectionSample?: (milliseconds: number) => void;
}) {
  const client = useMemo(() => providedClient ?? createLoopbackHistoryClient(window.location.origin), [providedClient]);
  const sessionToken = window.__REMO_SAVE_POINT_SESSION__?.sessionToken;
  const mediaClient = useMemo(() => providedMediaClient ?? (sessionToken === undefined ? undefined : createEvidenceMediaClient({ origin: window.location.origin, sessionToken })), [providedMediaClient, sessionToken]);
  const branchPreflightClient = useMemo(() => providedBranchPreflightClient ?? (sessionToken === undefined ? undefined : createLoopbackBranchPreflightClient({ origin: window.location.origin, sessionToken })), [providedBranchPreflightClient, sessionToken]);
  const branchOrchestrationClient = useMemo(() => providedBranchOrchestrationClient ?? (sessionToken === undefined ? undefined : createLoopbackBranchOrchestrationClient({ origin: window.location.origin, sessionToken })), [providedBranchOrchestrationClient, sessionToken]);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [historyRevision, setHistoryRevision] = useState(0);
  const [selectedLineageId, setSelectedLineageId] = useState(requestedLineage);
  const [selectedId, setSelectedId] = useState(initialSavePointId);
  const [detailState, setDetailState] = useState<DetailState>({ status: "idle" });
  const selectionStarted = useRef<number | undefined>(undefined);
  const originalSelectionId = useRef(initialSavePointId);

  useEffect(() => {
    let current = true;
    client.list().then((page) => {
      if (!current) return;
      const items = projectHistoryFilmstrip(page);
      const lineages = page.lineages ?? [];
      const requestedLineageId = requestedLineage();
      const requestedAlternate = lineages.find(({ lineageId, state }) => lineageId === requestedLineageId && state === "active-alternate");
      const nextLineageId = requestedAlternate?.lineageId ?? "lineage:original";
      setLoad({ status: "ready", items, lineages });
      setSelectedLineageId(nextLineageId);
      setSelectedId((current) => {
        const requested = requestedAlternate?.rootSavePointId ?? current ?? initialSavePointId;
        const selected = requested === undefined ? [...items].reverse().find(({ state }) => state !== "tombstone") : items.find(({ savePointId }) => savePointId === requested);
        const next = selected?.savePointId;
        const nextUrl = next === undefined ? undefined : replaySelectionUrl(next, nextLineageId);
        if (nextUrl !== undefined && `${window.location.pathname}${window.location.search}` !== nextUrl) window.history.replaceState({}, "", nextUrl);
        if (next !== undefined && nextLineageId === "lineage:original") originalSelectionId.current = next;
        return next ?? requested;
      });
    }, () => { if (current) setLoad({ status: "error" }); });
    return () => { current = false; };
  }, [client, initialSavePointId, historyRevision]);

  useEffect(() => {
    const pop = () => {
      const match = /^\/replay\/([A-Za-z0-9_-]{1,128})$/u.exec(window.location.pathname);
      setSelectedId(match?.[1]);
      setSelectedLineageId(requestedLineage());
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const items = load.status === "ready" ? load.items : [];
  const selectedIndex = items.findIndex(({ savePointId }) => savePointId === selectedId);
  const selected = selectedIndex < 0 ? undefined : items[selectedIndex];
  const selectedKey = selected === undefined ? undefined : `${selected.savePointId}\u0000${selected.turnId}`;
  const lineages = load.status === "ready" ? load.lineages : [];
  const alternateLineage = lineages.find(({ state }) => state === "active-alternate");
  const alternateRoot = alternateLineage?.rootSavePointId === undefined ? undefined : items.find(({ savePointId, state }) => savePointId === alternateLineage.rootSavePointId && state === "active");
  const selectedLineage = selectedLineageId === "lineage:original"
    ? items.filter(({ lineageId }) => lineageId === "lineage:original").sort((left, right) => left.sequenceNo - right.sequenceNo || left.savePointId.localeCompare(right.savePointId, "en-US"))
    : alternateRoot === undefined ? [] : [alternateRoot];
  const lineageIndex = selectedLineage.findIndex(({ savePointId }) => savePointId === selectedId);
  const onBranchResult = useCallback((result: BranchResult) => {
    if (result.state === "succeeded") {
      setHistoryRevision((revision) => revision + 1);
    }
  }, []);

  useEffect(() => {
    if (selected === undefined || selected.state !== "active") { setDetailState({ status: "idle" }); return; }
    const key = `${selected.savePointId}\u0000${selected.turnId}`;
    if (initialDetail !== undefined && detailKey(initialDetail) === key) { setDetailState({ status: "ready", key, value: initialDetail }); return; }
    const controller = new AbortController();
    setDetailState({ status: "loading", key });
    detail(selected.savePointId, controller.signal).then((value) => {
      if (controller.signal.aborted || value.savePointId !== selected.savePointId || value.turnId !== selected.turnId) return;
      setDetailState({ status: "ready", key, value });
      if (selectionStarted.current !== undefined) { onSelectionSample?.(performance.now() - selectionStarted.current); selectionStarted.current = undefined; }
    }, () => { if (!controller.signal.aborted) setDetailState({ status: "error" }); });
    return () => controller.abort();
  }, [detail, initialDetail, onSelectionSample, selected]);

  const replayAvailable = selected?.capturedReplay?.availability === "available";
  const screenshotAvailable = selected?.capturedThumbnail?.availability === "available";
  const mediaBinding = selected === undefined ? undefined : historyMediaBinding(selected);
  const keyedDetail = detailState.status === "ready" && detailState.key === selectedKey ? detailState.value : undefined;
  const detailBindingMismatch = keyedDetail !== undefined && mediaBinding !== undefined && (keyedDetail.revision !== mediaBinding.revision || keyedDetail.manifestDigest !== mediaBinding.manifestDigest);
  const currentDetail = detailBindingMismatch ? undefined : keyedDetail;

  const select = useCallback((item: HistoryFilmstripItem, replace = false) => {
    selectionStarted.current = performance.now();
    setSelectedLineageId("lineage:original");
    setSelectedId(item.savePointId);
    originalSelectionId.current = item.savePointId;
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", replaySelectionUrl(item.savePointId));
  }, []);

  const lineageStatus = useRef<HTMLSpanElement>(null);
  const selectLineage = useCallback((lineageId: string) => {
    const root = lineageId === "lineage:original" ? items.find(({ savePointId }) => savePointId === originalSelectionId.current) ?? selected : alternateRoot;
    if (root === undefined) return;
    if (lineageId !== "lineage:original" && selectedLineageId === "lineage:original" && selected !== undefined) originalSelectionId.current = selected.savePointId;
    selectionStarted.current = performance.now();
    setSelectedLineageId(lineageId);
    setSelectedId(root.savePointId);
    window.history.pushState({}, "", replaySelectionUrl(root.savePointId, lineageId));
    queueMicrotask(() => lineageStatus.current?.focus());
  }, [alternateRoot, items, selected, selectedLineageId]);

  if (load.status === "loading") return <section className="replay-workspace-state" role="status"><h1>Loading Replay Rewind</h1><p>Reading the bounded local history. No slot is being synthesized.</p></section>;
  if (load.status === "error") return <section className="replay-workspace-state error" role="alert"><h1>Replay history unavailable</h1><p>The bounded history projection could not be validated. Saved results remain available.</p><a href="/save-points">Open saved results</a></section>;
  if (items.length === 0) return <section className="replay-workspace-state"><h1>No replay history yet</h1><p>Create a trustworthy durable save point before opening Replay Rewind.</p><a href="/save-points">Open saved results</a></section>;

  return <section className="replay-workspace" aria-labelledby="replay-workspace-title">
    <header className="replay-workspace-heading"><div><p>Read-only operating loop</p><h1 id="replay-workspace-title">Replay Rewind</h1><span>Navigate trustworthy history without changing source or lineage.</span></div><span className="read-only-badge">Read only</span></header>
    <ReadOnlyTransport
      position={lineageIndex < 0 ? 0 : lineageIndex + 1}
      size={selectedLineage.length}
      canPrevious={lineageIndex > 0}
      canNext={lineageIndex >= 0 && lineageIndex < selectedLineage.length - 1}
      onPrevious={() => { const item = selectedLineage[lineageIndex - 1]; if (item !== undefined) select(item); }}
      onNext={() => { const item = selectedLineage[lineageIndex + 1]; if (item !== undefined) select(item); }}
    />
    <nav className="lineage-navigation" aria-label="Original and alternate futures">
      <button type="button" aria-pressed={selectedLineageId === "lineage:original"} onClick={() => selectLineage("lineage:original")}>Original future</button>
      <button type="button" aria-pressed={selectedLineageId !== "lineage:original"} disabled={alternateRoot === undefined} onClick={() => alternateLineage !== undefined && selectLineage(alternateLineage.lineageId)}>Alternate future</button>
      <span ref={lineageStatus} tabIndex={-1} role="status">{selectedLineageId === "lineage:original" ? "Viewing the preserved original lineage." : `Viewing verified alternate lineage ${alternateLineage?.gitRef ?? "unavailable"} at its lineage-bound root.`}</span>
    </nav>
    <HistoryFilmstrip items={items} onSelect={select} {...(selectedId === undefined ? {} : { selectedId })} {...(mediaClient === undefined ? {} : { mediaClient })} />
    {selected === undefined ? <section className="selected-turn error" role="alert"><h2>Selected turn unavailable</h2><p>This stable replay identity is not present in the trustworthy history projection. No replacement slot was invented.</p><a href="/replay">Open surviving history</a></section>
      : selected.state === "tombstone" ? <section className="selected-turn tombstone" role="status" aria-live="polite"><p>Lifecycle-safe history</p><h2>Turn {selected.sequenceNo} was deleted</h2><span>Only its non-sensitive sequence, lineage, identity, and deletion receipt survive. ReMo did not request screenshot, replay, source, or decision evidence.</span><code>{selected.savePointId}</code></section>
        : <section
          className="selected-turn"
          aria-live="polite"
          {...(currentDetail === undefined ? {} : {
            "data-detail-revision": String(currentDetail.revision),
            "data-detail-manifest-digest": currentDetail.manifestDigest,
          })}
        >
          <div><p>{selectedLineageId === "lineage:original" ? "Original lineage" : "Alternate lineage root context"} · Turn {selected.sequenceNo}</p><h2>{selected.majorTurnLabel ?? "Major-turn label unavailable"}</h2><span>{currentDetail?.nominationReason ?? selected.nominationReason ?? "Nomination reason unavailable"}</span>{selectedLineageId === "lineage:original" ? null : <small className="lineage-provenance">Verified branch root projected from original save point evidence; no alternate evidence was invented.</small>}</div>
          <dl><div><dt>Integrity</dt><dd>{integrityLabel(selected.integrity)}</dd></div><div><dt>Fidelity</dt><dd>{fidelityLabel(selected.fidelity)}</dd></div><div><dt>Identity</dt><dd><code>{selected.savePointId}</code></dd></div></dl>
          {detailState.status === "loading" ? <p className="selected-detail-state" role="status">Loading the selected safe evidence projection</p> : null}
          {detailState.status === "error" ? <p className="selected-detail-state error" role="alert">The safe detail projection is unavailable. Filmstrip identity remains selected.</p> : null}
          {detailBindingMismatch ? <p className="selected-detail-state error" role="alert">The selected detail revision does not match the media-adjusted history projection. Evidence remains unavailable.</p> : null}
          {currentDetail === undefined ? null : <EvidenceMediaPanel key={detailState.key} identity={{ savePointId: currentDetail.savePointId, turnId: currentDetail.turnId, revision: mediaBinding?.revision ?? currentDetail.revision, manifestDigest: mediaBinding?.manifestDigest ?? currentDetail.manifestDigest }} screenshotAvailable={screenshotAvailable} replayAvailable={replayAvailable} {...(mediaClient === undefined ? {} : { client: mediaClient })} />}
        </section>}
    {selectedLineageId === "lineage:original" && selected?.state === "active" && currentDetail !== undefined && branchPreflightClient !== undefined
      ? <BranchPreflightPanel savePointId={currentDetail.savePointId} savePointRevision={currentDetail.revision} client={branchPreflightClient} {...(branchOrchestrationClient === undefined ? {} : { orchestrationClient: branchOrchestrationClient })} onBranchResult={onBranchResult} />
      : null}
    <p className="transport-safety">Previous, restart, and next operate only on this selected lineage and historical view. The screenshot and replay status remain inside the existing trusted-parent evidence surface. This workspace imports no source, branch, lineage-mutation, reset, or deletion port.</p>
  </section>;
}
