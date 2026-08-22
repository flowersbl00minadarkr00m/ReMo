// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1/" }
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  delete window.__REMO_ROUTE_BOOTSTRAP__;
  vi.unstubAllGlobals();
});

describe("application route truth", () => {
  it("renders an honest unsupported-origin state without constructing a token or media request", () => {
    vi.stubGlobal("location", { protocol: "http:", hostname: "localhost", pathname: "/replay", origin: "http://localhost", search: "" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    render(<App />);

    expect(screen.getByRole("heading", { name: "Unsupported origin" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open saved results" })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "Save point not found"],
    ["deleted", "Save point deleted"],
    ["expired", "Save point expired"],
  ] as const)("renders the named %s recovery state", (state, heading) => {
    window.history.replaceState({}, "", "/save-points/01J000000000000000000000S6");
    window.__REMO_ROUTE_BOOTSTRAP__ = { route: "/save-points/01J000000000000000000000S6", state };

    render(<App />);

    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open saved results" })).toBeTruthy();
  });

  it("renders malformed save-point URLs as a safe in-app recovery state", () => {
    window.history.replaceState({}, "", "/save-points/not%20valid");

    render(<App />);

    expect(screen.getByRole("heading", { name: "Malformed save point address" })).toBeTruthy();
    expect(screen.getByText(/does not contain a valid save-point identity/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open saved results" }).getAttribute("href")).toBe("/save-points");
    expect(screen.queryByText(/Save point SP-/u)).toBeNull();
  });

  it.each([
    ["/boundary/setup", "/boundary/setup"],
    ["/capture/active", "/capture/active"],
    ["/candidate/review", "/candidate/review"],
    ["/save-points", "/save-points"],
    ["/replay", "/replay"],
    ["/replay/01J000000000000000000000S6", "/replay"],
    ["/compare?left=left&right=right", "/compare"],
  ] as const)("marks only the matched primary rail destination current for %s", (path, currentHref) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    window.history.replaceState({}, "", path);

    render(<App />);

    const navigation = screen.getByRole("navigation", { name: "VS-002 workflow" });
    const links = within(navigation).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/boundary/setup",
      "/capture/active",
      "/candidate/review",
      "/save-points",
      "/replay",
      "/compare",
    ]);
    expect(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.getAttribute("href"))).toEqual([currentHref]);
  });

  it("keeps active and candidate routes honest when server bootstrap is absent", () => {
    window.history.replaceState({}, "", "/capture/active");
    render(<App />);
    expect(screen.getByRole("heading", { name: "Active turn unavailable" })).toBeTruthy();

    cleanup();
    window.history.replaceState({}, "", "/candidate/review");
    render(<App />);
    expect(screen.getByText(/server-issued confirmation binding is unavailable/iu)).toBeTruthy();
  });

  it("preserves an explicit comparison pair in replay return navigation", () => {
    const left = "01J000000000000000000000S1";
    const right = "01J000000000000000000000S2";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ anchors: [], limit: 10, truncated: false }) }));
    window.history.replaceState({}, "", `/replay?compareLeft=${left}&compareRight=${right}`);

    render(<App />);

    expect(screen.getByRole("link", { name: "Return to selected comparison pair" }).getAttribute("href")).toBe(`/compare?left=${left}&right=${right}`);
  });
});
