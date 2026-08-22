import { useEffect, useState } from "react";
import { projectHistoryFilmstrip } from "@remo/domain/browser";
import { createLoopbackHistoryClient } from "../history-filmstrip/history-client.js";
import { DecisionCard } from "./DecisionCard.js";

const currentSavePointId = (): string | undefined => /^\/replay\/([A-Za-z0-9_-]{1,128})$/u.exec(window.location.pathname)?.[1];
const ROUTE_EVENT = "remo:replay-route-change";
const REPLAY_DECISION_SETTLE_MS = 1_000;

export function DecisionCardRouteMount() {
  const [selection, setSelection] = useState<{ readonly savePointId: string; readonly turnId: string; readonly explanation: string }>();
  useEffect(() => {
    let generation = 0;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const client = createLoopbackHistoryClient(window.location.origin);
    const update = () => {
      const requested = currentSavePointId(); const current = ++generation;
      if (requested === undefined) { setSelection(undefined); return; }
      void client.list().then((page) => {
        if (generation !== current) return;
        const item = projectHistoryFilmstrip(page).find(({ savePointId }) => savePointId === requested);
        if (item === undefined || item.state !== "active") { setSelection(undefined); return; }
        void fetch(`/api/save-points/${encodeURIComponent(item.savePointId)}`, { method: "GET", credentials: "same-origin" }).then(async (response) => response.ok ? await response.json() as unknown : undefined).then((value) => {
          if (generation !== current) return;
          const detail = typeof value === "object" && value !== null ? value as { readonly turnId?: unknown; readonly nominationReason?: unknown } : undefined;
          const explanation = detail?.turnId === item.turnId && typeof detail.nominationReason === "string" ? detail.nominationReason : item.nominationReason ?? "Major-turn explanation unavailable";
          setSelection({ savePointId: item.savePointId, turnId: item.turnId, explanation });
        }, () => { if (generation === current) setSelection({ savePointId: item.savePointId, turnId: item.turnId, explanation: item.nominationReason ?? "Major-turn explanation unavailable" }); });
      }, () => { if (generation === current) setSelection(undefined); });
    };
    const scheduleUpdate = () => {
      if (scheduled !== undefined) clearTimeout(scheduled);
      generation += 1;
      setSelection(undefined);
      scheduled = setTimeout(update, REPLAY_DECISION_SETTLE_MS);
    };
    const originalPush = window.history.pushState.bind(window.history);
    const originalReplace = window.history.replaceState.bind(window.history);
    const push: History["pushState"] = function (...args) { originalPush.apply(window.history, args); window.dispatchEvent(new Event(ROUTE_EVENT)); };
    const replace: History["replaceState"] = function (...args) { originalReplace.apply(window.history, args); window.dispatchEvent(new Event(ROUTE_EVENT)); };
    window.history.pushState = push; window.history.replaceState = replace;
    window.addEventListener("popstate", scheduleUpdate); window.addEventListener(ROUTE_EVENT, scheduleUpdate);
    update();
    return () => { if (scheduled !== undefined) clearTimeout(scheduled); if (window.history.pushState === push) window.history.pushState = originalPush; if (window.history.replaceState === replace) window.history.replaceState = originalReplace; window.removeEventListener("popstate", scheduleUpdate); window.removeEventListener(ROUTE_EVENT, scheduleUpdate); };
  }, []);
  if (selection === undefined) return null;
  return <DecisionCard key={`${selection.savePointId}\u0000${selection.turnId}`} savePointId={selection.savePointId} turnId={selection.turnId} majorTurnExplanation={selection.explanation} />;
}
