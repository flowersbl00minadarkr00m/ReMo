import { describe, expect, it } from "vitest";
import { assertHistoryPage, historyMediaBinding, projectHistoryFilmstrip, projectMediaAdjustedHistoryAnchor, type HistoryAnchor } from "./contracts.js";

const anchor = (sequenceNo: number, overrides: Partial<HistoryAnchor> = {}): HistoryAnchor => ({
  savePointId: `save-${sequenceNo}`,
  turnId: `turn-${sequenceNo}`,
  sequenceNo,
  lineageId: "lineage:original",
  promotedAt: "2026-08-16T08:00:00.000Z",
  majorTurnLabel: `Turn ${sequenceNo}`,
  nominationReason: "fixture boundary",
  state: "active",
  provenance: "fixture-contract",
  integrity: "complete",
  fidelity: "editable-eligible",
  ...overrides,
});

describe("history filmstrip projection", () => {
  it("orders the original lineage deterministically and preserves the safe tombstone position", () => {
    const alternate = anchor(5, { savePointId: "alternate-5", lineageId: "lineage:alternate", parentSavePointId: "save-4" });
    const projected = projectHistoryFilmstrip({ anchors: [alternate, anchor(4), anchor(2), tombstone("delete-turn-06"), anchor(1)], limit: 10, truncated: false });

    expect(projected.map(({ savePointId }) => savePointId)).toEqual(["save-1", "save-2", "save-4", "alternate-5", "save-6"]);
    expect(projected[4]).toMatchObject({ position: 5, setSize: 5, selectionPath: "/replay/save-6", state: "tombstone" });
    expect(projected[4]?.accessibleName).toBe("Turn 6, deleted evidence tombstone, lineage:original, position 5 of 5");
    expect(projected[4]).not.toHaveProperty("majorTurnLabel");
    expect(projected[4]).not.toHaveProperty("nominationReason");
  });

  it("does not mutate the loaded page while deriving stable routes and truthful unknown summaries", () => {
    const { majorTurnLabel, nominationReason, ...withoutLabels } = anchor(4);
    expect([majorTurnLabel, nominationReason]).toEqual(["Turn 4", "fixture boundary"]);
    const page = { anchors: [withoutLabels], limit: 10, truncated: false } as const;
    const before = JSON.stringify(page);
    expect(projectHistoryFilmstrip(page)[0]).toMatchObject({ selectionPath: "/replay/save-4", position: 1, setSize: 1 });
    expect(projectHistoryFilmstrip(page)[0]?.accessibleName).toMatch(/label unavailable.*nomination reason unavailable/u);
    expect(JSON.stringify(page)).toBe(before);
  });
});

const tombstone = (lifecycleReceiptId?: string): HistoryAnchor => {
  return { savePointId: "save-6", turnId: "turn-6", sequenceNo: 6, lineageId: "lineage:original", state: "tombstone", ...(lifecycleReceiptId === undefined ? {} : { lifecycleReceiptId }), provenance: "fixture-contract", integrity: "deleted", fidelity: "unavailable" };
};

describe("history contracts", () => {
  it("accepts bounded unique ordered identities and a receipt-bound non-sensitive tombstone", () => {
    const page = { anchors: [anchor(1), tombstone("delete-turn-06")], limit: 10, truncated: false } as const;
    expect(assertHistoryPage(page)).toBe(page);
  });

  it("rejects invented tombstone detail, missing receipt authority, duplicate slots, and oversized bounds", () => {
    expect(() => assertHistoryPage({ anchors: [anchor(6, { state: "tombstone", lifecycleReceiptId: "receipt", integrity: "deleted", fidelity: "unavailable" })], limit: 10, truncated: false })).toThrow(/sensitive/u);
    expect(() => assertHistoryPage({ anchors: [tombstone()], limit: 10, truncated: false })).toThrow(/receipt/u);
    expect(() => assertHistoryPage({ anchors: [anchor(1), anchor(1, { savePointId: "other" })], limit: 10, truncated: false })).toThrow(/duplicate/u);
    expect(() => assertHistoryPage({ anchors: [], limit: 11, truncated: false })).toThrow(/bound/u);
  });

  it("rejects globally duplicated identities and discontinuous alternate lineage roots", () => {
    expect(() => assertHistoryPage({ anchors: [anchor(1), anchor(2, { savePointId: "save-1" })], limit: 10, truncated: false })).toThrow(/duplicate save-point/u);
    expect(() => assertHistoryPage({ anchors: [anchor(4), anchor(6, { savePointId: "alternate-6", lineageId: "lineage:alternate", parentSavePointId: "save-4" })], limit: 10, truncated: false })).toThrow(/discontinuous/u);
    expect(() => assertHistoryPage({ anchors: [anchor(4), anchor(5, { savePointId: "alternate-5", lineageId: "lineage:alternate", parentSavePointId: "missing-root" })], limit: 10, truncated: false })).toThrow(/root/u);
  });

  it("supports ten original anchors plus one bounded alternate lineage", () => {
    const original = Array.from({ length: 10 }, (_, index) => anchor(index + 1));
    const alternate = anchor(6, { savePointId: "alternate-6", turnId: "alternate-turn-6", lineageId: "lineage:alternate", parentSavePointId: "save-5" });
    const page = { anchors: [...original, alternate], limit: 10, truncated: false } as const;
    expect(assertHistoryPage(page)).toBe(page);
    expect(projectHistoryFilmstrip(page).map(({ savePointId }) => savePointId).slice(4, 7)).toEqual(["save-5", "alternate-6", "save-6"]);
  });

  it("derives media availability and trust from one revision-bound safe projection", () => {
    const adjusted = projectMediaAdjustedHistoryAnchor(anchor(4), {
      revision: 3,
      manifestDigest: `sha256:${"a".repeat(64)}`,
      screenshotAvailable: true,
      replayAvailable: false,
    });
    expect(adjusted).toMatchObject({
      savePointId: "save-4",
      turnId: "turn-4",
      integrity: "incomplete",
      fidelity: "degraded",
      capturedThumbnail: { availability: "available", revision: 3, manifestDigest: `sha256:${"a".repeat(64)}` },
      capturedReplay: { availability: "unavailable" },
    });
    expect(historyMediaBinding(adjusted)).toEqual({ revision: 3, manifestDigest: `sha256:${"a".repeat(64)}` });
    expect(() => assertHistoryPage({ anchors: [{ ...adjusted, integrity: "complete", fidelity: "editable-eligible" }], limit: 10, truncated: false })).toThrow(/contradictory/u);
  });

  it("rejects media bindings that disagree for one stable identity", () => {
    const projected = projectMediaAdjustedHistoryAnchor(anchor(4), {
      revision: 3,
      manifestDigest: `sha256:${"a".repeat(64)}`,
      screenshotAvailable: true,
      replayAvailable: true,
    });
    expect(() => assertHistoryPage({ anchors: [{ ...projected, capturedReplay: { availability: "available", revision: 4, manifestDigest: `sha256:${"b".repeat(64)}` } }], limit: 10, truncated: false })).toThrow(/bindings disagree/u);
  });
});
