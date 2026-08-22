export const HISTORY_STATES = ["active", "quarantined", "tombstone"] as const;
export type HistoryState = (typeof HISTORY_STATES)[number];

export const HISTORY_PROVENANCE = ["observed", "fixture-contract", "reconstructed-order"] as const;
export type HistoryProvenance = (typeof HISTORY_PROVENANCE)[number];

export interface HistoryAnchor {
  readonly savePointId: string;
  readonly turnId: string;
  readonly sequenceNo: number;
  readonly lineageId: string;
  readonly parentSavePointId?: string;
  readonly promotedAt?: string;
  readonly majorTurnLabel?: string;
  readonly nominationReason?: string;
  readonly capturedThumbnail?:
    | { readonly availability: "available"; readonly reference: string; readonly revision: number; readonly manifestDigest: string }
    | { readonly availability: "unavailable" };
  readonly capturedReplay?:
    | { readonly availability: "available"; readonly revision: number; readonly manifestDigest: string }
    | { readonly availability: "unavailable" };
  readonly state: HistoryState;
  readonly lifecycleReceiptId?: string;
  readonly provenance: HistoryProvenance;
  readonly integrity: "complete" | "incomplete" | "quarantined" | "deleted";
  readonly fidelity: "editable-eligible" | "degraded" | "unavailable";
}

export interface HistoryMediaAuthorityProjection {
  readonly revision: number;
  readonly manifestDigest: string;
  readonly screenshotAvailable: boolean;
  readonly replayAvailable: boolean;
}

export interface HistoryMediaBinding {
  readonly revision: number;
  readonly manifestDigest: string;
}

export interface LineageRecord {
  readonly lineageId: string;
  readonly parentLineageId?: string;
  readonly rootSavePointId?: string;
  readonly branchOperationId?: string;
  readonly gitRef?: string;
  readonly worktreeRelativePath?: string;
  readonly state: "original" | "active-alternate" | "recovery-required";
}

export interface HistoryPage {
  readonly anchors: readonly HistoryAnchor[];
  readonly lineages?: readonly LineageRecord[];
  readonly limit: number;
  readonly truncated: boolean;
}

export interface HistoryReader {
  listHistory(limit?: number): HistoryPage;
}

export interface HistoryFilmstripItem extends HistoryAnchor {
  readonly position: number;
  readonly setSize: number;
  readonly selectionPath: string;
  readonly accessibleName: string;
}

export function historyMediaBinding(anchor: HistoryAnchor): HistoryMediaBinding | undefined {
  const thumbnail = anchor.capturedThumbnail?.availability === "available" ? anchor.capturedThumbnail : undefined;
  const replay = anchor.capturedReplay?.availability === "available" ? anchor.capturedReplay : undefined;
  if (thumbnail !== undefined && replay !== undefined && (thumbnail.revision !== replay.revision || thumbnail.manifestDigest !== replay.manifestDigest)) {
    throw new TypeError("History media authority bindings disagree.");
  }
  const binding = thumbnail ?? replay;
  return binding === undefined ? undefined : { revision: binding.revision, manifestDigest: binding.manifestDigest };
}

export function projectMediaAdjustedHistoryAnchor(anchor: HistoryAnchor, authority?: HistoryMediaAuthorityProjection): HistoryAnchor {
  const activeAuthority = anchor.state === "active" ? authority : undefined;
  const capturedThumbnail = activeAuthority?.screenshotAvailable === true
    ? { availability: "available" as const, reference: `/api/save-points/${encodeURIComponent(anchor.savePointId)}/media/screenshot`, revision: activeAuthority.revision, manifestDigest: activeAuthority.manifestDigest }
    : { availability: "unavailable" as const };
  const capturedReplay = activeAuthority?.replayAvailable === true
    ? { availability: "available" as const, revision: activeAuthority.revision, manifestDigest: activeAuthority.manifestDigest }
    : { availability: "unavailable" as const };
  const requiredMediaAvailable = activeAuthority?.screenshotAvailable === true && activeAuthority.replayAvailable === true;
  return {
    ...anchor,
    capturedThumbnail,
    capturedReplay,
    ...(anchor.state === "active" && !requiredMediaAvailable
      ? { integrity: "incomplete" as const, fidelity: "degraded" as const }
      : {}),
  };
}

export function assertHistoryPage(page: HistoryPage, maximum = 10): HistoryPage {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > maximum) throw new TypeError("History limit is outside the supported bound.");
  const identities = new Set<string>();
  const slots = new Set<string>();
  const lineages = new Map<string, HistoryAnchor[]>();
  const lineageRecords = page.lineages ?? [];
  if (lineageRecords.length > 2 || new Set(lineageRecords.map(({ lineageId }) => lineageId)).size !== lineageRecords.length) throw new TypeError("History lineage projection exceeds the bounded original-plus-one-alternate contract.");
  for (const lineage of lineageRecords) {
    if (lineage.lineageId === "lineage:original") {
      if (lineage.state !== "original" || lineage.parentLineageId !== undefined || lineage.branchOperationId !== undefined || lineage.gitRef !== undefined || lineage.worktreeRelativePath !== undefined) throw new TypeError("History original lineage projection is invalid.");
    } else if (lineage.state === "active-alternate") {
      if (lineage.parentLineageId !== "lineage:original" || lineage.rootSavePointId === undefined || lineage.branchOperationId === undefined || !lineage.gitRef?.startsWith("refs/heads/remo/") || lineage.worktreeRelativePath !== `.remo/worktrees/${lineage.branchOperationId}`) throw new TypeError("History alternate lineage projection is invalid.");
    } else if (lineage.state !== "recovery-required") throw new TypeError("History lineage projection state is invalid.");
  }
  for (const anchor of page.anchors) {
    if (!Number.isSafeInteger(anchor.sequenceNo) || anchor.sequenceNo < 1) throw new TypeError("History sequence must be a positive safe integer.");
    const slot = `${anchor.lineageId}\u0000${anchor.sequenceNo}`;
    if (slots.has(slot)) throw new TypeError("History contains a duplicate lineage sequence slot.");
    slots.add(slot);
    if (identities.has(anchor.savePointId)) throw new TypeError("History contains a duplicate save-point identity.");
    identities.add(anchor.savePointId);
    const lineage = lineages.get(anchor.lineageId) ?? [];
    lineage.push(anchor);
    lineages.set(anchor.lineageId, lineage);
    if (anchor.capturedThumbnail?.availability === "available") {
      if (anchor.state === "tombstone" || anchor.capturedThumbnail.reference !== `/api/save-points/${encodeURIComponent(anchor.savePointId)}/media/screenshot` || !Number.isSafeInteger(anchor.capturedThumbnail.revision) || anchor.capturedThumbnail.revision < 1 || !/^sha256:[0-9a-f]{64}$/u.test(anchor.capturedThumbnail.manifestDigest)) throw new TypeError("History captured-thumbnail authority is invalid.");
    }
    if (anchor.capturedReplay?.availability === "available" && (anchor.state === "tombstone" || !Number.isSafeInteger(anchor.capturedReplay.revision) || anchor.capturedReplay.revision < 1 || !/^sha256:[0-9a-f]{64}$/u.test(anchor.capturedReplay.manifestDigest))) throw new TypeError("History captured-replay authority is invalid.");
    historyMediaBinding(anchor);
    const hasMediaProjection = anchor.capturedThumbnail !== undefined || anchor.capturedReplay !== undefined;
    const requiredMediaUnavailable = anchor.capturedThumbnail?.availability !== "available" || anchor.capturedReplay?.availability !== "available";
    if (anchor.state === "active" && hasMediaProjection && requiredMediaUnavailable && (anchor.integrity === "complete" || anchor.fidelity === "editable-eligible")) {
      throw new TypeError("History media-adjusted trust projection is contradictory.");
    }
    if (anchor.state === "tombstone") {
      if (anchor.lifecycleReceiptId === undefined) throw new TypeError("A tombstone requires lifecycle receipt authority.");
      if (anchor.majorTurnLabel !== undefined || anchor.nominationReason !== undefined) throw new TypeError("A tombstone cannot expose sensitive label or nomination detail.");
      if (anchor.promotedAt !== undefined || anchor.parentSavePointId !== undefined) throw new TypeError("A tombstone cannot expose unsupported chronology detail.");
    } else if (anchor.promotedAt === undefined) {
      throw new TypeError("An active or quarantined history anchor requires its observed promotion time.");
    }
  }
  const original = lineages.get("lineage:original") ?? [];
  if (original.length > page.limit) throw new TypeError("History original lineage exceeds its declared bound.");
  const alternates = [...lineages.entries()].filter(([lineageId]) => lineageId !== "lineage:original");
  if (alternates.length > 1 || alternates.some(([, anchors]) => anchors.length > page.limit)) throw new TypeError("History exceeds the bounded original-plus-one-alternate lineage contract.");
  if (alternates.length > 0) {
    const originalById = new Map(original.map((anchor) => [anchor.savePointId, anchor]));
    const alternate = [...alternates[0]![1]].sort((left, right) => left.sequenceNo - right.sequenceNo || left.savePointId.localeCompare(right.savePointId, "en-US"));
    const root = alternate[0]?.parentSavePointId === undefined ? undefined : originalById.get(alternate[0].parentSavePointId);
    if (root === undefined || alternate[0]!.sequenceNo !== root.sequenceNo + 1) throw new TypeError("History alternate lineage root is discontinuous.");
    for (let index = 1; index < alternate.length; index += 1) {
      const previous = alternate[index - 1]!;
      const current = alternate[index]!;
      if (current.sequenceNo !== previous.sequenceNo + 1 || current.parentSavePointId !== previous.savePointId) throw new TypeError("History alternate lineage is discontinuous.");
    }
  }
  const activeAlternate = lineageRecords.find(({ state }) => state === "active-alternate");
  if (activeAlternate !== undefined && !original.some(({ savePointId }) => savePointId === activeAlternate.rootSavePointId)) throw new TypeError("History alternate lineage root is unavailable from original history.");
  return page;
}

function ancestryOrder(anchors: readonly HistoryAnchor[]): readonly HistoryAnchor[] {
  const original = anchors.filter(({ lineageId }) => lineageId === "lineage:original").sort((left, right) => left.sequenceNo - right.sequenceNo || left.savePointId.localeCompare(right.savePointId, "en-US"));
  const alternate = anchors.filter(({ lineageId }) => lineageId !== "lineage:original").sort((left, right) => left.sequenceNo - right.sequenceNo || left.savePointId.localeCompare(right.savePointId, "en-US"));
  if (alternate.length === 0) return original;
  const rootIndex = original.findIndex(({ savePointId }) => savePointId === alternate[0]!.parentSavePointId);
  return [...original.slice(0, rootIndex + 1), ...alternate, ...original.slice(rootIndex + 1)];
}

export function projectHistoryFilmstrip(page: HistoryPage, maximum = 10): readonly HistoryFilmstripItem[] {
  const valid = assertHistoryPage(page, maximum);
  const ordered = ancestryOrder(valid.anchors);
  return ordered.map((anchor, index) => ({
    ...anchor,
    position: index + 1,
    setSize: ordered.length,
    selectionPath: `/replay/${encodeURIComponent(anchor.savePointId)}`,
    accessibleName: anchor.state === "tombstone"
      ? `Turn ${anchor.sequenceNo}, deleted evidence tombstone, ${anchor.lineageId}, position ${index + 1} of ${ordered.length}`
      : `Turn ${anchor.sequenceNo}, ${anchor.majorTurnLabel ?? "major-turn label unavailable"}, ${anchor.nominationReason ?? "nomination reason unavailable"}, integrity ${anchor.integrity}, fidelity ${anchor.fidelity}, ${anchor.lineageId}, position ${index + 1} of ${ordered.length}`,
  }));
}
