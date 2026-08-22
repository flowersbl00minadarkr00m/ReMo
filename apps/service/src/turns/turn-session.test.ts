import { describe, expect, it, vi } from "vitest";
import { createTurnSession } from "./turn-session.js";

describe("bounded turn session", () => {
  it("keeps stable identity and stops its capture immediately once", async () => {
    const stopCapture = vi.fn(() => Promise.resolve());
    const turn = createTurnSession({
      turnId: "01J0000000000000000000000T",
      repository: "C:/path/to/ReMo",
      route: "http://127.0.0.1:4173/fixture/save-point",
      startedAt: "2026-08-16T05:00:00.000Z",
      stopCapture,
    });
    expect(turn.snapshot()).toMatchObject({ status: "recording", turnId: "01J0000000000000000000000T" });
    await turn.stop("user");
    await turn.stop("user");
    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(turn.snapshot()).toMatchObject({ status: "stopped", stopReason: "user" });
  });
});
