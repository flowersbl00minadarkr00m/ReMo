// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectPolicyRevision } from "@remo/domain/browser";
import { SavePointDetail } from "./SavePointDetail.js";
import { createEvidenceDetailFixture } from "./save-point-fixtures.js";
import type { LifecycleClient } from "../lifecycle/lifecycle-client.js";
import type { EvidenceMediaClient } from "../evidence-media/evidence-media-client.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("individual evidence detail", () => {
  it.each(["complete", "degraded", "inconsistent"] as const)("exposes %s integrity, fidelity, authority, provenance, policies, and local limitations semantically", (state) => {
    render(<SavePointDetail detail={createEvidenceDetailFixture(state)} />);
    expect(screen.getByRole("heading", { level: 1, name: /Save point SP-006/u })).toBeTruthy();
    const summary = screen.getByLabelText("Trust summary");
    expect(within(summary).getByText(state === "complete" ? "Complete" : state === "degraded" ? "Incomplete" : "Inconsistent")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Evidence components" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open exact source change/u }).getAttribute("rel")).toContain("noreferrer");
    expect(screen.getByText(/Synthetic Git authority/u)).toBeTruthy();
    expect(screen.getByText(/Synthetic Langfuse authority/u)).toBeTruthy();
    expect(screen.getByText(/Policy revisions/u)).toBeTruthy();
    expect(screen.getAllByText(/User-supplied/u).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/timeline|rewind|branch|compare/iu);
  });

  it("names an unknown policy category as unavailable without substituting another category", () => {
    const detail = createEvidenceDetailFixture("complete");
    const source = detail.components.find((component) => component.type === "source");
    if (source === undefined) throw new Error("source fixture component is required");
    const unknownPolicyDetail = {
      ...detail,
      components: detail.components.map((component) => component.type === "source"
        ? { ...component, policyRevision: "unknown.policy.v9", policyCategory: { status: "unavailable" as const, category: "Unavailable" as const, revision: "unknown.policy.v9" } }
        : component),
    };

    render(<SavePointDetail detail={unknownPolicyDetail} />);

    const sourceRow = screen.getByText("Source change").closest("li");
    expect(sourceRow).not.toBeNull();
    expect(within(sourceRow!).getByText("Policy category unavailable")).toBeTruthy();
    expect(within(sourceRow!).getByText("unknown.policy.v9")).toBeTruthy();
    expect(within(sourceRow!).queryByText("Source policy")).toBeNull();
    expect(source).toBeDefined();
  });

  it("renders the existing remo.privacy.v1 Integrity anomaly as unavailable instead of Privacy", () => {
    const detail = createEvidenceDetailFixture("complete");
    const anomaly = { ...detail, policyRevisions: { ...detail.policyRevisions, Integrity: projectPolicyRevision("Integrity", "remo.privacy.v1") } };

    render(<SavePointDetail detail={anomaly} />);

    const integrityRow = screen.getByText("Integrity", { selector: "dt" }).closest("div");
    expect(integrityRow).not.toBeNull();
    expect(within(integrityRow!).getByText("Unavailable")).toBeTruthy();
    expect(within(integrityRow!).getByText(/Expected Integrity.*category mismatch/u)).toBeTruthy();
    expect(within(integrityRow!).queryByText("Privacy")).toBeNull();
    expect(within(integrityRow!).queryByText("remo.privacy.v1")).toBeNull();
  });

  it("keeps safe local evidence inspectable during a trace outage and offers a keyboard-operable retry", async () => {
    let release!: (detail: ReturnType<typeof createEvidenceDetailFixture>) => void;
    const reconcile = vi.fn(() => new Promise<ReturnType<typeof createEvidenceDetailFixture>>((resolve) => { release = resolve; }));
    const degraded = createEvidenceDetailFixture("degraded");
    const evidenceMediaClient: EvidenceMediaClient = {
      screenshot: vi.fn(() => Promise.resolve({ blob: new Blob(["png"], { type: "image/png" }), digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", componentId: `${degraded.turnId}:screenshot`, width: 1440, height: 900 })),
      replay: vi.fn(() => Promise.reject(new Error("replay unavailable"))),
    };
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:test-screenshot"), revokeObjectURL: vi.fn() });
    render(<SavePointDetail detail={degraded} onReconcile={reconcile} evidenceMediaClient={evidenceMediaClient} />);
    expect(await screen.findByRole("img", { name: /Privacy-checked captured UI/u })).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry trace correlation" });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    const click = userEvent.setup().click(retry);
    expect((await screen.findByRole("button", { name: "Retrying trace correlation" })).hasAttribute("disabled")).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
    release(createEvidenceDetailFixture("complete"));
    await click;
    expect(await screen.findByText("Complete")).toBeTruthy();
    expect(screen.getByText(/Correlation updated.*Complete/u).textContent).toMatch(/Correlation updated.*Complete/u);
    expect(document.activeElement).toBe(screen.getByLabelText("Trust summary"));
    expect(screen.queryByRole("button", { name: /Retry trace correlation/u })).toBeNull();
    expect(screen.getByText(degraded.savePointId)).toBeTruthy();
  });

  it("announces failed recovery and returns focus to the retry target", async () => {
    const reconcile = vi.fn(() => Promise.reject(new Error("unavailable")));
    render(<SavePointDetail detail={createEvidenceDetailFixture("degraded")} onReconcile={reconcile} />);
    const retry = screen.getByRole("button", { name: "Retry trace correlation" });
    await userEvent.setup().click(retry);
    expect((await screen.findByText("Correlation remains unavailable. Local evidence is unchanged.")).textContent).toBe("Correlation remains unavailable. Local evidence is unchanged.");
    expect(document.activeElement).toBe(retry);
  });

  it("blocks editable eligibility and promotion language for conflicting authority", () => {
    render(<SavePointDetail detail={createEvidenceDetailFixture("inconsistent")} />);
    expect(screen.getByText(/not eligible for editable reconstruction/u)).toBeTruthy();
    expect(screen.queryByText(/ready for promotion/iu)).toBeNull();
  });

  it("requires destructive confirmation, then removes quarantined payloads from ordinary viewing and offers regeneration", async () => {
    const detail = createEvidenceDetailFixture("complete");
    const lifecycleClient = {
      quarantine: vi.fn((_savePointId: string, operationId: string) => Promise.resolve({ subject: "durable", id: detail.savePointId, turnId: detail.turnId, savePointId: detail.savePointId, revision: 1, state: "quarantined", createdAt: detail.retention.promotedAt, promotedAt: detail.retention.promotedAt, originalExpiresAt: detail.retention.expiresAt, expiresAt: detail.retention.expiresAt, pinned: false, operationId, changed: true } as const)),
      pin: vi.fn(), unpin: vi.fn(), redact: vi.fn(), export: vi.fn(), delete: vi.fn(),
    } as LifecycleClient;
    render(<SavePointDetail detail={detail} lifecycleClient={lifecycleClient} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = screen.getByRole("alertdialog", { name: "Quarantine this save?" });
    expect(document.activeElement).toBe(dialog);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Quarantine" }));
    await user.click(screen.getByRole("button", { name: "Quarantine" }));
    await user.click(screen.getByRole("button", { name: "Quarantine save" }));
    expect(await screen.findByRole("heading", { name: "This save is quarantined" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Privacy-checked screenshot remains available locally/u })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Evidence components" })).toBeNull();
    expect(screen.getByRole("button", { name: "Redact and regenerate candidate" })).toBeTruthy();
  });
});
