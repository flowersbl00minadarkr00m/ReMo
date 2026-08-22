import { describe, expect, it, vi } from "vitest";
import { buildComparisonProjection, type ComparisonSideInput } from "@remo/domain/browser";
import { createLoopbackComparisonClient } from "./comparison-client.js";

const side = (savePointId: string): ComparisonSideInput => ({ savePointId, state: "missing", screenshot: { availability: "missing" }, source: { state: "unknown", summary: "Unknown" }, decision: { state: "unknown" }, verification: { state: "unknown", summary: "Unknown" }, integrity: { state: "unavailable", explanation: "Unknown" }, fidelity: { state: "unavailable", explanation: "Unknown" } });

describe("comparison client", () => {
  it("uses encoded explicit identities and validates the canonical projection", async () => {
    const projection = buildComparisonProjection(side("save-a"), side("save-b"));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(projection), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(createLoopbackComparisonClient({ origin: "http://127.0.0.1:4175", fetcher }).compare("save-a", "save-b", new AbortController().signal)).resolves.toEqual(projection);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4175/api/comparisons?left=save-a&right=save-b");
  });
  it("surfaces a same-identity rejection without treating it as a projection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "comparison.same-identity", message: "Choose distinct save points." }), { status: 400, headers: { "content-type": "application/json" } }));
    await expect(createLoopbackComparisonClient({ origin: "http://127.0.0.1:4175", fetcher }).compare("same", "same", new AbortController().signal)).rejects.toMatchObject({ code: "comparison.same-identity" });
  });
});
