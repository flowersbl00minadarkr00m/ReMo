// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateBranchPreflight, deriveBranchPreflightIdentity, type BranchPreflightInput } from "@remo/domain/browser";
import { BranchPreflightPanel } from "./BranchPreflightPanel.js";

const ID = "01J000000000000000000000S5";
const OTHER_ID = "01J000000000000000000000S6";
const DIGEST = `sha256:${"b".repeat(64)}`;
const AVAILABLE_CAPTURE = { state: "available" as const };
function readyReceipt(now = new Date(), savePointId = ID, revision = 1) {
  const target = deriveBranchPreflightIdentity(savePointId, revision);
  const input: BranchPreflightInput = { savePointId, requestedSavePointId: savePointId, savePointRevision: revision, requestedSavePointRevision: revision, lifecycleState: "active", integrityState: "complete", fidelityState: "editable-eligible", privacyPassed: true, evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: DIGEST, evidenceDigest: DIGEST })), sourceCommit: "a".repeat(40), sourceCommitExists: true, repository: { gitAvailable: true, canonicalRootSafe: true, approvedSourceRootSafe: true, commonDirectorySafe: true, derivedWorktreeRootSafe: true, ownershipSafe: true, linksAbsent: true }, reproducibility: { route: "/fixture/save-point", expectedRoute: "/fixture/save-point", fixture: "fixture", expectedFixture: "fixture", viewport: "1440x900", expectedViewport: "1440x900", dependencyDigest: DIGEST, expectedDependencyDigest: DIGEST, policyDigest: DIGEST, expectedPolicyDigest: DIGEST }, target: { ...target, refAbsent: true, pathAbsent: true }, operationActive: false, checkoutSafety: { filtersActive: false, hooksActive: false, externalWorktreeConfig: false, submodulesRequired: false, unsafeOwnership: false }, originalLineageId: "lineage:original", originalFuture: { branchRef: "refs/heads/main", head: "a".repeat(40), statusDigest: DIGEST, indexDigest: DIGEST, approvedSourceDigest: DIGEST, availability: { status: AVAILABLE_CAPTURE, index: AVAILABLE_CAPTURE, approvedSource: AVAILABLE_CAPTURE, capture: AVAILABLE_CAPTURE } }, inspectorReasonCodes: [] };
  return evaluateBranchPreflight(input, now);
}

afterEach(cleanup);
describe("Branch from here", () => {
  it("renders all ordered checks, safe identities, and revalidates at the explicit confirmation boundary", async () => {
    const receipt = readyReceipt(new Date(Date.now() - 1_000));
    const client = { preflight: vi.fn(async () => receipt) };
    render(<BranchPreflightPanel savePointId={ID} savePointRevision={1} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));
    expect(await screen.findByRole("heading", { name: "Preflight passed" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByText(receipt.target.branchRef)).toBeTruthy();
    const integrityBoundary = screen.getByRole("complementary", { name: "Receipt integrity boundary" });
    expect(integrityBoundary.textContent).toMatch(/not an authenticity token/u);
    expect(integrityBoundary.nextElementSibling).toBe(screen.getByText("Final branch confirmation").closest("div"));
    fireEvent.click(screen.getByRole("button", { name: "Continue to confirmation boundary" }));
    expect(await screen.findByRole("status", { name: "Confirmation boundary ready" })).toBeTruthy();
    expect(client.preflight).toHaveBeenCalledTimes(2);
  });

  it("cancels pending inspection, restores the invoker, and performs no confirmation", async () => {
    let aborted = false;
    const client = { preflight: vi.fn((_id: string, _revision: number, signal: AbortSignal) => new Promise<ReturnType<typeof readyReceipt>>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); }))) };
    render(<BranchPreflightPanel savePointId={ID} savePointRevision={1} client={client} />);
    const invoke = screen.getByRole("button", { name: "Branch from here" });
    fireEvent.click(invoke); fireEvent.click(screen.getByRole("button", { name: "Cancel preflight" }));
    await waitFor(() => expect(aborted).toBe(true));
    expect(await screen.findByText(/cancelled before any branch operation/u)).toBeTruthy();
    expect(document.activeElement).toBe(invoke);
  });

  it("focuses a blocker and requires a fresh receipt after expiry or stale revalidation", async () => {
    const blocked = readyReceipt(new Date());
    const first = { ...blocked, ready: false, checks: blocked.checks.map((check, index) => index === 2 ? { ...check, state: "block" as const, reasonCode: "preflight.privacy-correlated-evidence", recovery: "Restore privacy evidence." } : check) };
    const client = { preflight: vi.fn(async () => first) };
    render(<BranchPreflightPanel savePointId={ID} savePointRevision={1} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));
    const blocker = await screen.findByText("Restore privacy evidence.");
    await waitFor(() => expect(document.activeElement).toBe(blocker.closest("li")));
    expect(screen.queryByRole("button", { name: "Continue to confirmation boundary" })).toBeNull();
  });

  it("preserves the ten-check receipt on expiry and offers one fresh-preflight action", async () => {
    const expired = readyReceipt(new Date(Date.now() - 31_000));
    const client = { preflight: vi.fn(async () => expired) };
    render(<BranchPreflightPanel savePointId={ID} savePointRevision={1} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));
    expect(await screen.findByRole("heading", { name: "Preflight expired" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getAllByRole("button", { name: "Run fresh preflight" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Continue to confirmation boundary" })).toBeNull();
  });

  it("preserves checks and blocks confirmation when original-future revalidation is stale", async () => {
    const first = readyReceipt(new Date(Date.now() - 1_000));
    const fresh = { ...readyReceipt(new Date()), originalFutureDigest: `sha256:${"c".repeat(64)}` };
    const client = { preflight: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(fresh) };
    render(<BranchPreflightPanel savePointId={ID} savePointRevision={1} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue to confirmation boundary" }));
    expect(await screen.findByRole("heading", { name: "Preflight became stale" })).toBeTruthy();
    expect(screen.getByText(/preflight\.original-future-stale/u)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getAllByRole("button", { name: "Run fresh preflight" })).toHaveLength(1);
  });

  it.each([
    ["succeeded", "Alternate lineage verified"],
    ["failed-no-effect", "Branch failed with no effect"],
    ["recovery-required", "Recovery required"],
    ["unavailable", "Alternate lineage unavailable"],
  ] as const)("binds and renders the %s terminal result", async (state, heading) => {
    const receipt = readyReceipt(new Date());
    const client = { preflight: vi.fn(async () => receipt) };
    const result = {
      schemaVersion: "remo.branch-result.v1" as const,
      operationId: receipt.target.operationId,
      savePointId: ID,
      savePointRevision: 1,
      preflightDigest: receipt.digest,
      displayLabel: `Alternate from ${ID}`,
      state,
      reasonCodes: state === "succeeded" ? [] : ["branch.fixture-terminal"],
      branchRef: receipt.target.branchRef,
      worktreeRelativePath: receipt.target.worktreeRelativePath,
      ...(state === "succeeded" ? { lineageId: `lineage:alternate:${receipt.target.operationId}` } : {}),
      updatedAt: new Date().toISOString(),
    };
    const orchestrationClient = { confirm: vi.fn(async () => result), list: vi.fn(async () => []) };
    render(<BranchPreflightPanel savePointId={ID} savePointRevision={1} client={client} orchestrationClient={orchestrationClient} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and create alternate lineage" }));
    expect(await screen.findByText(heading)).toBeTruthy();
    expect(orchestrationClient.confirm).toHaveBeenCalledWith(receipt, `Alternate from ${ID}`, `branch-${receipt.target.operationId}`, expect.any(AbortSignal));
    expect(client.preflight).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["succeeded", "Alternate lineage verified"],
    ["failed-no-effect", "Branch failed with no effect"],
    ["recovery-required", "Recovery required"],
    ["unavailable", "Alternate lineage unavailable"],
  ] as const)("hydrates durable %s state on startup without running preflight", async (state, heading) => {
    const receipt = readyReceipt(new Date());
    const durable = {
      schemaVersion: "remo.branch-result.v1" as const,
      operationId: receipt.target.operationId,
      savePointId: ID,
      savePointRevision: 1,
      preflightDigest: receipt.digest,
      displayLabel: `Alternate from ${ID}`,
      state,
      reasonCodes: state === "succeeded" ? [] : [`branch.fixture-${state}`],
      branchRef: receipt.target.branchRef,
      worktreeRelativePath: receipt.target.worktreeRelativePath,
      ...(state === "succeeded" ? { lineageId: `lineage:alternate:${receipt.target.operationId}` } : {}),
      updatedAt: "2026-08-20T06:00:00.000Z",
    };
    const preflight = { preflight: vi.fn(async () => receipt) };
    const orchestration = { confirm: vi.fn(), list: vi.fn(async () => [durable]) };
    render(<BranchPreflightPanel savePointId={ID} savePointRevision={1} client={preflight} orchestrationClient={orchestration} />);
    expect(await screen.findByText(heading)).toBeTruthy();
    expect(screen.getByText(state)).toBeTruthy();
    if (state !== "succeeded") expect(screen.getByText(new RegExp(`branch\\.fixture-${state}`, "u"))).toBeTruthy();
    expect(preflight.preflight).not.toHaveBeenCalled();
    expect(orchestration.confirm).not.toHaveBeenCalled();
  });

  it("aborts and resets an in-flight receipt when the selected identity or revision changes", async () => {
    let resolveFirst: ((receipt: ReturnType<typeof readyReceipt>) => void) | undefined;
    const first = new Promise<ReturnType<typeof readyReceipt>>((resolve) => { resolveFirst = resolve; });
    const secondReceipt = readyReceipt(new Date(), OTHER_ID, 2);
    const client = { preflight: vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(secondReceipt) };
    const { rerender } = render(<BranchPreflightPanel savePointId={ID} savePointRevision={1} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));
    expect(screen.getByRole("heading", { name: "Inspecting ten ordered checks" })).toBeTruthy();

    rerender(<BranchPreflightPanel savePointId={OTHER_ID} savePointRevision={2} client={client} />);
    resolveFirst?.(readyReceipt(new Date(), ID, 1));
    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: "Preflight passed" })).toBeNull();
    expect(screen.queryByText(deriveBranchPreflightIdentity(ID, 1).branchRef)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));
    expect(await screen.findByText(secondReceipt.target.branchRef)).toBeTruthy();
    expect(client.preflight).toHaveBeenLastCalledWith(OTHER_ID, 2, expect.any(AbortSignal));
  });
});
