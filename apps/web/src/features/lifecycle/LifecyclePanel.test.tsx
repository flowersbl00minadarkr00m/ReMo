// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleClientError, type LifecycleClient, type LifecycleMutation, type LifecycleView } from "./lifecycle-client.js";
import { LifecyclePanel } from "./LifecyclePanel.js";

afterEach(cleanup);

const initial: LifecycleView = { subject: "durable", id: "save-t7", turnId: "turn-t7", savePointId: "save-t7", revision: 1, state: "active", createdAt: "2026-08-01T00:00:00.000Z", promotedAt: "2026-08-01T01:00:00.000Z", originalExpiresAt: "2026-08-31T01:00:00.000Z", expiresAt: "2026-08-31T01:00:00.000Z", pinned: false };

function mutation(intentKey: string, pinned: boolean): LifecycleMutation {
  return { ...initial, pinned, operationId: intentKey, changed: true };
}

function intentFactory(): () => string {
  let sequence = 0;
  return () => `deterministic-intent-${sequence += 1}`;
}

function client(overrides: Partial<LifecycleClient> = {}): LifecycleClient {
  return {
    pin: vi.fn((_, key) => Promise.resolve(mutation(key, true))),
    unpin: vi.fn((_, _confirmed, key) => Promise.resolve(mutation(key, false))),
    quarantine: vi.fn((_, key) => Promise.resolve({ ...mutation(key, false), state: "quarantined" } as const)),
    redact: vi.fn((_, _roles, key) => Promise.resolve({ ...mutation(key, false), subject: "candidate", revision: 2 } as const)),
    export: vi.fn(() => Promise.reject(new Error("not used"))),
    delete: vi.fn(() => Promise.reject(new Error("not used"))),
    ...overrides,
  };
}

describe("accessible lifecycle controls", () => {
  it("creates fresh keys for later intents while a retry closure preserves the failed intent key", async () => {
    const seen: string[] = [];
    let firstPin = true;
    const pin = vi.fn((_save: string, key: string) => {
      seen.push(key);
      if (firstPin) { firstPin = false; return Promise.reject(new Error("disk busy")); }
      return Promise.resolve(mutation(key, true));
    });
    const unpin = vi.fn((_save: string, _confirmed: boolean, key: string) => { seen.push(key); return Promise.resolve(mutation(key, false)); });
    render(<LifecyclePanel initial={initial} client={client({ pin, unpin })} onBlocked={vi.fn()} createIntentId={intentFactory()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Pin" }));
    const retry = await screen.findByRole("button", { name: "Retry failed action" });
    expect(document.activeElement).toBe(retry);
    await user.click(retry);
    await user.click(await screen.findByRole("button", { name: "Unpin" }));
    await user.click(await screen.findByRole("button", { name: "Pin" }));
    expect(seen[0]).toBe(seen[1]);
    expect(new Set([seen[1], seen[2], seen[3]]).size).toBe(3);
  });

  it("retains one unpin intent key across immediate-expiry confirmation and focuses the alert dialog", async () => {
    const keys: string[] = [];
    const unpin = vi.fn((_save: string, confirmed: boolean, key: string) => {
      keys.push(key);
      if (!confirmed) return Promise.reject(new LifecycleClientError("lifecycle.immediate-expiry-confirmation-required", true, true, initial.originalExpiresAt));
      return Promise.resolve({ ...mutation(key, false), state: "expired" as const });
    });
    render(<LifecyclePanel initial={{ ...initial, pinned: true }} client={client({ unpin })} onBlocked={vi.fn()} createIntentId={intentFactory()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Unpin" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Unpin and expire immediately?" });
    expect(document.activeElement).toBe(dialog);
    await userEvent.setup().click(screen.getByRole("button", { name: "Unpin and expire" }));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await screen.findByRole("status")).textContent).toMatch(/unpin succeeded/u);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Retention and lifecycle" })));
  });

  it("traps forward and reverse Tab focus inside the modal alert dialog", async () => {
    render(<LifecyclePanel initial={initial} client={client()} onBlocked={vi.fn()} createIntentId={intentFactory()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete local evidence" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete controlled local evidence?" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = dialog.querySelectorAll("button")[1]!;
    expect(document.activeElement).toBe(dialog);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
  });

  it("does not reuse a completed intent key after the lifecycle panel remounts", async () => {
    const keys: string[] = [];
    const pin = vi.fn((_save: string, key: string) => {
      keys.push(key);
      return Promise.resolve(mutation(key, true));
    });
    let sequence = 0;
    const createIntentId = (): string => `reload-safe-intent-${sequence += 1}`;
    const first = render(<LifecyclePanel initial={initial} client={client({ pin })} onBlocked={vi.fn()} createIntentId={createIntentId} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Pin" }));
    await screen.findByRole("button", { name: "Unpin" });
    first.unmount();
    render(<LifecyclePanel initial={initial} client={client({ pin })} onBlocked={vi.fn()} createIntentId={createIntentId} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Pin" }));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("blocks payload viewing without offering retry when an action discovers logical expiry", async () => {
    const onBlocked = vi.fn();
    const pin = vi.fn(() => Promise.reject(new LifecycleClientError("lifecycle.expired", false)));
    render(<LifecyclePanel initial={initial} client={client({ pin })} onBlocked={onBlocked} createIntentId={intentFactory()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Pin" }));
    expect(await screen.findByText(/ordinary local evidence is no longer available/iu)).toBeTruthy();
    expect(onBlocked).toHaveBeenCalledWith("expired");
    expect(screen.queryByRole("button", { name: "Retry failed action" })).toBeNull();
  });
});
