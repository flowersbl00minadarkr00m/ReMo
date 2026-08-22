import { describe, expect, it } from "vitest";
import {
  buildApprovedLangfuseLink,
  createContractLangfuseFake,
  createLiveLangfuseLookup,
  validateObservationId,
  validateTraceId,
} from "./index.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const OBSERVATION_ID = "0123456789abcdef";

describe("supplied Langfuse anchor", () => {
  it("accepts canonical W3C identifiers and rejects malformed or all-zero values", () => {
    expect(validateTraceId(TRACE_ID)).toBe(TRACE_ID);
    expect(validateObservationId(OBSERVATION_ID)).toBe(OBSERVATION_ID);
    for (const value of ["", "0".repeat(32), "A".repeat(32), "x".repeat(32), `${TRACE_ID}extra`]) {
      expect(() => validateTraceId(value)).toThrow(/W3C trace ID/u);
    }
    for (const value of ["", "0".repeat(16), "A".repeat(16), "x".repeat(16), `${OBSERVATION_ID}0`]) {
      expect(() => validateObservationId(value)).toThrow(/W3C observation ID/u);
    }
  });

  it("builds only allowlisted external links without credentials, query, or fragment", () => {
    expect(buildApprovedLangfuseLink({ baseUrl: "https://traces.example.test/", approvedHosts: ["traces.example.test"], projectId: "project one", traceId: TRACE_ID, observationId: OBSERVATION_ID }))
      .toBe(`https://traces.example.test/project/project%20one/traces/${TRACE_ID}?observation=${OBSERVATION_ID}`);
    expect(() => buildApprovedLangfuseLink({ baseUrl: "https://user:secret@traces.example.test", approvedHosts: ["traces.example.test"], projectId: "p", traceId: TRACE_ID })).toThrow(/credentials/u);
    expect(() => buildApprovedLangfuseLink({ baseUrl: "https://evil.example.test", approvedHosts: ["traces.example.test"], projectId: "p", traceId: TRACE_ID })).toThrow(/approved host/u);
    expect(() => buildApprovedLangfuseLink({ baseUrl: "https://traces.example.test.evil.test", approvedHosts: ["traces.example.test"], projectId: "p", traceId: TRACE_ID })).toThrow(/approved host/u);
    expect(() => buildApprovedLangfuseLink({ baseUrl: "http://traces.example.test", approvedHosts: ["traces.example.test"], projectId: "p", traceId: TRACE_ID })).toThrow(/HTTPS/u);
  });

  it.each([
    ["matching", { status: "matching", metadataTurnId: "turn-1" }],
    ["missing", { status: "missing" }],
    ["unreachable", { status: "unreachable", reasonCode: "trace.authority-unreachable" }],
    ["conflicting", { status: "conflicting", metadataTurnId: "turn-other" }],
  ] as const)("returns the %s contract state without retaining credentials or trace payloads", async (scenario, expected) => {
    const fake = createContractLangfuseFake({ [TRACE_ID]: { ...expected, ignoredFullTracePayload: { secret: "must-not-survive" } } });
    const result = await fake.lookup({ traceId: TRACE_ID, observationId: OBSERVATION_ID, expectedTurnId: "turn-1", credential: "lf-secret-never-store" });
    expect(result).toMatchObject(expected);
    expect(fake.requests()).toEqual([{ traceId: TRACE_ID, observationId: OBSERVATION_ID, expectedTurnId: "turn-1" }]);
    expect(JSON.stringify({ result, requests: fake.requests() })).not.toMatch(/lf-secret|must-not-survive/u);
  });

  it("rejects an oversized declared response before reading the body", async () => {
    let pulled = 0;
    let cancelled = false;
    const response = { status: 200, ok: true, headers: new Headers({ "content-length": "9" }), body: { cancel: () => { cancelled = true; return Promise.resolve(); }, getReader: () => { pulled += 1; throw new Error("reader must not be created"); } } } as unknown as Response;
    const lookup = createLiveLangfuseLookup({ baseUrl: "https://traces.example.test", approvedHosts: ["traces.example.test"], projectId: "remo", maxResponseBytes: 8, fetchImplementation: () => Promise.resolve(response) });
    await expect(lookup.lookup({ traceId: TRACE_ID, expectedTurnId: "turn-1" })).resolves.toMatchObject({ reasonCode: "trace.authority-response-too-large" });
    expect(pulled).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("cancels incremental reading at the hard byte ceiling", async () => {
    let pulls = 0;
    let cancelled = false;
    const reader = { read: () => { pulls += 1; return Promise.resolve({ done: false as const, value: new TextEncoder().encode("12345") }); }, cancel: () => { cancelled = true; return Promise.resolve(); } };
    const response = { status: 200, ok: true, headers: new Headers(), body: { getReader: () => reader } } as unknown as Response;
    const lookup = createLiveLangfuseLookup({ baseUrl: "https://traces.example.test", approvedHosts: ["traces.example.test"], projectId: "remo", maxResponseBytes: 8, fetchImplementation: () => Promise.resolve(response) });
    await expect(lookup.lookup({ traceId: TRACE_ID, expectedTurnId: "turn-1" })).resolves.toMatchObject({ reasonCode: "trace.authority-response-too-large" });
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });
});

const liveConfigured = process.env.REMO_LANGFUSE_OQ002_APPROVED === "1" && process.env.REMO_LANGFUSE_BASE_URL !== undefined && process.env.REMO_LANGFUSE_HOST !== undefined && process.env.REMO_LANGFUSE_PROJECT_ID !== undefined && process.env.REMO_LANGFUSE_TRACE_ID !== undefined && process.env.REMO_LANGFUSE_EXPECTED_TURN_ID !== undefined && process.env.LANGFUSE_SECRET_KEY !== undefined;

describe("optional OQ-002 live contract", () => {
  it.skipIf(!liveConfigured)("reads only bounded correlation metadata from the approved authority", async () => {
    const lookup = createLiveLangfuseLookup({ baseUrl: process.env.REMO_LANGFUSE_BASE_URL!, approvedHosts: [process.env.REMO_LANGFUSE_HOST!], projectId: process.env.REMO_LANGFUSE_PROJECT_ID!, maxResponseBytes: 65_536 });
    const result = await lookup.lookup({ traceId: process.env.REMO_LANGFUSE_TRACE_ID!, expectedTurnId: process.env.REMO_LANGFUSE_EXPECTED_TURN_ID!, credential: process.env.LANGFUSE_SECRET_KEY! });
    expect(["matching", "missing", "unreachable", "conflicting"]).toContain(result.status);
  });
});
