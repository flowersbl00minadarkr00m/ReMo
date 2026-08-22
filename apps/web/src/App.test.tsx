// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1/" }
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { createBoundCandidateFixture } from "./features/candidate/candidate-fixtures.js";

afterEach(() => { cleanup(); document.querySelector('meta[name="remo-promotion-session"]')?.remove(); window.history.replaceState({}, "", "/"); delete window.__REMO_CANDIDATE__; delete window.__REMO_PROMOTION_SESSION__; vi.unstubAllGlobals(); });

describe("candidate bootstrap authority", () => {
  it("never attaches a real promotion client to client-generated fallback candidate data", async () => {
    window.history.replaceState({}, "", "/candidate/review?state=candidate");
    const promote = vi.fn();
    render(<App promotionClient={{ promote }} />);
    const confirm = screen.getByRole("button", { name: "Confirm durable save" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await userEvent.setup().click(confirm);
    expect(promote).not.toHaveBeenCalled();
    expect(screen.getByText(/server-issued confirmation binding is unavailable/iu)).toBeTruthy();
  });

  it("does not accept a promotion token from DOM metadata", async () => {
    window.history.replaceState({}, "", "/candidate/review");
    const meta = document.createElement("meta");
    meta.name = "remo-promotion-session";
    meta.content = "persisted-build-token";
    document.head.append(meta);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    render(<App candidate={createBoundCandidateFixture()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Confirm durable save" }));

    expect(fetch).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Durable save not created" })).toBeTruthy();
  });
});
