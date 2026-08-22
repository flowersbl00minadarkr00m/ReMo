import { describe, expect, it } from "vitest";
import { createNavigationRequestLifecycle, isCausallyBoundNavigationMediaFailure } from "./navigation-request-lifecycle.mjs";

describe("S-002 durable navigation request lifecycle", () => {
  it("retains navigation identity after document load until application media settles", () => {
    const lifecycle = createNavigationRequestLifecycle();
    const navigation = { navigationId: "s002-320-turn-4", url: "http://127.0.0.1:4175/replay/save-4" };
    lifecycle.begin(navigation);
    lifecycle.documentLoaded(navigation.navigationId);
    expect(lifecycle.current()).toEqual(navigation);
    lifecycle.settle(navigation.navigationId);
    expect(lifecycle.current()).toBeUndefined();
  });

  it.each(["screenshot", "rrweb"])("causally binds late %s abort diagnostics from their durable request binding", (role) => {
    const navigation = { navigationId: "s002-320-turn-4", url: "http://127.0.0.1:4175/replay/save-4" };
    expect(isCausallyBoundNavigationMediaFailure({
      binding: { requestId: `request-${role}`, navigationId: navigation.navigationId, navigationUrl: navigation.url },
      method: "GET",
      url: `http://127.0.0.1:4175/api/save-points/save-4/media/${role}`,
      errorText: "net::ERR_ABORTED",
    })).toBe(true);
  });

  it("does not reinterpret an unbound media abort as navigation-caused", () => {
    expect(isCausallyBoundNavigationMediaFailure({
      binding: { requestId: "request-unbound" },
      method: "GET",
      url: "http://127.0.0.1:4175/api/save-points/save-4/media/screenshot",
      errorText: "net::ERR_ABORTED",
    })).toBe(false);
  });
});
