// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { canonicalSerialize, sha256Canonical } from "@remo/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedDemoApp } from "./HostedDemoApp.js";
import { validateHostedDemoFixture } from "./hosted-demo-fixture.js";

const fixtureRevision = "rel001-fixture-2026-08-20";

function fixtureSource() {
  const anchors = Array.from({ length: 10 }, (_, index) => {
    const sequenceNo = index + 1;
    const savePointId = `demo-save-${String(sequenceNo).padStart(2, "0")}`;
    if (sequenceNo === 6) {
      return {
        savePointId,
        turnId: "demo-turn-06",
        sequenceNo,
        lineageId: "lineage:original",
        state: "tombstone",
        lifecycleReceiptId: "demo-delete-receipt-06",
        provenance: "fixture-contract",
        integrity: "deleted",
        fidelity: "unavailable",
      } as const;
    }
    return {
      savePointId,
      turnId: `demo-turn-${String(sequenceNo).padStart(2, "0")}`,
      sequenceNo,
      lineageId: "lineage:original",
      promotedAt: `2026-08-20T12:${String(sequenceNo).padStart(2, "0")}:00.000Z`,
      majorTurnLabel: `Synthetic major turn ${sequenceNo}`,
      nominationReason: `Deterministic fixture reason ${sequenceNo}`,
      capturedThumbnail: { availability: "unavailable" },
      capturedReplay: { availability: "unavailable" },
      state: "active",
      provenance: "fixture-contract",
      integrity: "incomplete",
      fidelity: "degraded",
    } as const;
  });
  const detailsBySavePointId = Object.fromEntries(anchors.filter(({ state }) => state === "active").map((anchor) => [anchor.savePointId, {
    savePointId: anchor.savePointId,
    turnId: anchor.turnId,
    nominationReason: anchor.nominationReason,
    revision: 1,
    manifestDigest: `sha256:${"a".repeat(64)}`,
    components: [],
    integrity: { state: "Incomplete" },
    fidelity: { state: "Degraded" },
  }]));
  const fixture = {
    schemaVersion: "remo.hosted-demo-fixture.v1",
    fixtureRevision,
    history: { anchors, lineages: [{ lineageId: "lineage:original", state: "original" }], limit: 10, truncated: false },
    detailsBySavePointId,
  };
  const serialized = canonicalSerialize(fixture);
  const manifest = {
    schemaVersion: "remo.hosted-demo-manifest.v1",
    fixtureRevision,
    entries: [{
      id: "fixture",
      path: "/hosted-demo/fixture.json",
      mediaType: "application/json",
      byteLength: new TextEncoder().encode(serialized).byteLength,
      digest: sha256Canonical(fixture),
    }],
  };
  return validateHostedDemoFixture(manifest, serialized);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("hosted demo composition", () => {
  it("renders the explicit boundary, exact notice, and ten anchors at a non-loopback origin without prohibited requests", async () => {
    window.history.replaceState({}, "", "/save-points");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);

    expect(await screen.findByText("Synthetic hosted demonstration")).toBeTruthy();
    expect(screen.getByText("No real repository is connected.")).toBeTruthy();
    expect(screen.getByText("Local installation package is on the planned roadmap. Coming to GitHub soon.")).toBeTruthy();
    expect(await screen.findAllByRole("option")).toHaveLength(10);
    expect(screen.queryByRole("link", { name: /download|github|install/u })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renders the same explicit entry at root and saved-results routes", async () => {
    for (const path of ["/", "/save-points"]) {
      window.history.replaceState({}, "", path);
      const view = render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
      expect(await screen.findByText("Synthetic hosted demonstration")).toBeTruthy();
      expect(await screen.findAllByRole("option")).toHaveLength(10);
      view.unmount();
    }
  });

  it("keeps malformed routes request-free and provides bounded recovery", () => {
    window.history.replaceState({}, "", "/outside-demo");
    const loadFixture = vi.fn(() => Promise.resolve(fixtureSource()));
    render(<HostedDemoApp loadFixture={loadFixture} />);
    expect(screen.getByRole("heading", { name: "Demonstration route unavailable" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the synthetic history" }).getAttribute("href")).toBe("/save-points");
    expect(loadFixture).not.toHaveBeenCalled();
  });

  it("fails fixture readiness closed to an accessible bounded unavailable state", async () => {
    window.history.replaceState({}, "", "/save-points");
    render(<HostedDemoApp loadFixture={() => Promise.reject(new TypeError("bad fixture"))} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/failed schema, identity, digest, URL, credential, or path validation/u);
    expect(screen.getByRole("button", { name: "Retry fixture validation" })).toBeTruthy();
    expect(screen.getByText("No real repository is connected.")).toBeTruthy();
  });

  it("keeps the tombstone detail-free and supports keyboard filmstrip navigation", async () => {
    window.history.replaceState({}, "", "/replay/demo-save-04");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    const turnFour = await screen.findByRole("option", { name: /Turn 4,/u });
    turnFour.focus();
    fireEvent.keyDown(turnFour, { key: "ArrowRight" });
    const turnFive = await screen.findByRole("option", { name: /Turn 5,/u });
    expect(turnFive.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(turnFive));
    const requestsBeforeTombstone = fetcher.mock.calls.length;
    fireEvent.click(await screen.findByRole("option", { name: /deleted evidence tombstone/u }));
    expect(await screen.findByRole("heading", { name: "Turn 6 was deleted" })).toBeTruthy();
    expect(screen.getByText(/No protected evidence or detail was loaded/u)).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(requestsBeforeTombstone);
  });

  it("recovers an unknown well-shaped fixture identity without substituting evidence", async () => {
    window.history.replaceState({}, "", "/replay/demo-save-99");
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    expect(await screen.findByRole("heading", { name: "Fixture identity unavailable" })).toBeTruthy();
    expect(screen.getByText(/No alternate evidence was requested or invented/u)).toBeTruthy();
  });

  it("derives present-tense integrity copy from the selected anchor's validated media availability", async () => {
    window.history.replaceState({}, "", "/replay/demo-save-05");
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);

    expect(await screen.findByRole("heading", { name: "Synthetic major turn 5" })).toBeTruthy();
    expect(screen.getByText("Manifest-bound synthetic screenshot available for qualified comparison.")).toBeTruthy();
    expect(screen.queryByText("Incomplete until its REL-001 slice is added.")).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: /Turn 2,/u }));
    expect(await screen.findByRole("heading", { name: "Synthetic major turn 2" })).toBeTruthy();
    expect(screen.getByText("No manifest-bound media is available for this synthetic anchor.")).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: /Turn 8,/u }));
    expect(await screen.findByRole("heading", { name: "Synthetic major turn 8" })).toBeTruthy();
    expect(screen.getByText("No manifest-bound media is available for this synthetic anchor.")).toBeTruthy();
    expect(screen.queryByText(/Incomplete until|slice is added/u)).toBeNull();
  });

  it("joins the Turn 4 replay context to contemporaneous decision evidence and the exact comparison pair", async () => {
    window.history.replaceState({}, "", "/replay/demo-save-04");
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    const readyOwner = await screen.findByText("UI supervisor");
    expect(readyOwner.closest(".decision-card")?.textContent).toContain("Should the navigation hierarchy change at this boundary?");
    expect(screen.getByText("low · source human")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Compare Turn 4 with Turn 5" }).getAttribute("href")).toBe("/compare?left=demo-save-04&right=demo-save-05");
  });

  it("loads the exact hosted pair on direct comparison entry without inferring another side", async () => {
    window.history.replaceState({}, "", "/compare");
    const comparison = render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    expect(await screen.findByRole("heading", { name: "Before and after, without an automated verdict" })).toBeTruthy();
    expect(await screen.findByText(/Before Turn 4.*demo-save-04/u)).toBeTruthy();
    expect(screen.getByText(/After Turn 5.*demo-save-05/u)).toBeTruthy();
    const replayLink = screen.getByRole("link", { name: "Open this source turn and bounded replay" });
    expect(replayLink.getAttribute("href")).toBe("/replay/demo-save-04?compareLeft=demo-save-04&compareRight=demo-save-05");
    const sourceLink = screen.getByRole("link", { name: "Open this source turn" });
    expect(sourceLink.getAttribute("href")).toBe("/replay/demo-save-05?compareLeft=demo-save-04&compareRight=demo-save-05");

    comparison.unmount();
    window.history.replaceState({}, "", replayLink.getAttribute("href"));
    const turnFour = render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    expect(await screen.findByRole("heading", { name: "Synthetic major turn 4" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Actual captured UI and bounded replay" })).toBeTruthy();
    expect(screen.getByText(/Returned from the exact Turn 4 before \/ Turn 5 after comparison/u)).toBeTruthy();

    turnFour.unmount();
    window.history.replaceState({}, "", sourceLink.getAttribute("href"));
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    expect(await screen.findByRole("heading", { name: "Synthetic major turn 5" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Actual captured UI and bounded replay" })).toBeNull();
    expect(screen.getByText(/Returned from the exact Turn 4 before \/ Turn 5 after comparison/u)).toBeTruthy();
  });

  it("does not create or elevate branch state when Original future is selected before confirmation", async () => {
    window.history.replaceState({}, "", "/replay/demo-save-04");
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);

    expect(await screen.findByText("Simulated. No real repository is connected or changed.")).toBeTruthy();
    const originalFuture = screen.getByRole("button", { name: "Original future" });
    const alternateFuture = screen.getByRole("button", { name: "Alternate future" });
    expect(originalFuture.getAttribute("aria-pressed")).toBe("true");
    expect(alternateFuture.hasAttribute("disabled")).toBe(true);

    fireEvent.click(originalFuture);

    expect(window.location.search).toBe("");
    expect(originalFuture.getAttribute("aria-pressed")).toBe("true");
    expect(alternateFuture.hasAttribute("disabled")).toBe(true);
  });

  it("joins Turn 4 to one simulated result and both explicitly qualified futures", async () => {
    window.history.replaceState({}, "", "/replay/demo-save-04");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    expect(await screen.findByText("Simulated. No real repository is connected or changed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run simulated preflight" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm simulated branch" }));
    expect(await screen.findByRole("status", { name: "Simulated alternate lineage ready" })).toBeTruthy();
    expect(window.location.search).toBe("?demoBranch=simulated-created&lineage=lineage%3Asimulated-alternate");
    expect(screen.getByRole("button", { name: "Alternate future" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("One fixed simulated alternate lineage")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Original future" }));
    expect(screen.getByText("Unchanged original fixture future")).toBeTruthy();
    expect(screen.getAllByTestId("original-future-item")).toHaveLength(6);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["/hosted-demo/turn-4-screenshot.png", "/hosted-demo/turn-4-rrweb.json"]);
    expect(fetcher.mock.calls.some(([url]) => /(?:\/api\/|localhost|127\.0\.0\.1|https?:\/\/)/u.test(String(url)))).toBe(false);
  });

  it("recovers malformed simulated state in-app without creating a lineage", async () => {
    window.history.replaceState({}, "", "/replay/demo-save-04?demoBranch=simulated-created&lineage=lineage%3Aunsupported");
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    const recovery = await screen.findByRole("status", { name: "Simulated branch state recovered" });
    expect(recovery.textContent).toMatch(/unchanged original future/u);
    await waitFor(() => expect(window.location.search).toBe(""));
    await waitFor(() => expect(document.activeElement).toBe(recovery));
    expect(screen.getByRole("button", { name: "Alternate future" }).hasAttribute("disabled")).toBe(true);
  });

  it("reconstructs the one created lineage on direct entry and follows back-forward URL state", async () => {
    const created = "/replay/demo-save-04?demoBranch=simulated-created&lineage=lineage%3Asimulated-alternate";
    window.history.replaceState({}, "", created);
    render(<HostedDemoApp loadFixture={() => Promise.resolve(fixtureSource())} />);
    expect(await screen.findByRole("status", { name: "Simulated alternate lineage ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alternate future" }).getAttribute("aria-pressed")).toBe("true");

    window.history.replaceState({}, "", "/replay/demo-save-04");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Alternate future" }).hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Unchanged original fixture future")).toBeTruthy();

    window.history.replaceState({}, "", created);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Alternate future" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("One fixed simulated alternate lineage")).toBeTruthy();
  });
});
