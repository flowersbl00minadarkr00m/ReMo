// @vitest-environment jsdom
import { discardCandidate } from "@remo/domain/browser";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateReview } from "./CandidateReview.js";
import { createBoundCandidateFixture, createCandidateFixture } from "./candidate-fixtures.js";
import type { DurableSaveProjection } from "./promotion-client.js";

afterEach(cleanup);

describe("candidate review surface", () => {
  it("shows non-durable status, nomination, trust states, provenance, expiry, previews, and usable text alternatives", () => {
    render(<CandidateReview candidate={createBoundCandidateFixture()} />);
    expect(screen.getByRole("heading", { name: "Candidate — not yet saved" })).toBeTruthy();
    expect(screen.getByText("Non-durable")).toBeTruthy();
    expect(screen.getByText("responsive, accessibility")).toBeTruthy();
    expect(screen.getByText("editable-eligible")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Screenshot preview is privacy-cleared/u })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Replay preview is privacy-cleared/u })).toBeTruthy();
    expect(screen.getAllByText("observed").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Confirm durable save" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps confirmation blocked and focuses the live blocking summary for quarantine", async () => {
    render(<CandidateReview candidate={createCandidateFixture("quarantined")} />);
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert);
    expect(alert.textContent).toContain("privacy.canary-detected");
    expect(screen.getByRole("button", { name: "Confirm durable save" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Screenshot unavailable")).toBeTruthy();
    expect(screen.getByText("Replay unavailable")).toBeTruthy();
  });

  it.each(["inconsistent", "incomplete"] as const)("renders honest %s state precedence and blocks confirmation", async (state) => {
    const candidate = createCandidateFixture(state);
    render(<CandidateReview candidate={candidate} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: `Candidate ${state}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm durable save" }).hasAttribute("disabled")).toBe(true);
    if (state === "inconsistent") {
      expect(candidate.blockingReasons).toContain("source.state-mismatch");
      expect(candidate.reproducible).toBe(false);
      expect(screen.getByText("Reproducibility is not claimed.")).toBeTruthy();
    }
  });

  it("transitions through honest pending state to exactly one durable identity and retention projection", async () => {
    const onConfirmIntent = vi.fn();
    let resolvePromotion!: (value: DurableSaveProjection) => void;
    const promote = vi.fn(() => new Promise<DurableSaveProjection>((resolve) => { resolvePromotion = resolve; }));
    const user = userEvent.setup();
    render(<CandidateReview candidate={createBoundCandidateFixture()} onConfirmIntent={onConfirmIntent} onPromote={promote} />);
    await user.click(screen.getByRole("button", { name: "Confirm durable save" }));
    expect(onConfirmIntent).toHaveBeenCalledTimes(1);
    expect(onConfirmIntent).toHaveBeenCalledWith({ status: "ready-for-durable-promotion", turnId: "01J000000000000000000000T4", savePointId: "01J000000000000000000000S5", candidateRevision: 1, candidateManifestDigest: `sha256:${"b".repeat(64)}` });
    expect(screen.getByRole("button", { name: "Saving locally…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Durable promotion pending");
    resolvePromotion({ status: "durable", turnId: "01J000000000000000000000T4", savePointId: "01J000000000000000000000S5", revision: 1, manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", createdAt: "2026-08-16T07:30:00.000Z", promotedAt: "2026-08-16T08:00:00.000Z", expiresAt: "2026-09-15T08:00:00.000Z", pinned: false, health: "complete", fidelity: "editable-eligible" });
    expect(await screen.findByRole("heading", { name: "Durable save created" })).toBeTruthy();
    expect(screen.getByText("01J000000000000000000000S5")).toBeTruthy();
    expect(screen.getByText("Unpinned")).toBeTruthy();
    expect(screen.getByText(/sha256:aaaaaaaa/u)).toBeTruthy();
    expect(promote).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Confirm durable save/u })).toBeNull();
  });

  it("keeps a failed confirmation non-durable, announces it, recovers focus, and permits idempotent retry", async () => {
    const success: DurableSaveProjection = { status: "durable", turnId: "01J000000000000000000000T4", savePointId: "01J000000000000000000000S5", revision: 1, manifestDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", createdAt: "2026-08-16T07:30:00.000Z", promotedAt: "2026-08-16T08:00:00.000Z", expiresAt: "2026-09-15T08:00:00.000Z", pinned: false, health: "complete", fidelity: "editable-eligible" };
    const promote = vi.fn().mockRejectedValueOnce(new Error("Local catalog is temporarily unavailable.")).mockResolvedValueOnce(success);
    const user = userEvent.setup();
    render(<CandidateReview candidate={createBoundCandidateFixture()} onPromote={promote} />);
    await user.click(screen.getByRole("button", { name: "Confirm durable save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Local catalog is temporarily unavailable");
    expect(document.activeElement).toBe(alert);
    expect(screen.getByText("Non-durable")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry durable save" }));
    expect(await screen.findByRole("heading", { name: "Durable save created" })).toBeTruthy();
    expect(promote).toHaveBeenCalledTimes(2);
  });

  it("supports safe discard, cancel focus recovery, final focus recovery, and live announcements", async () => {
    const candidate = createBoundCandidateFixture();
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    render(<CandidateReview candidate={candidate} onDiscard={onDiscard} />);
    const discard = screen.getByRole("button", { name: "Discard" });
    await user.click(discard);
    const dialog = screen.getByRole("alertdialog", { name: "Discard this candidate?" });
    const keep = screen.getByRole("button", { name: "Keep candidate" });
    const discardSafely = screen.getByRole("button", { name: "Discard safely" });
    expect(document.activeElement).toBe(dialog);
    await user.tab();
    expect(document.activeElement).toBe(keep);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(discardSafely);
    await user.tab();
    expect(document.activeElement).toBe(keep);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(discard);
    await user.click(discard);
    await user.click(screen.getByRole("button", { name: "Keep candidate" }));
    expect(document.activeElement).toBe(discard);
    await user.click(discard);
    await user.click(screen.getByRole("button", { name: "Discard safely" }));
    const heading = screen.getByRole("heading", { name: "Review candidate" });
    expect(document.activeElement).toBe(heading);
    expect(onDiscard).toHaveBeenCalledWith(discardCandidate(candidate));
    expect(screen.getByRole("heading", { name: "Candidate discarded" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("source history is unchanged");
  });
});
