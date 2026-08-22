import { describe, expect, it } from "vitest";
import { createJoinedRequestLifecycle } from "./joined-request-lifecycle.mjs";

const ORIGIN = "http://127.0.0.1:4175";
const RUNTIME_ORIGIN = "http://127.0.0.1:4176";

function request(url, errorText) {
  return {
    method: () => "GET",
    url: () => url,
    failure: () => errorText === undefined ? null : { errorText },
  };
}

describe("T10 joined first-party request lifecycle", () => {
  it("fails the C20 transition while all six first-party requests remain unsettled", () => {
    const lifecycle = createJoinedRequestLifecycle({ firstPartyOrigins: [ORIGIN, RUNTIME_ORIGIN] });
    lifecycle.begin({ lifecycleId: "joined-alternate-lineage", lifecycleUrl: `${ORIGIN}/replay/save-4?lineage=alternate` });
    const pending = [
      request(`${ORIGIN}/api/save-points/save-4/branches`),
      request(`${ORIGIN}/api/save-points/save-4/branches`),
      request(`${ORIGIN}/api/history`),
      request(`${ORIGIN}/api/comparisons?left=save-4&right=save-5`),
      request(`${ORIGIN}/api/save-points/save-4/media/screenshot`),
      request(`${ORIGIN}/api/save-points/save-5/media/screenshot`),
    ];
    pending.forEach((item) => lifecycle.requestStarted(item));

    expect(() => lifecycle.assertTransitionReady("post-context-close teardown")).toThrow(/6 first-party requests remain pending/u);
    expect(lifecycle.snapshot().pending).toHaveLength(6);
    expect(lifecycle.snapshot().firstPartyRequests).toHaveLength(6);
    expect(lifecycle.snapshot().firstPartyRequests.every(({ state }) => state === "started")).toBe(true);
    expect(new Set(lifecycle.snapshot().pending.map(({ lifecycleId }) => lifecycleId))).toEqual(new Set(["joined-alternate-lineage"]));
    expect(new Set(lifecycle.snapshot().pending.map(({ requestId }) => requestId)).size).toBe(6);
  });

  it("retains genuine aborts and unrelated external network with exact identities", () => {
    const lifecycle = createJoinedRequestLifecycle({ firstPartyOrigins: [ORIGIN, RUNTIME_ORIGIN] });
    lifecycle.begin({ lifecycleId: "joined-comparison", lifecycleUrl: `${ORIGIN}/compare?left=save-4&right=save-5` });
    const aborted = request(`${ORIGIN}/api/unrelated`, "net::ERR_ABORTED");
    const external = request("http://example.test/should-not-leave-loopback");
    lifecycle.requestStarted(aborted);
    lifecycle.requestFailed(aborted);
    lifecycle.requestStarted(external);

    const snapshot = lifecycle.snapshot();
    expect(snapshot.failures).toMatchObject([{ requestId: "joined-request-1", lifecycleId: "joined-comparison", errorText: "net::ERR_ABORTED", classification: "unexpected" }]);
    expect(snapshot.firstPartyRequests).toMatchObject([{ requestId: "joined-request-1", lifecycleId: "joined-comparison", state: "failed" }]);
    expect(snapshot.unexpectedNetwork).toMatchObject([{ requestId: "joined-request-2", lifecycleId: "joined-comparison", url: "http://example.test/should-not-leave-loopback" }]);
    expect(snapshot.classifiedFailures).toEqual([]);
  });
});
