import { useEffect, useMemo, useState } from "react";
import { projectHistoryFilmstrip, type HistoryFilmstripItem } from "@remo/domain/browser";
import { HistoryFilmstrip } from "../history-filmstrip/HistoryFilmstrip.js";
import type { HistoryDetailSummary } from "../history-filmstrip/ReplayWorkspace.js";
import { EvidenceMediaPanel, type EvidenceReplaySurfaceProps } from "../evidence-media/EvidenceMediaPanel.js";
import { DecisionCard } from "../decision-card/DecisionCard.js";
import { ComparisonWorkspace } from "../comparison/ComparisonWorkspace.js";
import { ReadOnlyTransport } from "../transport/ReadOnlyTransport.js";
import { HostedDemoDetailLoader, HostedDemoHistoryClient } from "./hosted-demo-clients.js";
import { HOSTED_DEMO_COMPARISON_PAIR, createHostedDemoComparisonClient, createHostedDemoDecisionClient } from "./hosted-demo-decision-comparison.js";
import { createHostedDemoEvidenceMediaClient } from "./hosted-demo-media.js";
import { HostedDemoReplaySurface, type HostedDemoBundleReplayBinding } from "./HostedDemoReplaySurface.js";
import { HostedDemoBranchExperience } from "./HostedDemoBranchExperience.js";
import type { HostedDemoFixtureBundle } from "./hosted-demo-fixture.js";
import type { HostedDemoReplayManifestEntry } from "./hosted-demo-fixture-source.js";

export type HostedDemoRoute =
  | { readonly kind: "entry" | "replay" | "compare"; readonly path: string }
  | { readonly kind: "replay-detail"; readonly path: string; readonly savePointId: string }
  | { readonly kind: "unsupported"; readonly path: string };

export function matchHostedDemoRoute(path: string): HostedDemoRoute {
  if (path === "/" || path === "/save-points") return { kind: "entry", path };
  if (path === "/replay") return { kind: "replay", path };
  if (path === "/compare") return { kind: "compare", path };
  const detail = /^\/replay\/([A-Za-z0-9_-]{1,128})$/u.exec(path);
  return detail === null ? { kind: "unsupported", path } : { kind: "replay-detail", path, savePointId: detail[1]! };
}

function defaultSelection(items: readonly HistoryFilmstripItem[], route: Exclude<HostedDemoRoute, { readonly kind: "unsupported" }>): string | undefined {
  if (route.kind === "replay-detail") return route.savePointId;
  if (route.kind === "entry" || route.kind === "compare") return items.find(({ sequenceNo, state }) => sequenceNo === 4 && state === "active")?.savePointId;
  return [...items].reverse().find(({ state }) => state === "active")?.savePointId;
}

export function hostedDemoIntegrityCopy(fixture: HostedDemoFixtureBundle, savePointId: string): string {
  const media = fixture.media.filter((entry) => entry.savePointId === savePointId);
  const hasScreenshot = media.some(({ kind }) => kind === "screenshot");
  const hasReplay = media.some(({ kind }) => kind === "replay");
  if (hasScreenshot && hasReplay) return "Manifest-bound synthetic screenshot and bounded replay are available.";
  const hasComparison = Object.values(fixture.comparisonsByPair).some(({ left, right }) => left.savePointId === savePointId || right.savePointId === savePointId);
  if (hasScreenshot && hasComparison) return "Manifest-bound synthetic screenshot available for qualified comparison.";
  if (hasScreenshot) return "Manifest-bound synthetic screenshot is available.";
  return "No manifest-bound media is available for this synthetic anchor.";
}

export function HostedDemoHistory({ fixture, route, navigate }: {
  readonly fixture: HostedDemoFixtureBundle;
  readonly route: Exclude<HostedDemoRoute, { readonly kind: "unsupported" }>;
  readonly navigate: (path: string) => void;
}) {
  const historyClient = useMemo(() => new HostedDemoHistoryClient(fixture), [fixture]);
  const detailLoader = useMemo(() => new HostedDemoDetailLoader(fixture), [fixture]);
  const mediaClient = useMemo(() => createHostedDemoEvidenceMediaClient(fixture), [fixture]);
  const decisionClient = useMemo(() => createHostedDemoDecisionClient(fixture), [fixture]);
  const comparisonClient = useMemo(() => createHostedDemoComparisonClient(fixture), [fixture]);
  const replayBinding = useMemo<HostedDemoBundleReplayBinding | undefined>(() => {
    const replay = fixture.media.find((entry): entry is HostedDemoReplayManifestEntry => entry.kind === "replay");
    return replay === undefined ? undefined : Object.freeze({ fixtureRevision: fixture.fixtureRevision, replay });
  }, [fixture]);
  const replaySurface = useMemo(() => {
    const BundleBoundHostedDemoReplaySurface = (props: EvidenceReplaySurfaceProps) => <HostedDemoReplaySurface {...props} replayBinding={replayBinding} />;
    return BundleBoundHostedDemoReplaySurface;
  }, [replayBinding]);
  const [items, setItems] = useState<readonly HistoryFilmstripItem[]>();
  const [historyError, setHistoryError] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<HistoryDetailSummary>();
  const [detailError, setDetailError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryError(false);
    historyClient.list(controller.signal).then((page) => {
      const projected = projectHistoryFilmstrip(page);
      setItems(projected);
      setSelectedId(defaultSelection(projected, route));
    }, () => { if (!controller.signal.aborted) setHistoryError(true); });
    return () => controller.abort();
  }, [historyClient, route]);

  const selectedIndex = items?.findIndex(({ savePointId }) => savePointId === selectedId) ?? -1;
  const selected = selectedIndex < 0 ? undefined : items?.[selectedIndex];

  useEffect(() => {
    setDetail(undefined);
    setDetailError(false);
    if (selected === undefined || selected.state !== "active") return;
    const controller = new AbortController();
    detailLoader.load(selected.savePointId, controller.signal).then(setDetail, () => { if (!controller.signal.aborted) setDetailError(true); });
    return () => controller.abort();
  }, [detailLoader, selected]);

  const choose = (item: HistoryFilmstripItem): void => {
    setSelectedId(item.savePointId);
    navigate(`/replay/${encodeURIComponent(item.savePointId)}`);
  };

  if (historyError) return <section className="hosted-demo-unavailable" role="alert"><h2>Hosted demonstration unavailable</h2><p>The immutable history projection could not be read safely. No evidence was substituted.</p><a href="/save-points">Retry from history</a></section>;
  if (items === undefined) return <section className="hosted-demo-loading" role="status"><h2>Preparing the synthetic fixture</h2><p>Validating ten deterministic history identities.</p></section>;
  if (route.kind === "compare") return <ComparisonWorkspace client={comparisonClient} mediaClient={mediaClient} defaultPair={HOSTED_DEMO_COMPARISON_PAIR} presentationMode="hosted-demo" />;

  const returnPair = new URLSearchParams(window.location.search);
  const canReturnToComparison = returnPair.get("compareLeft") === HOSTED_DEMO_COMPARISON_PAIR.left && returnPair.get("compareRight") === HOSTED_DEMO_COMPARISON_PAIR.right;

  return <section className="hosted-demo-history" aria-labelledby="hosted-demo-history-title">
    <header className="hosted-demo-history-heading">
      <div><p className="hosted-demo-eyebrow">Read-only simulated fixture</p><h2 id="hosted-demo-history-title">Ten major-turn anchors</h2></div>
      <span>Fixture revision <code>{fixture.fixtureRevision}</code></span>
    </header>
    {canReturnToComparison ? <p className="hosted-demo-route-note" role="status">Returned from the exact Turn 4 before / Turn 5 after comparison. <a href={`/compare?${new URLSearchParams({ left: HOSTED_DEMO_COMPARISON_PAIR.left, right: HOSTED_DEMO_COMPARISON_PAIR.right })}`}>Return to the qualified comparison</a></p> : null}
    <ReadOnlyTransport
      position={selectedIndex < 0 ? 0 : selectedIndex + 1}
      size={items.length}
      canPrevious={selectedIndex > 0}
      canNext={selectedIndex >= 0 && selectedIndex < items.length - 1}
      onPrevious={() => { const item = items[selectedIndex - 1]; if (item !== undefined) choose(item); }}
      onNext={() => { const item = items[selectedIndex + 1]; if (item !== undefined) choose(item); }}
    />
    <HistoryFilmstrip items={items} {...(selectedId === undefined ? {} : { selectedId })} onSelect={choose} />
    {selected === undefined
      ? <section className="hosted-demo-selection hosted-demo-unavailable" role="alert"><h2>Fixture identity unavailable</h2><p>This route does not match one of the ten manifest-bound identities. No alternate evidence was requested or invented.</p><a href="/save-points">Open the fixture history</a></section>
      : selected.state === "tombstone"
        ? <section className="hosted-demo-selection" role="status"><p className="hosted-demo-eyebrow">Lifecycle-safe synthetic identity</p><h2>Turn {selected.sequenceNo} was deleted</h2><p>No protected evidence or detail was loaded for this tombstone.</p><code>{selected.savePointId}</code></section>
        : <section className="hosted-demo-selection" aria-live="polite">
          <p className="hosted-demo-eyebrow">Simulated fixture evidence · Turn {selected.sequenceNo}</p>
          <h2>{selected.majorTurnLabel}</h2>
          <p>{detail?.nominationReason ?? selected.nominationReason}</p>
          <dl><div><dt>Identity</dt><dd><code>{selected.savePointId}</code></dd></div><div><dt>Integrity</dt><dd>{hostedDemoIntegrityCopy(fixture, selected.savePointId)}</dd></div><div><dt>Authority</dt><dd>Immutable synthetic fixture</dd></div></dl>
          {detailError ? <p role="alert">The manifest-bound detail is unavailable. Filmstrip identity remains usable.</p> : null}
          {selected.sequenceNo === 4 && detail !== undefined
            ? <EvidenceMediaPanel
                key={`${detail.savePointId}:${detail.revision}:${detail.manifestDigest}`}
                identity={{ savePointId: detail.savePointId, turnId: detail.turnId, revision: detail.revision, manifestDigest: detail.manifestDigest }}
                screenshotAvailable
                replayAvailable
                client={mediaClient}
                replaySurface={replaySurface}
                presentationMode="hosted-demo"
              />
            : null}
          {detail !== undefined ? <DecisionCard savePointId={detail.savePointId} turnId={detail.turnId} majorTurnExplanation={detail.nominationReason} client={decisionClient} /> : null}
          {selected.sequenceNo === 4 ? <a className="hosted-demo-comparison-link" href={`/compare?${new URLSearchParams({ left: HOSTED_DEMO_COMPARISON_PAIR.left, right: HOSTED_DEMO_COMPARISON_PAIR.right })}`}>Compare Turn 4 with Turn 5</a> : null}
        </section>}
    {selected?.state === "active" && selected.sequenceNo === 4 && detail !== undefined ? <HostedDemoBranchExperience fixture={fixture} items={items} /> : null}
  </section>;
}
