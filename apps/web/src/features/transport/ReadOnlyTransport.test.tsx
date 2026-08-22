// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadOnlyTransport } from "./ReadOnlyTransport.js";

afterEach(cleanup);

describe("read-only history transport", () => {
  it("exposes previous, current, and next around the composed T3 restart control", () => {
    const previous = vi.fn(); const next = vi.fn();
    render(<ReadOnlyTransport position={4} size={10} canPrevious canNext onPrevious={previous} onNext={next} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Next turn" }));
    expect(previous).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce();
    expect(screen.getByText("Turn 4 of 10")).toBeTruthy();
    expect(screen.queryByText(/branch|restore|rollback|delete/iu)).toBeNull();
  });

  it("does not invent navigation when no historical turn is selected", () => {
    render(<ReadOnlyTransport position={0} size={10} canPrevious={false} canNext={false} onPrevious={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous turn" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Next turn" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("No current turn · 10 available")).toBeTruthy();
  });
});
