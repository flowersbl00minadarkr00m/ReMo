// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { canonicalSerialize } from "@remo/domain";
import { projectHistoryFilmstrip } from "@remo/domain/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchPreflightPanel } from "../branch-preflight/BranchPreflightPanel.js";
import {
  createHostedDemoBranchOrchestrationClient,
  createHostedDemoBranchPreflightClient,
  originalFutureInventory,
} from "./hosted-demo-branch.js";
import { validateHostedDemoFixture } from "./hosted-demo-fixture.js";
import fixtureManifest from "../../../public/hosted-demo/fixture-manifest.json";
import fixtureSource from "../../../public/hosted-demo/fixture.json?raw";

const fixture = validateHostedDemoFixture(fixtureManifest, fixtureSource as string);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("hosted demo simulated branch adapters", () => {
  it("returns one fixed defensive preflight/result without fetch or storage", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const preflight = createHostedDemoBranchPreflightClient(fixture);
    const created = vi.fn();
    const orchestration = createHostedDemoBranchOrchestrationClient(fixture, { onCreated: created });
    const firstReceipt = await preflight.preflight("demo-save-04", 1, new AbortController().signal);
    const secondReceipt = await preflight.preflight("demo-save-04", 1, new AbortController().signal);
    expect(firstReceipt).toEqual(fixture.preflight);
    expect(secondReceipt).toEqual(firstReceipt);
    expect(secondReceipt).not.toBe(firstReceipt);
    expect(Object.isFrozen(firstReceipt)).toBe(true);
    expect(Object.isFrozen(firstReceipt.checks[0])).toBe(true);

    const first = await orchestration.confirm(firstReceipt, "Alternate from demo-save-04", `branch-${firstReceipt.target.operationId}`, new AbortController().signal);
    const repeated = await orchestration.confirm(secondReceipt, "Alternate from demo-save-04", `branch-${secondReceipt.target.operationId}`, new AbortController().signal);
    expect(first).toEqual(fixture.simulatedBranch);
    expect(repeated).toEqual(first);
    expect(await orchestration.list("demo-save-04", new AbortController().signal)).toEqual([first]);
    expect(created).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("fails stale identity/digest and every aborted operation closed", async () => {
    const preflight = createHostedDemoBranchPreflightClient(fixture);
    const orchestration = createHostedDemoBranchOrchestrationClient(fixture);
    const aborted = new AbortController();
    aborted.abort();
    await expect(preflight.preflight("demo-save-04", 1, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(orchestration.list("demo-save-04", aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(orchestration.confirm(fixture.preflight, "Alternate from demo-save-04", `branch-${fixture.preflight.target.operationId}`, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(preflight.preflight("demo-save-05", 1, new AbortController().signal)).rejects.toThrow(/fixed Turn 4/u);
    await expect(orchestration.confirm({ ...fixture.preflight, digest: `sha256:${"0".repeat(64)}` }, "Alternate from demo-save-04", `branch-${fixture.preflight.target.operationId}`, new AbortController().signal)).rejects.toThrow(/stale or unsupported/u);
    expect(await orchestration.list("demo-save-04", new AbortController().signal)).toEqual([]);
  });

  it("uses explicit simulated authority before confirmation and in the focused result", async () => {
    const orchestration = createHostedDemoBranchOrchestrationClient(fixture);
    render(<BranchPreflightPanel
      savePointId="demo-save-04"
      savePointRevision={1}
      client={createHostedDemoBranchPreflightClient(fixture)}
      orchestrationClient={orchestration}
      operationMode="simulated-demo"
    />);
    expect(screen.getByText("Simulated. No real repository is connected or changed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run simulated preflight" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm simulated branch" }));
    const result = await screen.findByRole("status", { name: "Simulated alternate lineage ready" });
    expect(result.textContent).toContain("Simulated");
    expect(result.textContent).toContain("No real repository is connected or changed.");
    await waitFor(() => expect(document.activeElement).toBe(result));
  });

  it("does not mutate the validated fixture bytes or original-future inventory", async () => {
    const before = canonicalSerialize(fixture);
    const original = originalFutureInventory(projectHistoryFilmstrip(fixture.history));
    const inventory = original.map(({ savePointId }) => savePointId);
    const orchestration = createHostedDemoBranchOrchestrationClient(fixture);
    await orchestration.confirm(fixture.preflight, "Alternate from demo-save-04", `branch-${fixture.preflight.target.operationId}`, new AbortController().signal);
    expect(canonicalSerialize(fixture)).toBe(before);
    expect(original.map(({ savePointId }) => savePointId)).toEqual(inventory);
    expect(inventory).toEqual(["demo-save-05", "demo-save-06", "demo-save-07", "demo-save-08", "demo-save-09", "demo-save-10"]);
  });
});
