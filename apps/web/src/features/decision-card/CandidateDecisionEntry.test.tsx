// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDecisionRecord, type DecisionField, type DecisionOption, type DecisionUncertainty } from "@remo/domain/browser";
import { createBoundCandidateFixture } from "../candidate/candidate-fixtures.js";
import { CandidateDecisionEntry } from "./CandidateDecisionEntry.js";
import type { CandidateDecisionInput } from "./decision-client.js";

afterEach(cleanup);

describe("candidate decision entry", () => {
  it("requires explicit plain-text fields and records unknown outcome before promotion", async () => {
    const candidate = createBoundCandidateFixture();
    type DraftField<T> = Omit<DecisionField<T>, "recordedAt">;
    type DraftContent = { question: DraftField<string>; options: DraftField<readonly DecisionOption[]>; selectedOptionId: DraftField<string>; owner: DraftField<string>; uncertainty: DraftField<DecisionUncertainty>; evidenceComponentIds: readonly string[]; expectedEffect: DraftField<string>; verification: DraftField<string>; outcome: DraftField<string> };
    const createCandidate = vi.fn((_turnId: string, input: CandidateDecisionInput) => {
      const content = input.content as DraftContent;
      const recordedAt = "2026-08-18T10:04:00.000Z";
      const stamp = <T,>(value: DraftField<T>): DecisionField<T> => ({ ...value, recordedAt });
      return Promise.resolve(buildDecisionRecord({ decisionId: input.decisionId, savePointId: candidate.confirmationBinding!.savePointId, turnId: candidate.turnId, revision: 1, question: stamp(content.question), options: stamp(content.options), selectedOptionId: stamp(content.selectedOptionId), owner: stamp(content.owner), uncertainty: stamp(content.uncertainty), evidenceComponentIds: content.evidenceComponentIds, expectedEffect: stamp(content.expectedEffect), verification: stamp(content.verification), outcome: stamp(content.outcome) }));
    });
    const onSaved = vi.fn();
    render(<CandidateDecisionEntry candidate={candidate} client={{ createCandidate, readCandidate: vi.fn().mockResolvedValue(undefined), read: vi.fn(), revise: vi.fn() }} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record decision before promotion" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Decision question"), { target: { value: "Should navigation stay discoverable?" } });
    fireEvent.change(screen.getByLabelText("First considered option"), { target: { value: "Use disclosure" } });
    fireEvent.change(screen.getByLabelText("Second considered option"), { target: { value: "Hide destinations" } });
    fireEvent.click(screen.getByLabelText("First considered option").previousElementSibling!);
    fireEvent.change(screen.getByLabelText("Decision owner"), { target: { value: "Product owner" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Source/u }));
    fireEvent.change(screen.getByLabelText("Expected effect"), { target: { value: "Destinations stay reachable." } });
    fireEvent.change(screen.getByLabelText("Verification plan"), { target: { value: "Check five widths and keyboard traversal." } });
    fireEvent.click(screen.getByRole("button", { name: "Record decision before promotion" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const call = createCandidate.mock.calls[0];
    expect(call?.[0]).toBe(candidate.turnId);
    expect(call?.[1].expectedCandidateRevision).toBe(1);
    const submitted = call?.[1].content as DraftContent;
    expect(submitted.uncertainty.value).toEqual({ level: "low", source: "human" });
    expect(submitted.outcome).toEqual({ provenance: "unknown", sourceComponentIds: [] });
    expect(screen.getByText(/Outcome remains unknown/u)).toBeTruthy();
  });

  it("recovers an already committed candidate decision after reload", async () => {
    const candidate = createBoundCandidateFixture();
    const recordedAt = "2026-08-18T10:04:00.000Z";
    const existing = buildDecisionRecord({
      decisionId: `decision-${candidate.turnId}`,
      savePointId: candidate.confirmationBinding!.savePointId,
      turnId: candidate.turnId,
      revision: 1,
      question: { value: "Should navigation stay discoverable?", provenance: "user-supplied", sourceComponentIds: [], recordedAt },
      options: { value: [{ id: "option-a", label: "Use disclosure" }, { id: "option-b", label: "Hide destinations" }], provenance: "user-supplied", sourceComponentIds: [], recordedAt },
      selectedOptionId: { value: "option-a", provenance: "user-supplied", sourceComponentIds: [], recordedAt },
      owner: { value: "Product owner", provenance: "user-supplied", sourceComponentIds: [], recordedAt },
      uncertainty: { value: { level: "low", source: "human" }, provenance: "user-supplied", sourceComponentIds: [], recordedAt },
      evidenceComponentIds: [`${candidate.turnId}:source`],
      expectedEffect: { value: "Destinations stay reachable.", provenance: "inferred", sourceComponentIds: [`${candidate.turnId}:source`], recordedAt },
      verification: { value: "Check five widths.", provenance: "user-supplied", sourceComponentIds: [`${candidate.turnId}:source`], recordedAt },
      outcome: { provenance: "unknown", sourceComponentIds: [], recordedAt },
    });
    const onSaved = vi.fn();
    render(<CandidateDecisionEntry candidate={candidate} client={{ createCandidate: vi.fn(), readCandidate: vi.fn().mockResolvedValue({ current: existing, revisions: [existing] }), read: vi.fn(), revise: vi.fn() }} onSaved={onSaved} />);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(existing));
    expect(screen.getByText(/Recovered decision revision 1/u)).toBeTruthy();
  });

  it("aborts only a genuinely pending candidate recovery read during cleanup", async () => {
    const candidate = createBoundCandidateFixture();
    let settledSignal: AbortSignal | undefined;
    const settled = render(<CandidateDecisionEntry candidate={candidate} client={{ createCandidate: vi.fn(), readCandidate: vi.fn((_turnId, signal) => { settledSignal = signal; return Promise.resolve(undefined); }), read: vi.fn(), revise: vi.fn() }} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("No decision revision has been recorded.")).toBeTruthy());
    settled.unmount();
    expect(settledSignal?.aborted).toBe(false);

    let pendingSignal: AbortSignal | undefined;
    const pending = render(<CandidateDecisionEntry candidate={candidate} client={{ createCandidate: vi.fn(), readCandidate: vi.fn((_turnId, signal) => { pendingSignal = signal; return new Promise(() => undefined); }), read: vi.fn(), revise: vi.fn() }} onSaved={vi.fn()} />);
    await waitFor(() => expect(pendingSignal).toBeDefined());
    pending.unmount();
    await waitFor(() => expect(pendingSignal?.aborted).toBe(true));
  });

  it("keeps a StrictMode probe recovery alive but aborts the final pending cleanup", async () => {
    const candidate = createBoundCandidateFixture();
    const signals: AbortSignal[] = [];
    const settled = vi.fn();
    const readCandidate = vi.fn((_turnId: string, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signals.push(signal!);
      signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }).finally(settled));
    const view = render(
      <StrictMode>
        <CandidateDecisionEntry
          candidate={candidate}
          client={{ createCandidate: vi.fn(), readCandidate, read: vi.fn(), revise: vi.fn() }}
          onSaved={vi.fn()}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(signals).toHaveLength(1));
    expect(readCandidate).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);
    view.unmount();
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  });
});
