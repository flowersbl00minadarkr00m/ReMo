// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1/" }
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../App.js";
import { createEvidenceDetailFixture } from "./save-point-fixtures.js";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  delete window.__REMO_SAVE_POINT__;
  delete window.__REMO_SAVE_POINT_SESSION__;
});

describe("save-point route authority", () => {
  it("fails honestly when a stable route has no service bootstrap", () => {
    window.history.replaceState({}, "", "/save-points/01J000000000000000000000S6");
    render(<App />);
    expect(screen.getByRole("heading", { name: "Evidence detail unavailable" })).toBeTruthy();
    expect(screen.queryByText(/Durable local save/u)).toBeNull();
    expect(screen.queryByText("Evidence", { exact: true })).toBeNull();
    expect(screen.queryByText("Settings", { exact: true })).toBeNull();
  });

  it("renders only when the bootstrapped identity exactly matches the stable route", () => {
    const detail = createEvidenceDetailFixture("complete");
    window.history.replaceState({}, "", detail.stablePath);
    window.__REMO_SAVE_POINT__ = detail;
    const { rerender } = render(<App />);
    expect(screen.getByRole("heading", { name: `Save point ${detail.displayId}` })).toBeTruthy();
    expect(screen.getByText("Evidence", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Settings", { exact: true })).toBeNull();

    window.history.replaceState({}, "", "/save-points/another-save");
    rerender(<App />);
    expect(screen.getByRole("heading", { name: "Evidence identity mismatch" })).toBeTruthy();
  });
});
