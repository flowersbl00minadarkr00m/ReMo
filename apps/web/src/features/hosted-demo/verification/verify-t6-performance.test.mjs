import { describe, expect, it } from "vitest";
import { URL } from "node:url";

import {
  claimControlledProfileOwnership,
  consumeProfileHandoff,
  CONTROLLED_PROFILE_DESTINATION,
  CONTROLLED_PROFILE_DEADLINE_MS,
  createProfileDeadline,
  decodeProfileHandoff,
  deriveControlledProfileVerdict,
  nearestRankPercentile,
  PROFILE_HANDOFF_PREFIX,
  runPredeterminedSamples,
  teardownControlledProfileResources,
  validateCompletedMeasurement,
} from "./verify-t6-performance.mjs";

const attemptId = "12345678-1234-4234-8234-123456789abc";

const twentyFastSamples = Array.from({ length: 20 }, (_, index) => ({
  sample: index + 1,
  browserDurationMs: 100 + index,
  driverWallMs: 130 + index,
  settledWallMs: 160 + index,
  clickMark: 10,
  paintMark: 110 + index,
  target: "Choose the consequential turn",
  paintBoundary: "double-requestAnimationFrame",
}));

describe("REL-001 T6 controlled comparison profile", () => {
  it("uses deterministic nearest-rank p95 and accepts the exact 250 ms boundary", () => {
    expect(nearestRankPercentile([5, 1, 4, 2, 3], 0.95)).toMatchObject({ rank: 5, value: 5, orderedValues: [1, 2, 3, 4, 5] });
    const samples = twentyFastSamples.map((sample, index) => ({ ...sample, browserDurationMs: index === 18 ? 250 : index === 19 ? 900 : 100 }));
    expect(deriveControlledProfileVerdict({ samples, ownership: { established: true }, lifecycleChannels: {} })).toMatchObject({ verdict: "PASS", p95: { rank: 19, value: 250 } });
  });

  it("does not let one fast sample pass an otherwise slow set", () => {
    const samples = twentyFastSamples.map((sample, index) => ({ ...sample, browserDurationMs: index === 0 ? 1 : 251 }));
    expect(deriveControlledProfileVerdict({ samples, ownership: { established: true }, lifecycleChannels: {} })).toMatchObject({ verdict: "FAIL", p95: { value: 251 } });
  });

  it("keeps injected driver delay diagnostic-only", async () => {
    const withoutDelay = await runPredeterminedSamples({
      sampleCount: 20,
      warmUp: async () => ({ kind: "warm-up" }),
      sample: async ({ sample }) => ({ ...twentyFastSamples[sample - 1] }),
    });
    const withDelay = await runPredeterminedSamples({
      sampleCount: 20,
      warmUp: async () => ({ kind: "warm-up" }),
      sample: async ({ sample }) => ({ ...twentyFastSamples[sample - 1], driverWallMs: twentyFastSamples[sample - 1].driverWallMs + 5_000 }),
    });
    expect(withDelay.samples.map(({ browserDurationMs }) => browserDurationMs)).toEqual(withoutDelay.samples.map(({ browserDurationMs }) => browserDurationMs));
    expect(withDelay.samples.map(({ driverWallMs }) => driverWallMs)).not.toEqual(withoutDelay.samples.map(({ driverWallMs }) => driverWallMs));
    expect(deriveControlledProfileVerdict({ samples: withDelay.samples, ownership: { established: true }, lifecycleChannels: {} }).verdict).toBe("PASS");
  });

  it.each([
    ["click mark", { clickMark: undefined }],
    ["paint completion", { paintMark: undefined }],
    ["semantic target", { target: undefined }],
    ["double paint boundary", { paintBoundary: undefined }],
  ])("fails closed on a missing %s", (_label, patch) => {
    const samples = twentyFastSamples.map((sample, index) => index === 3 ? { ...sample, ...patch } : sample);
    expect(deriveControlledProfileVerdict({ samples, ownership: { established: true }, lifecycleChannels: {} })).toMatchObject({ verdict: "FAIL" });
  });

  it("fails ownership conflict and incomplete sample sets", () => {
    const registry = new Set(["rel001-t6-controlled-profile"]);
    expect(() => claimControlledProfileOwnership(registry, "rel001-t6-controlled-profile")).toThrow(/ownership conflict/iu);
    expect(deriveControlledProfileVerdict({ samples: twentyFastSamples.slice(0, 19), ownership: { established: true }, lifecycleChannels: {} })).toMatchObject({ verdict: "FAIL" });
    expect(deriveControlledProfileVerdict({ samples: twentyFastSamples, ownership: { established: false }, lifecycleChannels: {} })).toMatchObject({ verdict: "FAIL" });
  });

  it("fails every lifecycle channel and preserves raw samples plus diagnostics in PASS and FAIL derivation", () => {
    for (const channel of ["requestFailures", "pendingRequests", "unexpectedRequests", "integrityFailures", "consoleErrors", "pageErrors", "serverErrors"]) {
      const result = deriveControlledProfileVerdict({ samples: twentyFastSamples, ownership: { established: true }, lifecycleChannels: { [channel]: [{ error: channel }] } });
      expect(result).toMatchObject({ verdict: "FAIL", samples: twentyFastSamples });
      expect(result.samples[0]).toMatchObject({ browserDurationMs: 100, driverWallMs: 130, settledWallMs: 160 });
    }
    expect(deriveControlledProfileVerdict({ samples: twentyFastSamples, ownership: { established: true }, lifecycleChannels: {} })).toMatchObject({ verdict: "PASS", samples: twentyFastSamples });
  });

  it("preserves the overall deadline as primary over setup and teardown errors", () => {
    const result = deriveControlledProfileVerdict({
      samples: [],
      ownership: { established: true },
      warmUp: { kind: "warm-up", error: "page closed during watchdog teardown" },
      lifecycleChannels: {
        deadlineErrors: [{ limitMs: 120_000, error: "deadline" }],
        setupErrors: [{ error: "page closed" }],
        teardownErrors: [{ resource: "context", error: "close failed" }],
      },
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.errors[0]).toMatch(/deadlineErrors/iu);
    expect(result.errors.join(" ")).toMatch(/incomplete controlled sample set/iu);
  });

  it("runs one declared warm-up followed by exactly twenty predetermined non-adaptive samples", async () => {
    const calls = [];
    const result = await runPredeterminedSamples({
      sampleCount: 20,
      warmUp: async () => { calls.push("warm-up"); return { kind: "warm-up", browserDurationMs: 99 }; },
      sample: async ({ sample }) => { calls.push(sample); return { ...twentyFastSamples[sample - 1] }; },
    });
    expect(calls).toEqual(["warm-up", ...Array.from({ length: 20 }, (_, index) => index + 1)]);
    expect(result).toMatchObject({ warmUp: { kind: "warm-up" }, samples: twentyFastSamples });
  });

  it("fails closed without repeated attempts when warm-up or a predetermined sample cannot be established", async () => {
    const warmUpFailure = await runPredeterminedSamples({
      sampleCount: 20,
      warmUp: async () => { throw new Error("missing paint"); },
      sample: async () => { throw new Error("must not run"); },
    });
    expect(warmUpFailure).toMatchObject({ warmUp: { error: "missing paint" }, samples: [] });

    const calls = [];
    const sampleFailure = await runPredeterminedSamples({
      sampleCount: 20,
      warmUp: async () => ({ kind: "warm-up" }),
      sample: async ({ sample }) => {
        calls.push(sample);
        if (sample === 3) throw new Error("ownership lost");
        return { ...twentyFastSamples[sample - 1] };
      },
    });
    expect(calls).toEqual([1, 2, 3]);
    expect(sampleFailure.samples).toHaveLength(3);
    expect(sampleFailure.samples[2]).toMatchObject({ sample: 3, error: "ownership lost" });
  });

  it("enforces one explicit bounded overall deadline and supports deterministic cancellation", async () => {
    let scheduled;
    let scheduledMs;
    let cancelled;
    let expirations = 0;
    const deadline = createProfileDeadline({
      onExpire: () => { expirations += 1; },
      schedule: (callback, milliseconds) => { scheduled = callback; scheduledMs = milliseconds; return "deadline-token"; },
      cancel: (handle) => { cancelled = handle; },
    });
    expect(scheduledMs).toBe(CONTROLLED_PROFILE_DEADLINE_MS);
    expect(deadline.expired).toBe(false);
    scheduled();
    expect(deadline.expired).toBe(true);
    await deadline.expiration;
    expect(expirations).toBe(1);
    deadline.cancel();
    expect(cancelled).toBe("deadline-token");

    let cancelledCallback;
    const cancelledDeadline = createProfileDeadline({
      onExpire: () => { expirations += 1; },
      schedule: (callback) => { cancelledCallback = callback; return "cancelled-token"; },
      cancel: () => undefined,
    });
    cancelledDeadline.cancel();
    cancelledCallback();
    expect(expirations).toBe(1);
  });

  it("rejects the destroyed-document legacy mark and accepts the exact cross-document handoff", () => {
    const legacy = `${PROFILE_HANDOFF_PREFIX}${JSON.stringify({ sample: 7, clickMark: 123_456.25, phase: "activated" })}`;
    expect(decodeProfileHandoff(legacy)).toBeUndefined();

    const encoded = `${PROFILE_HANDOFF_PREFIX}${JSON.stringify({ sample: 7, clickMark: 123_456.25, phase: "activated", attemptId, destination: CONTROLLED_PROFILE_DESTINATION })}`;
    expect(decodeProfileHandoff(encoded, {
      expectedSample: 7,
      expectedAttemptId: attemptId,
      expectedDestination: CONTROLLED_PROFILE_DESTINATION,
    })).toEqual({ sample: 7, clickMark: 123_456.25, phase: "activated", attemptId, destination: CONTROLLED_PROFILE_DESTINATION });
    expect(decodeProfileHandoff(`${PROFILE_HANDOFF_PREFIX}${JSON.stringify({ sample: 7, clickMark: null, phase: "activated", attemptId, destination: CONTROLLED_PROFILE_DESTINATION })}`)).toBeUndefined();
  });

  it("fails closed for malformed, stale/preseeded, mismatched sample, phase, attempt, and destination handoffs and clears every consumed value", () => {
    const valid = `${PROFILE_HANDOFF_PREFIX}${JSON.stringify({ sample: 7, clickMark: 123_456.25, phase: "activated", attemptId, destination: CONTROLLED_PROFILE_DESTINATION })}`;
    const exact = { prefix: PROFILE_HANDOFF_PREFIX, maxSample: 20, expectedSample: 7, expectedAttemptId: attemptId, expectedDestination: CONTROLLED_PROFILE_DESTINATION };
    for (const [value, options] of [
      [`${PROFILE_HANDOFF_PREFIX}{bad-json`, exact],
      [`${PROFILE_HANDOFF_PREFIX}${JSON.stringify({ sample: 7, clickMark: 123_456.25, phase: "complete", attemptId, destination: CONTROLLED_PROFILE_DESTINATION })}`, exact],
      [valid, { ...exact, expectedSample: 8 }],
      [valid, { ...exact, expectedAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      [valid, { ...exact, expectedDestination: "/wrong" }],
    ]) {
      const fakeWindow = { name: value };
      const decoded = consumeProfileHandoff(fakeWindow, options);
      expect(decoded).toBeUndefined();
      expect(fakeWindow.name).toBe("");
    }
    const unrelated = { name: "preserve unrelated window name" };
    expect(consumeProfileHandoff(unrelated, { prefix: PROFILE_HANDOFF_PREFIX, maxSample: 20 })).toBeUndefined();
    expect(unrelated.name).toBe("preserve unrelated window name");
  });

  it("requires exact completed sample, attempt, destination, semantic target, and paint marks", () => {
    const measurement = {
      sample: 7,
      attemptId,
      destination: CONTROLLED_PROFILE_DESTINATION,
      phase: "complete",
      target: "Choose the consequential turn",
      paintBoundary: "double-requestAnimationFrame",
      clickMark: 123_456.25,
      paintMark: 123_556.25,
      browserDurationMs: 100,
      complete: true,
    };
    expect(validateCompletedMeasurement(measurement, { sample: 7, attemptId, destination: CONTROLLED_PROFILE_DESTINATION })).toBe(measurement);
    for (const [field, value] of [["sample", 8], ["attemptId", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], ["destination", "/wrong"], ["phase", "activated"], ["target", "wrong"], ["paintMark", 1]]) {
      expect(() => validateCompletedMeasurement({ ...measurement, [field]: value }, { sample: 7, attemptId, destination: CONTROLLED_PROFILE_DESTINATION })).toThrow(/invalid completed/iu);
    }
  });

  it("tears down every owned resource, clears handoff state, releases ownership, and preserves teardown errors", async () => {
    const calls = [];
    const result = await teardownControlledProfileResources({
      page: { close: async () => { calls.push("page"); } },
      context: { close: async () => { calls.push("context"); throw new Error("context teardown"); } },
      browser: { close: async () => { calls.push("browser"); } },
      server: { close: async () => { calls.push("server"); } },
      ownership: { release: () => { calls.push("ownership"); } },
      clearHandoff: async () => { calls.push("handoff"); },
    });
    expect(calls).toEqual(["handoff", "page", "context", "browser", "server", "ownership"]);
    expect(result).toEqual([{ resource: "context", error: "context teardown" }]);
  });

  it("makes watchdog expiration await active owned-resource teardown", async () => {
    let expire;
    const calls = [];
    const deadline = createProfileDeadline({
      schedule: (callback) => { expire = callback; return "watchdog"; },
      cancel: () => undefined,
      onExpire: () => teardownControlledProfileResources({
        page: { close: async () => { calls.push("page"); } },
        context: { close: async () => { calls.push("context"); } },
        browser: { close: async () => { calls.push("browser"); } },
        server: { close: async () => { calls.push("server"); } },
        ownership: { release: () => { calls.push("ownership"); } },
        clearHandoff: async () => { calls.push("handoff"); },
      }),
    });
    expire();
    await deadline.expiration;
    expect(calls).toEqual(["handoff", "page", "context", "browser", "server", "ownership"]);
  });
});

describe("REL-001 T6 joined verifier regression anchors", () => {
  it("keeps replay restart paused and records both timing channels in the ledger", async () => {
    const verifier = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./verify-t5.mjs", import.meta.url), "utf8"));
    expect(verifier).toMatch(/Restart[\s\S]*Replay paused/u);
    expect(verifier).toContain("controlledComparisonProfile");
    expect(verifier).not.toMatch(/comparisonTransitionMs\s*<=\s*250/u);
  });

  it("installs new-document paint observation before the activating navigation", async () => {
    const profile = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./verify-t6-performance.mjs", import.meta.url), "utf8"));
    expect(profile).toContain("context.addInitScript");
    expect(profile).toContain("performance.timeOrigin + performance.now()");
    expect(profile).toContain("window.name");
  });
});
