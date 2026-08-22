import { useEffect, useRef, useState } from "react";
import type { HistoryFilmstripItem } from "@remo/domain/browser";
import type { EvidenceMediaClient } from "../evidence-media/evidence-media-client.js";
import { useSharedMediaRequest } from "../evidence-media/use-shared-media-request.js";
import "./HistoryFilmstrip.css";

const shortLineage = (lineageId: string): string => lineageId === "lineage:original" ? "Original" : "Alternate";
const integrityLabel = (value: HistoryFilmstripItem["integrity"]): string => value === "complete" ? "Complete" : value === "incomplete" ? "Incomplete" : value === "quarantined" ? "Quarantined" : "Deleted";
const fidelityLabel = (value: HistoryFilmstripItem["fidelity"]): string => value === "editable-eligible" ? "Editable eligible" : value === "degraded" ? "Degraded" : "Unavailable";
const trustLabel = (item: HistoryFilmstripItem): string => item.state === "tombstone"
  ? "Deleted"
  : `${integrityLabel(item.integrity)} · ${fidelityLabel(item.fidelity)}`;

function CapturedThumbnail({ item, client }: { readonly item: HistoryFilmstripItem; readonly client?: EvidenceMediaClient }) {
  const [url, setUrl] = useState<string>();
  const objectUrlRef = useRef<string>();
  const thumbnail = item.capturedThumbnail;
  const available = thumbnail?.availability === "available" && client !== undefined;
  const requestKey = thumbnail?.availability === "available"
    ? `${item.savePointId}:${item.turnId}:${thumbnail.revision}:${thumbnail.manifestDigest}`
    : `${item.savePointId}:${item.turnId}:unavailable`;

  useEffect(() => {
    if (objectUrlRef.current !== undefined) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = undefined;
    setUrl(undefined);
    return () => {
      if (objectUrlRef.current !== undefined) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = undefined;
    };
  }, [client, requestKey]);

  useSharedMediaRequest({
    enabled: available,
    requestKey,
    source: client,
    request: (source, signal) => source.screenshot({ savePointId: item.savePointId, turnId: item.turnId, revision: thumbnail!.revision, manifestDigest: thumbnail!.manifestDigest }, signal),
    onResolve: ({ blob }) => {
      if (objectUrlRef.current !== undefined) URL.revokeObjectURL(objectUrlRef.current);
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      setUrl(objectUrl);
    },
    onReject: () => setUrl(undefined),
  });
  return <div className="filmstrip-thumbnail" data-thumbnail-availability={url === undefined ? "unavailable" : "available"}>
    {url === undefined
      ? <span>{item.state === "tombstone" ? "Evidence deleted" : "Captured thumbnail unavailable"}</span>
      : <img src={url} alt={`Captured thumbnail for save point ${item.savePointId}`} />}
  </div>;
}

export function HistoryFilmstrip({ items, selectedId, onSelect, mediaClient }: {
  readonly items: readonly HistoryFilmstripItem[];
  readonly selectedId?: string;
  readonly onSelect: (item: HistoryFilmstripItem) => void;
  readonly mediaClient?: EvidenceMediaClient;
}) {
  const optionRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasSelectedItem = items.some(({ savePointId }) => savePointId === selectedId);
  useEffect(() => {
    if (selectedId === undefined) return;
    const container = scrollRef.current;
    const selected = optionRefs.current.get(selectedId);
    if (container === null || selected === undefined) return;
    container.scrollLeft = Math.max(0, selected.offsetLeft - (container.clientWidth - selected.clientWidth) / 2);
  }, [items, selectedId]);
  const move = (current: HistoryFilmstripItem, key: string): void => {
    const index = items.findIndex(({ savePointId }) => savePointId === current.savePointId);
    const targetIndex = key === "Home" ? 0
      : key === "End" ? items.length - 1
        : key === "ArrowRight" || key === "ArrowDown" ? Math.min(index + 1, items.length - 1)
          : key === "ArrowLeft" || key === "ArrowUp" ? Math.max(index - 1, 0)
            : index;
    const target = items[targetIndex];
    if (target !== undefined && target.savePointId !== current.savePointId) {
      onSelect(target);
      queueMicrotask(() => optionRefs.current.get(target.savePointId)?.focus());
    }
  };
  return <section className="filmstrip-region" aria-labelledby="filmstrip-title">
    <div className="filmstrip-heading"><div><p>Trustworthy history</p><h2 id="filmstrip-title">Major turns</h2></div><span>{items.length} supportable slots</span></div>
    <div className="filmstrip-scroll" ref={scrollRef} role="listbox" aria-label="Major-turn history" aria-orientation="horizontal">
      {items.map((item) => {
        const selected = item.savePointId === selectedId;
        return <div
          key={item.savePointId}
          ref={(node) => { if (node === null) optionRefs.current.delete(item.savePointId); else optionRefs.current.set(item.savePointId, node); }}
          id={`history-option-${item.savePointId}`}
          className={`filmstrip-option${selected ? " selected" : ""}${item.state === "tombstone" ? " tombstone" : ""}`}
          role="option"
          aria-selected={selected}
          aria-label={item.accessibleName}
          aria-posinset={item.position}
          aria-setsize={item.setSize}
          tabIndex={selected || (!hasSelectedItem && item.position === 1) ? 0 : -1}
          data-lifecycle-state={item.state}
          onClick={() => onSelect(item)}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); move(item, event.key); }
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(item); }
          }}
        >
          <CapturedThumbnail item={item} {...(mediaClient === undefined ? {} : { client: mediaClient })} />
          <div className="filmstrip-sequence"><span>Turn {item.sequenceNo}</span><small>{shortLineage(item.lineageId)}</small></div>
          <strong>{item.state === "tombstone" ? "Deleted turn" : item.majorTurnLabel ?? "Major-turn label unavailable"}</strong>
          <p>{item.state === "tombstone" ? "Safe lifecycle receipt only. Evidence was not fetched." : item.nominationReason ?? "Nomination reason unavailable"}</p>
          <div className="filmstrip-trust"><span>{trustLabel(item)}</span><small>{item.position} of {item.setSize}</small></div>
        </div>;
      })}
    </div>
    <p className="filmstrip-help">Use Left/Right or Up/Down arrows to move, and Home/End to jump. Selection follows focus.</p>
  </section>;
}
