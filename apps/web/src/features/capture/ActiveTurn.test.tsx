// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveTurn } from "./ActiveTurn.js";

afterEach(cleanup);

describe("active-turn capture surface", () => {
  it("shows the exact scope, stable identity, recording text, elapsed text, and always-visible Stop", () => {
    render(<ActiveTurn startedAt="2026-08-16T05:00:00.000Z" now={() => Date.parse("2026-08-16T05:00:08.000Z")} onStop={() => Promise.resolve({ status: "no-candidate" })} />);
    expect(screen.getByRole("heading", { name: "Bounded turn in progress" })).toBeTruthy();
    expect(screen.getByText("C:/path/to/ReMo")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:4173/fixture/save-point")).toBeTruthy();
    expect(screen.getByText("01J000000000000000000000T3")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Recording");
    expect(screen.getByText("00:08 elapsed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop capture immediately" })).toBeTruthy();
  });

  it("is keyboard operable and does not claim Stopped until asynchronous Stop succeeds", async () => {
    let resolveStop!: (value: { status: "no-candidate" }) => void;
    const onStop = vi.fn(() => new Promise<{ status: "no-candidate" }>((resolve) => { resolveStop = resolve; }));
    const user = userEvent.setup();
    render(<ActiveTurn onStop={onStop} />);
    await user.tab();
    const stop = screen.getByRole("button", { name: "Stop capture immediately" });
    expect(document.activeElement).toBe(stop);
    await user.keyboard("{Enter}");
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("Stopping");
    expect(screen.getByRole("status").textContent).not.toContain("Stopped");
    resolveStop({ status: "no-candidate" });
    expect(await screen.findByText("Capture stopped and settled")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Stopped");
    expect(stop.hasAttribute("disabled")).toBe(true);
  });

  it("shows an honest retryable failure when Stop cannot be confirmed", async () => {
    const onStop = vi.fn(() => Promise.reject(new Error("control unavailable")));
    const user = userEvent.setup();
    render(<ActiveTurn onStop={onStop} />);
    await user.click(screen.getByRole("button", { name: "Stop capture immediately" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Stop could not be confirmed");
    expect(screen.getByRole("status").textContent).toContain("Stop failed");
    expect(screen.getByRole("button", { name: "Retry stopping capture" }).hasAttribute("disabled")).toBe(false);
  });
});
