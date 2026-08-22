// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDecisionRecord } from "@remo/domain/browser";
import { DecisionCard } from "./DecisionCard.js";

afterEach(cleanup);
const turnId = "01J00000000000000000000T04";
const savePointId = "01J00000000000000000000S04";
const stamp = "2026-08-18T10:04:00.000Z";
const supplied = <T,>(value: T) => ({ value, provenance: "user-supplied" as const, sourceComponentIds: [] as string[], recordedAt: stamp });
const first = buildDecisionRecord({ decisionId: "decision-turn-04", savePointId, turnId, revision: 1, question: supplied("Should navigation stay discoverable?"), options: supplied([{ id: "a", label: "Use disclosure" }, { id: "b", label: "Hide destinations" }]), selectedOptionId: supplied("a"), owner: supplied("Product owner"), uncertainty: supplied({ level: "low" as const, source: "human" as const }), evidenceComponentIds: [`${turnId}:screenshot`], expectedEffect: { value: "Destinations stay reachable.", provenance: "inferred", sourceComponentIds: [`${turnId}:screenshot`], recordedAt: stamp }, verification: supplied("Check five widths."), outcome: { provenance: "unknown", sourceComponentIds: [], recordedAt: stamp } });
const second = buildDecisionRecord({ ...first, revision: 2, predecessorDigest: first.digest, expectedEffect: { ...first.expectedEffect, confirmedAt: "2026-08-18T10:05:00.000Z" } });

describe("decision card", () => {
  it("renders every field with adjacent provenance, major-turn explanation, and immutable supersession trail", async () => {
    const client = { read: vi.fn(() => Promise.resolve({ current: second, revisions: [first, second] })), createCandidate: vi.fn(), revise: vi.fn() };
    render(<DecisionCard savePointId={savePointId} turnId={turnId} majorTurnExplanation="Consequential navigation change despite low uncertainty." client={client} />);
    await waitFor(() => expect(screen.getByText("Should navigation stay discoverable?", { selector: "h2" })).toBeTruthy());
    expect(screen.getByText(/Consequential navigation change despite low uncertainty/u)).toBeTruthy();
    expect(screen.getByText("Product owner")).toBeTruthy();
    expect(screen.getByText("low · source human")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getAllByText("inferred").length).toBeGreaterThan(0);
    expect(screen.getByText(/provenance unchanged/u)).toBeTruthy();
    expect(screen.getByText("Revision and supersession trail (2)")).toBeTruthy();
  });

  it("renders an honest unknown state instead of inventing a decision", async () => {
    const client = { read: vi.fn(() => Promise.resolve(undefined)), createCandidate: vi.fn(), revise: vi.fn() };
    render(<DecisionCard savePointId={savePointId} turnId={turnId} majorTurnExplanation="Unavailable" client={client} />);
    await waitFor(() => expect(screen.getByText("Decision context unknown")).toBeTruthy());
    expect(screen.getByText(/has not reconstructed rationale, ownership, certainty, options, or outcome/u)).toBeTruthy();
  });

  it("shares a pending durable read across the StrictMode probe and aborts only final cleanup", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const settled = vi.fn();
    const read = vi.fn((_savePointId: string, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signals.push(signal);
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }).finally(settled));
    const view = render(<StrictMode><DecisionCard savePointId={savePointId} turnId={turnId} majorTurnExplanation="Unavailable" client={{ read, createCandidate: vi.fn(), revise: vi.fn() }} /></StrictMode>);

    await waitFor(() => expect(signals).toHaveLength(1));
    expect(read).toHaveBeenCalledTimes(1);
    expect(signals[0]).toBeDefined();
    expect(signals[0]?.aborted).toBe(false);
    view.unmount();
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  });
});
