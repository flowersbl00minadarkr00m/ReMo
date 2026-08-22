// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1/compare" }
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComparisonProjection, type ComparisonSideInput, type HistoryPage } from "@remo/domain/browser";
import type { EvidenceMediaClient, ScreenshotEvidence } from "../evidence-media/evidence-media-client.js";
import type { ComparisonClient } from "./comparison-client.js";
import { ComparisonWorkspace } from "./ComparisonWorkspace.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const side = (savePointId: string, overrides: Partial<ComparisonSideInput> = {}): ComparisonSideInput => ({
  savePointId,
  turnId: `${savePointId}-turn`,
  displayId: savePointId === "save-before" ? "SP-001" : "SP-002",
  state: "available",
  revision: 1,
  manifestDigest: digest("a"),
  screenshot: { availability: "available", reference: `/api/save-points/${savePointId}/media/screenshot`, componentId: `${savePointId}-turn:screenshot`, digest: digest("c"), width: 1440, height: 900 },
  source: { state: "available", summary: "Allowed fixture source change", authorityMode: "fixture" },
  decision: { state: "available", question: "Which layout?", selectedOption: "Compact", provenance: "user-supplied", revision: 1 },
  verification: { state: "available", summary: "Responsive checks passed", provenance: "observed" },
  integrity: { state: "complete", explanation: "Complete joined evidence" },
  fidelity: { state: "editable-eligible", explanation: "Eligible under the fixture contract" },
  context: { route: "/fixture/save-point", viewport: { width: 1440, height: 900 }, fixture: "vs002-replay-fixture-v1", dependencyDigest: digest("b"), policyRevisions: { capture: "capture-v2", privacy: "privacy-v1", integrity: "integrity-v1", fidelity: "fidelity-v2" }, lineageId: "lineage:original", provenance: "fixture-contract" },
  replayPath: `/replay/${savePointId}`,
  ...overrides,
});

const history: HistoryPage = {
  schemaVersion: "remo.history-page.v1",
  anchors: [
    { savePointId: "save-before", turnId: "save-before-turn", sequenceNo: 1, lineageId: "lineage:original", state: "active", majorTurnLabel: "Before", nominationReason: "Fixture boundary", integrity: "complete", fidelity: "editable-eligible", capturedThumbnail: { availability: "available", reference: "/before" }, capturedReplay: { availability: "unavailable" } },
    { savePointId: "save-after", turnId: "save-after-turn", sequenceNo: 2, lineageId: "lineage:original", state: "active", majorTurnLabel: "After", nominationReason: "Fixture boundary", integrity: "complete", fidelity: "editable-eligible", capturedThumbnail: { availability: "available", reference: "/after" }, capturedReplay: { availability: "unavailable" } },
    { savePointId: "save-alternate", turnId: "save-alternate-turn", sequenceNo: 2, lineageId: "lineage:alternate", parentSavePointId: "save-before", state: "active", majorTurnLabel: "Alternate", nominationReason: "Fixture boundary", integrity: "complete", fidelity: "editable-eligible", capturedThumbnail: { availability: "available", reference: "/alternate" }, capturedReplay: { availability: "unavailable" } },
  ],
};

async function loadedComparisonSelects(): Promise<HTMLElement[]> {
  const selects = await screen.findAllByRole("combobox");
  await waitFor(() => { expect(selects.every((select) => select.querySelectorAll("option").length === history.anchors.length + 1)).toBe(true); });
  return selects;
}

const screenshot = (componentId: string): ScreenshotEvidence => ({ blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }), digest: digest("c"), componentId, width: 1440, height: 900 });

beforeEach(() => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn((blob: Blob) => `blob:${blob.size}`), revokeObjectURL: vi.fn() });
});
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/compare"); vi.unstubAllGlobals(); });

describe("qualified comparison workspace", () => {
  it("renders two authenticated screenshots, explicit roles, governing evidence, and a non-verdict qualification", async () => {
    const compare = vi.fn(() => Promise.resolve(buildComparisonProjection(side("save-before"), side("save-after"))));
    const client: ComparisonClient = { history: vi.fn(() => Promise.resolve(history)), compare };
    const mediaClient: EvidenceMediaClient = { screenshot: vi.fn((identity) => Promise.resolve(screenshot(`${identity.turnId}:screenshot`))), replay: vi.fn(() => Promise.reject(new Error("comparison is screenshot-only"))) };
    render(<ComparisonWorkspace client={client} mediaClient={mediaClient} presentationMode="hosted-demo" />);
    const user = userEvent.setup();
    const selects = await loadedComparisonSelects();
    await user.selectOptions(selects[0]!, "save-before");
    await user.selectOptions(selects[1]!, "save-after");
    await user.click(screen.getByRole("button", { name: "Compare selected turns" }));
    expect(await screen.findByRole("heading", { name: "Comparison qualification" })).toBeTruthy();
    expect(screen.getByText(/Context matched.*no equivalence verdict/u)).toBeTruthy();
    expect(screen.getAllByText("Before · left")).toHaveLength(2);
    expect(screen.getAllByText("After · right")).toHaveLength(2);
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(screen.getAllByText("Source change")).toHaveLength(2);
    expect(screen.getAllByText("Decision")).toHaveLength(2);
    expect(screen.getAllByText("Verification")).toHaveLength(2);
    expect(screen.queryByText(/^Winner$/u)).toBeNull();
    expect(screen.queryByText(/^Score$/u)).toBeNull();
    expect(screen.queryByText(/^Verdict$/u)).toBeNull();
    expect(document.querySelector(".comparison-pair-identity")?.textContent).toMatch(/Selected pair:.*lineage:original/u);
    const replayLink = screen.getByRole("link", { name: "Open this source turn and bounded replay" });
    expect(replayLink.getAttribute("href")).toBe("/replay/save-before?compareLeft=save-before&compareRight=save-after");
    const sourceLink = screen.getByRole("link", { name: "Open this source turn" });
    expect(sourceLink.getAttribute("href")).toBe("/replay/save-after?compareLeft=save-before&compareRight=save-after");
    for (const region of screen.getAllByRole("article")) expect(region.getAttribute("tabindex")).toBe("0");
  });

  it("rejects same identity before requesting comparison", async () => {
    const compare = vi.fn<ComparisonClient["compare"]>();
    render(<ComparisonWorkspace client={{ history: vi.fn(() => Promise.resolve(history)), compare }} />);
    const selects = await loadedComparisonSelects();
    await userEvent.setup().selectOptions(selects[0]!, "save-before");
    await userEvent.setup().selectOptions(selects[1]!, "save-before");
    await userEvent.setup().click(screen.getByRole("button", { name: "Compare selected turns" }));
    expect(screen.getByRole("alert").textContent).toMatch(/distinct save points/u);
    expect(compare).not.toHaveBeenCalled();
  });

  it("announces mismatch in text and never fetches protected media for a deleted side", async () => {
    const deleted = side("save-after", { state: "deleted", screenshot: { availability: "unavailable" }, context: undefined, source: { state: "unavailable", summary: "Deleted" }, decision: { state: "unavailable" }, verification: { state: "unavailable", summary: "Deleted" }, integrity: { state: "unavailable", explanation: "Tombstone only" }, fidelity: { state: "unavailable", explanation: "Unavailable" } });
    const projection = buildComparisonProjection(side("save-before"), deleted);
    const mediaClient: EvidenceMediaClient = { screenshot: vi.fn((identity) => Promise.resolve(screenshot(`${identity.turnId}:screenshot`))), replay: vi.fn(() => Promise.reject(new Error("unused"))) };
    render(<ComparisonWorkspace client={{ history: vi.fn(() => Promise.resolve(history)), compare: vi.fn(() => Promise.resolve(projection)) }} mediaClient={mediaClient} />);
    const selects = await loadedComparisonSelects();
    await userEvent.setup().selectOptions(selects[0]!, "save-before");
    await userEvent.setup().selectOptions(selects[1]!, "save-after");
    await userEvent.setup().click(screen.getByRole("button", { name: "Compare selected turns" }));
    const qualification = await screen.findByRole("region", { name: "Comparison qualification" });
    expect(within(qualification).getByText("Mismatch blocks equivalence")).toBeTruthy();
    expect(within(qualification).getAllByText(/Mismatch · evidence/u).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Deleted side.*protected media is not fetched/u)).toBeTruthy();
    expect(mediaClient.screenshot).toHaveBeenCalledTimes(1);
  });
  it("identifies a same-turn original and alternate pair by lineage in selectors, presentation, and return links", async () => {
    const alternate = side("save-alternate", { displayId: "SP-002A", context: { ...side("save-after").context!, lineageId: "lineage:alternate" } });
    const projection = buildComparisonProjection(side("save-after"), alternate);
    render(<ComparisonWorkspace client={{ history: vi.fn(() => Promise.resolve(history)), compare: vi.fn(() => Promise.resolve(projection)) }} mediaClient={{ screenshot: vi.fn((identity) => Promise.resolve(screenshot(`${identity.turnId}:screenshot`))), replay: vi.fn(() => Promise.reject(new Error("unused"))) }} />);
    const selects = await loadedComparisonSelects();
    expect(within(selects[0]!).getByRole("option", { name: /Turn 2 · lineage:original/u })).toBeTruthy();
    expect(within(selects[1]!).getByRole("option", { name: /Turn 2 · lineage:alternate/u })).toBeTruthy();
    await userEvent.setup().selectOptions(selects[0]!, "save-after");
    await userEvent.setup().selectOptions(selects[1]!, "save-alternate");
    await userEvent.setup().click(screen.getByRole("button", { name: "Compare selected turns" }));
    expect(await screen.findByText(/Before SP-002 · lineage lineage:original.*After SP-002A · lineage lineage:alternate/u)).toBeTruthy();
    expect(screen.getAllByText(/Lineage lineage:/u)).toHaveLength(2);
  });
  it("fails the displayed screenshot closed when authenticated media metadata differs from its projection", async () => {
    render(<ComparisonWorkspace client={{ history: vi.fn(() => Promise.resolve(history)), compare: vi.fn(() => Promise.resolve(buildComparisonProjection(side("save-before"), side("save-after")))) }} mediaClient={{ screenshot: vi.fn((identity) => Promise.resolve({ ...screenshot(`${identity.turnId}:screenshot`), digest: digest("d") })), replay: vi.fn(() => Promise.reject(new Error("unused"))) }} />);
    const selects = await loadedComparisonSelects();
    await userEvent.setup().selectOptions(selects[0]!, "save-before");
    await userEvent.setup().selectOptions(selects[1]!, "save-after");
    await userEvent.setup().click(screen.getByRole("button", { name: "Compare selected turns" }));
    expect(await screen.findAllByText("Screenshot failed its authenticated projection binding checks.")).toHaveLength(2);
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("explicitly cancels superseded comparison and pending unmounted history/media requests", async () => {
    let historySignal: AbortSignal | undefined;
    const pendingHistory = new Promise<HistoryPage>(() => undefined);
    const historyMount = render(<ComparisonWorkspace client={{ history: vi.fn((signal) => { historySignal = signal; return pendingHistory; }), compare: vi.fn() }} />);
    await Promise.resolve();
    historyMount.unmount();
    expect(historySignal?.aborted).toBe(true);

    const compareSignals: AbortSignal[] = [];
    const compareResolvers: Array<(value: ReturnType<typeof buildComparisonProjection>) => void> = [];
    const mediaSignals: AbortSignal[] = [];
    const compare = vi.fn((_left: string, _right: string, signal: AbortSignal) => new Promise<ReturnType<typeof buildComparisonProjection>>((resolve) => { compareSignals.push(signal); compareResolvers.push(resolve); }));
    const mediaClient: EvidenceMediaClient = { screenshot: vi.fn((_identity, signal) => { mediaSignals.push(signal); return new Promise<ScreenshotEvidence>(() => undefined); }), replay: vi.fn(() => Promise.reject(new Error("unused"))) };
    const active = render(<ComparisonWorkspace client={{ history: vi.fn(() => Promise.resolve(history)), compare }} mediaClient={mediaClient} />);
    const selects = await loadedComparisonSelects();
    await userEvent.setup().selectOptions(selects[0]!, "save-before");
    await userEvent.setup().selectOptions(selects[1]!, "save-after");
    await userEvent.setup().click(screen.getByRole("button", { name: "Compare selected turns" }));
    await userEvent.setup().selectOptions(selects[1]!, "save-alternate");
    await userEvent.setup().click(screen.getByRole("button", { name: "Compare selected turns" }));
    expect(compareSignals[0]?.aborted).toBe(true);
    compareResolvers[1]?.(buildComparisonProjection(side("save-before"), side("save-alternate", { context: { ...side("save-alternate").context!, lineageId: "lineage:alternate" } })));
    expect(await screen.findByRole("heading", { name: "Comparison qualification" })).toBeTruthy();
    await waitFor(() => expect(mediaSignals).toHaveLength(2));
    active.unmount();
    expect(mediaSignals.every(({ aborted }) => aborted)).toBe(true);
    expect(compareSignals[1]?.aborted).toBe(false);
  });

  it("does not abort history, comparison, or media requests after they have settled", async () => {
    let historySignal: AbortSignal | undefined;
    let compareSignal: AbortSignal | undefined;
    const mediaSignals: AbortSignal[] = [];
    const active = render(<ComparisonWorkspace
      client={{
        history: vi.fn((signal) => { historySignal = signal; return Promise.resolve(history); }),
        compare: vi.fn((_left, _right, signal) => { compareSignal = signal; return Promise.resolve(buildComparisonProjection(side("save-before"), side("save-after"))); }),
      }}
      mediaClient={{
        screenshot: vi.fn((identity, signal) => { mediaSignals.push(signal); return Promise.resolve(screenshot(`${identity.turnId}:screenshot`)); }),
        replay: vi.fn(() => Promise.reject(new Error("unused"))),
      }}
    />);
    const selects = await loadedComparisonSelects();
    const user = userEvent.setup();
    await user.selectOptions(selects[0]!, "save-before");
    await user.selectOptions(selects[1]!, "save-after");
    await user.click(screen.getByRole("button", { name: "Compare selected turns" }));
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    await waitFor(() => expect(mediaSignals).toHaveLength(2));
    active.unmount();
    expect(historySignal?.aborted).toBe(false);
    expect(compareSignal?.aborted).toBe(false);
    expect(mediaSignals.every(({ aborted }) => !aborted)).toBe(true);
  });

  it("reports request settlement only after repeated history, comparison, and media lifecycles finish", async () => {
    window.history.replaceState({}, "", "/compare?left=save-before&right=save-after");
    for (let iteration = 0; iteration < 5; iteration += 1) {
      let resolveHistory: ((value: HistoryPage) => void) | undefined;
      let resolveComparison: ((value: ReturnType<typeof buildComparisonProjection>) => void) | undefined;
      const mediaResolvers: Array<(value: ScreenshotEvidence) => void> = [];
      const historySignals: AbortSignal[] = [];
      const comparisonSignals: AbortSignal[] = [];
      const mediaSignals: AbortSignal[] = [];
      const active = render(<ComparisonWorkspace
        client={{
          history: vi.fn((signal) => {
            historySignals.push(signal);
            return new Promise<HistoryPage>((resolve) => { resolveHistory = resolve; });
          }),
          compare: vi.fn((_left, _right, signal) => {
            comparisonSignals.push(signal);
            return new Promise<ReturnType<typeof buildComparisonProjection>>((resolve) => { resolveComparison = resolve; });
          }),
        }}
        mediaClient={{
          screenshot: vi.fn((identity, signal) => {
            mediaSignals.push(signal);
            return new Promise<ScreenshotEvidence>((resolve) => { mediaResolvers.push((value) => resolve({ ...value, componentId: `${identity.turnId}:screenshot` })); });
          }),
          replay: vi.fn(() => Promise.reject(new Error("unused"))),
        }}
      />);
      const workspace = screen.getByRole("region", { name: "Before and after, without an automated verdict" });
      await waitFor(() => {
        expect(resolveHistory).toBeTypeOf("function");
        expect(resolveComparison).toBeTypeOf("function");
      });
      expect(workspace.getAttribute("aria-busy")).toBe("true");

      resolveComparison?.(buildComparisonProjection(side("save-before"), side("save-after")));
      await waitFor(() => expect(mediaResolvers).toHaveLength(2));
      expect(screen.getByRole("heading", { name: "Comparison qualification" })).toBeTruthy();
      resolveHistory?.(history);
      for (const resolveMedia of mediaResolvers) resolveMedia(screenshot("placeholder"));
      await waitFor(() => expect(workspace.getAttribute("aria-busy")).toBe("false"));
      expect(await screen.findAllByRole("img")).toHaveLength(2);

      active.unmount();
      expect(historySignals.every(({ aborted }) => !aborted)).toBe(true);
      expect(comparisonSignals.every(({ aborted }) => !aborted)).toBe(true);
      expect(mediaSignals.every(({ aborted }) => !aborted)).toBe(true);
    }
  });

  it("uses an injected default pair only when the URL does not already name a pair", async () => {
    window.history.replaceState({}, "", "/compare");
    const compare = vi.fn(() => Promise.resolve(buildComparisonProjection(side("save-before"), side("save-after"))));
    render(<ComparisonWorkspace
      client={{ history: vi.fn(() => Promise.resolve(history)), compare }}
      defaultPair={{ left: "save-before", right: "save-after" }}
    />);
    expect(await screen.findByRole("heading", { name: "Comparison qualification" })).toBeTruthy();
    expect(compare).toHaveBeenCalledWith("save-before", "save-after", expect.any(AbortSignal));
  });

  it("does not complete a partial URL pair from the injected default", async () => {
    window.history.replaceState({}, "", "/compare?left=save-before");
    const compare = vi.fn(() => Promise.resolve(buildComparisonProjection(side("save-before"), side("save-after"))));
    render(<ComparisonWorkspace
      client={{ history: vi.fn(() => Promise.resolve(history)), compare }}
      defaultPair={{ left: "save-before", right: "save-after" }}
    />);
    expect((await screen.findByRole("status")).textContent).toContain("Select an explicit distinct pair to begin.");
    expect(compare).not.toHaveBeenCalled();
  });
});
