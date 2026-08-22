// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryPage } from "@remo/domain/browser";
import { ReplayWorkspace } from "./ReplayWorkspace.js";
import type { HistoryClient } from "./history-client.js";

const { t3Restart } = vi.hoisted(() => ({ t3Restart: vi.fn() }));
vi.mock("../evidence-media/EvidenceMediaPanel.js", () => ({
  EvidenceMediaPanel: ({ identity }: { readonly identity: { readonly savePointId: string } }) => <section data-save-point-id={identity.savePointId}><span>Replay paused</span><button type="button" onClick={t3Restart}>Restart</button></section>,
}));

const detailSummary = (id: string, integrity = "Complete", fidelity = "Editable eligible") => ({
  savePointId: id,
  turnId: id.replace("save", "turn"),
  nominationReason: `Authoritative ${id}`,
  revision: 1,
  manifestDigest: `sha256:${"a".repeat(64)}`,
  components: [{ type: "screenshot", availability: "Available" }, { type: "rrweb", availability: "Available" }],
  integrity: { state: integrity },
  fidelity: { state: fidelity },
});

const history: HistoryPage = {
  anchors: [
    { savePointId: "save-1", turnId: "turn-1", sequenceNo: 1, lineageId: "lineage:original", promotedAt: "2026-08-18T00:01:00.000Z", majorTurnLabel: "Foundation", nominationReason: "First verified boundary", state: "active", provenance: "fixture-contract", integrity: "complete", fidelity: "editable-eligible" },
    { savePointId: "save-6", turnId: "turn-6", sequenceNo: 6, lineageId: "lineage:original", state: "tombstone", lifecycleReceiptId: "delete-6", provenance: "fixture-contract", integrity: "deleted", fidelity: "unavailable" },
    { savePointId: "save-10", turnId: "turn-10", sequenceNo: 10, lineageId: "lineage:original", promotedAt: "2026-08-18T00:10:00.000Z", majorTurnLabel: "Final verification", nominationReason: "Responsive acceptance", state: "active", provenance: "fixture-contract", integrity: "complete", fidelity: "editable-eligible" },
  ], limit: 10, truncated: false,
};

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); vi.restoreAllMocks(); t3Restart.mockReset(); });

describe("Replay workspace", () => {
  it("keeps stable URL identity, avoids tombstone detail fetch, and restores popstate selection", async () => {
    window.history.replaceState({}, "", "/replay/save-1");
    const client: HistoryClient = { list: vi.fn(async () => history) };
    const detail = vi.fn(async (id: string) => detailSummary(id));
    render(<ReplayWorkspace client={client} detail={detail} initialSavePointId="save-1" />);
    await screen.findByRole("heading", { name: "Foundation" });

    fireEvent.click(screen.getByRole("option", { name: /deleted evidence tombstone/u }));
    expect(window.location.pathname).toBe("/replay/save-6");
    expect(await screen.findByRole("heading", { name: "Turn 6 was deleted" })).toBeTruthy();
    expect(detail).toHaveBeenCalledTimes(1);

    window.history.pushState({}, "", "/replay/save-10");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "Final verification" })).toBeTruthy();
    expect(detail).toHaveBeenLastCalledWith("save-10", expect.any(AbortSignal));
  });

  it("selects the newest supportable turn from /replay and reports a finite local selection sample", async () => {
    window.history.replaceState({}, "", "/replay");
    const client: HistoryClient = { list: vi.fn(async () => history) };
    const samples: number[] = [];
    render(<ReplayWorkspace client={client} detail={vi.fn(async (id: string) => detailSummary(id))} onSelectionSample={(sample) => samples.push(sample)} />);
    expect(await screen.findByRole("heading", { name: "Final verification" })).toBeTruthy();
    expect(window.location.pathname).toBe("/replay/save-10");
    fireEvent.click(screen.getByRole("option", { name: /Turn 1, Foundation/u }));
    expect(await screen.findByRole("heading", { name: "Foundation" })).toBeTruthy();
    await waitFor(() => expect(samples.length).toBeGreaterThan(0));
    expect(samples).toEqual([expect.any(Number)]);
    expect(samples[0]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(samples[0])).toBe(true);
  });

  it("keys deferred detail rendering by savePointId and turnId during rapid A to B selection", async () => {
    window.history.replaceState({}, "", "/replay/save-1");
    const resolvers = new Map<string, (value: ReturnType<typeof detailSummary>) => void>();
    const detail = vi.fn((id: string) => new Promise<ReturnType<typeof detailSummary>>((resolve) => resolvers.set(id, resolve)));
    render(<ReplayWorkspace client={{ list: vi.fn(async () => history) }} detail={detail} initialSavePointId="save-1" />);
    await screen.findByRole("heading", { name: "Foundation" });
    fireEvent.click(screen.getByRole("option", { name: /Turn 10, Final verification/u }));
    expect(await screen.findByRole("heading", { name: "Final verification" })).toBeTruthy();
    resolvers.get("save-10")?.({ ...detailSummary("save-10"), nominationReason: "B-only nomination" });
    expect(await screen.findByText("B-only nomination")).toBeTruthy();
    resolvers.get("save-1")?.({ ...detailSummary("save-1"), nominationReason: "A-only nomination" });
    await Promise.resolve();
    expect(screen.queryByText("A-only nomination")).toBeNull();
    expect(screen.getByText("B-only nomination")).toBeTruthy();
  });

  it("keeps filmstrip and detail trust joined to one media-adjusted identity", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const joinedHistory: HistoryPage = {
      anchors: [{ ...history.anchors[0]!, integrity: "incomplete", fidelity: "degraded", capturedThumbnail: { availability: "available", reference: "/api/save-points/save-1/media/screenshot", revision: 1, manifestDigest: digest }, capturedReplay: { availability: "unavailable" } }],
      limit: 10,
      truncated: false,
    };
    window.history.replaceState({}, "", "/replay/save-1");
    render(<ReplayWorkspace client={{ list: vi.fn(async () => joinedHistory) }} detail={vi.fn(async () => detailSummary("save-1", "Incomplete", "Degraded"))} initialSavePointId="save-1" />);
    const option = await screen.findByRole("option", { name: /integrity incomplete, fidelity degraded/u });
    expect(option.textContent).toMatch(/Incomplete.*Degraded/u);
    expect(await screen.findByText("Authoritative save-1")).toBeTruthy();
    expect(screen.getByText("Integrity").parentElement?.textContent).toBe("IntegrityIncomplete");
    expect(screen.getByText("Fidelity").parentElement?.textContent).toBe("FidelityDegraded");
    expect(screen.queryByText(/Complete · Editable eligible/u)).toBeNull();
    expect(screen.getByText("Replay paused").parentElement?.getAttribute("data-save-point-id")).toBe("save-1");
    const selected = screen.getByRole("heading", { name: "Foundation" }).closest(".selected-turn");
    expect(selected?.getAttribute("data-detail-revision")).toBe("1");
    expect(selected?.getAttribute("data-detail-manifest-digest")).toBe(digest);
  });

  it("issues T3 restart and keeps previous and next inside the selected lineage", async () => {
    const alternateHistory: HistoryPage = {
      anchors: [history.anchors[0]!, { ...history.anchors[0]!, savePointId: "alt-2", turnId: "alt-turn-2", sequenceNo: 2, lineageId: "lineage:alternate", parentSavePointId: "save-1", majorTurnLabel: "Alternate two" }],
      limit: 10,
      truncated: false,
    };
    window.history.replaceState({}, "", "/replay/alt-2");
    const alternateDetail = { ...detailSummary("alt-2"), turnId: "alt-turn-2" };
    render(<ReplayWorkspace client={{ list: vi.fn(async () => alternateHistory) }} detail={vi.fn(async () => alternateDetail)} initialSavePointId="alt-2" />);
    await screen.findByText("Replay paused");
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(t3Restart).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Previous turn" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Next turn" }).hasAttribute("disabled")).toBe(true);
  });

  it("round-trips original and verified alternate root contexts with truthful URL, selection, transport, and focus", async () => {
    const lineageId = "lineage:alternate:operation-1";
    const lineageHistory: HistoryPage = {
      ...history,
      lineages: [
        { lineageId: "lineage:original", state: "original" },
        { lineageId, parentLineageId: "lineage:original", rootSavePointId: "save-1", branchOperationId: "operation-1", gitRef: "refs/heads/remo/operation-1", worktreeRelativePath: ".remo/worktrees/operation-1", state: "active-alternate" },
      ],
    };
    window.history.replaceState({}, "", "/replay/save-10");
    render(<ReplayWorkspace client={{ list: vi.fn(async () => lineageHistory) }} detail={vi.fn(async (id: string) => detailSummary(id))} initialSavePointId="save-10" />);
    expect(await screen.findByRole("heading", { name: "Final verification" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Alternate future" }));
    expect(await screen.findByRole("heading", { name: "Foundation" })).toBeTruthy();
    expect(window.location.pathname).toBe("/replay/save-1");
    expect(new URLSearchParams(window.location.search).get("lineage")).toBe(lineageId);
    expect(screen.getByText(/Alternate lineage root context/u)).toBeTruthy();
    expect(screen.getByText(/no alternate evidence was invented/u)).toBeTruthy();
    expect(screen.queryByText(/^Original lineage ·/u)).toBeNull();
    const alternateStatus = screen.getByText(/Viewing verified alternate lineage/u);
    await waitFor(() => expect(document.activeElement).toBe(alternateStatus));
    expect(screen.getByText(/Turn 1 of 1/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Original future" }));
    expect(await screen.findByRole("heading", { name: "Final verification" })).toBeTruthy();
    expect(window.location.pathname).toBe("/replay/save-10");
    expect(window.location.search).toBe("");
    expect(screen.getByText(/Original lineage · Turn 10/u)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText(/Viewing the preserved original lineage/u)));
  });

  it("mounts the visually separate branch preflight only for an active revision-bound detail", async () => {
    window.history.replaceState({}, "", "/replay/save-1");
    const branchPreflightClient = { preflight: vi.fn() };
    render(<ReplayWorkspace client={{ list: vi.fn(async () => history) }} detail={vi.fn(async () => detailSummary("save-1"))} initialSavePointId="save-1" branchPreflightClient={branchPreflightClient} />);
    expect(await screen.findByRole("heading", { name: "Branch from here" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Branch from here" })).toBeTruthy();
    expect(branchPreflightClient.preflight).not.toHaveBeenCalled();
  });
});
