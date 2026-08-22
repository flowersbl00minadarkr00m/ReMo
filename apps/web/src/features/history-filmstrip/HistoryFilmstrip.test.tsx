// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectHistoryFilmstrip, type HistoryFilmstripItem, type HistoryPage } from "@remo/domain/browser";
import type { EvidenceMediaClient } from "../evidence-media/evidence-media-client.js";
import { HistoryFilmstrip } from "./HistoryFilmstrip.js";

afterEach(cleanup);

const page: HistoryPage = {
  anchors: Array.from({ length: 10 }, (_, index) => {
    const sequenceNo = index + 1;
    return sequenceNo === 6
      ? { savePointId: "save-6", turnId: "turn-6", sequenceNo, lineageId: "lineage:original", state: "tombstone", lifecycleReceiptId: "delete-6", provenance: "fixture-contract", integrity: "deleted", fidelity: "unavailable" } as const
      : { savePointId: `save-${sequenceNo}`, turnId: `turn-${sequenceNo}`, sequenceNo, lineageId: "lineage:original", promotedAt: `2026-08-18T00:${String(sequenceNo).padStart(2, "0")}:00.000Z`, majorTurnLabel: `Turn ${sequenceNo}`, nominationReason: sequenceNo === 4 ? "Consequential low-uncertainty layout decision" : `Verification boundary ${sequenceNo}`, state: "active", provenance: "fixture-contract", integrity: "complete", fidelity: "editable-eligible" } as const;
  }),
  limit: 10,
  truncated: false,
};

describe("history filmstrip listbox", () => {
  it("supports Arrow, Home, End, position, lineage, and tombstone announcements", () => {
    const onSelect = vi.fn();
    render(<HistoryFilmstrip items={projectHistoryFilmstrip(page)} selectedId="save-4" onSelect={onSelect} />);
    const listbox = screen.getByRole("listbox", { name: "Major-turn history" });
    expect(listbox.getAttribute("aria-orientation")).toBe("horizontal");
    const selected = screen.getByRole("option", { selected: true });
    expect(selected.getAttribute("aria-posinset")).toBe("4");
    expect(selected.getAttribute("aria-setsize")).toBe("10");

    fireEvent.keyDown(selected, { key: "ArrowRight" });
    fireEvent.keyDown(selected, { key: "End" });
    fireEvent.keyDown(selected, { key: "Home" });
    expect(onSelect.mock.calls.map(([item]) => item.savePointId)).toEqual(["save-5", "save-10", "save-1"]);

    const tombstone = screen.getByRole("option", { name: /Turn 6, deleted evidence tombstone.*position 6 of 10/u });
    expect(tombstone.getAttribute("data-lifecycle-state")).toBe("tombstone");
    expect(tombstone.textContent).not.toMatch(/nomination|major-turn label/iu);
  });

  it("shares a pending thumbnail request across the StrictMode probe and aborts only final cleanup", async () => {
    const base = projectHistoryFilmstrip(page)[0]!;
    const item: HistoryFilmstripItem = { ...base, capturedThumbnail: { availability: "available", reference: "/api/save-points/save-1/media/screenshot", revision: 1, manifestDigest: `sha256:${"a".repeat(64)}` } };
    const signals: AbortSignal[] = [];
    const settled = vi.fn();
    const screenshot = vi.fn((_identity, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }).finally(settled));
    const client: EvidenceMediaClient = { screenshot, replay: vi.fn() };
    const view = render(<StrictMode><HistoryFilmstrip items={[item]} selectedId={item.savePointId} onSelect={vi.fn()} mediaClient={client} /></StrictMode>);

    await waitFor(() => expect(signals).toHaveLength(1));
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);
    view.unmount();
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  });
});
