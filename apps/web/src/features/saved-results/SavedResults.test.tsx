// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:4174/save-points" }
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedResults } from "./SavedResults.js";
import type { SavedResultSummary, SavedResultsClient } from "./saved-results-client.js";

const result = (turn: number): SavedResultSummary => ({ savePointId: `01J00000000000000000000S${String(turn).padStart(2, "0")}`, displayId: `SP-${String(turn).padStart(3, "0")}`, turnId: `01J00000000000000000000T${String(turn).padStart(2, "0")}`, turnNumber: turn, stablePath: `/save-points/01J00000000000000000000S${String(turn).padStart(2, "0")}`, savedAt: `2026-08-16T${String(8 + turn).padStart(2, "0")}:00:00.000Z`, integrity: "Complete", fidelity: "Editable eligible", pinned: turn === 1, expiresAt: "2026-09-15T10:00:00.000Z" });
const client = (value: readonly SavedResultSummary[]): SavedResultsClient => ({ list: vi.fn().mockResolvedValue(value) });

afterEach(cleanup);

describe("neutral saved-results collection", () => {
  it("renders stable individual URLs and keyboard-operable neutral sorting", async () => {
    render(<SavedResults client={client([result(10), result(1)])} />);
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(document.querySelector(".result-count")?.textContent).toBe("2saved results");
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByRole("rowheader", { name: /SP-001/u })).toBeTruthy();
    await userEvent.setup().selectOptions(screen.getByLabelText("Sort by"), "turn");
    await userEvent.setup().click(screen.getByRole("button", { name: "Sort descending" }));
    expect(within(screen.getAllByRole("row")[1]!).getByRole("rowheader", { name: /SP-010/u })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open SP-010" }).getAttribute("href")).toBe(result(10).stablePath);
  });

  it("states loading, empty, and error honestly without synthetic evidence", async () => {
    let resolveList: ((value: readonly SavedResultSummary[]) => void) | undefined;
    const pending: SavedResultsClient = { list: () => new Promise((resolve) => { resolveList = resolve; }) };
    const view = render(<SavedResults client={pending} />);
    expect(screen.getByRole("status").textContent).toContain("Loading saved results");
    resolveList?.([]);
    expect(await screen.findByText("No saved results yet")).toBeTruthy();
    view.unmount();
    render(<SavedResults client={{ list: vi.fn().mockRejectedValue(new Error("offline")) }} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Saved results unavailable"));
    expect(screen.getByRole("button", { name: "Reload saved results" })).toBeTruthy();
  });
});
