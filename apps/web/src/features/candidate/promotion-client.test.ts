import { describe, expect, it, vi } from "vitest";
import { PromotionClientError, createLoopbackPromotionClient } from "./promotion-client.js";

describe("browser-safe promotion client", () => {
  const intent = { status: "ready-for-durable-promotion", turnId: "01J000000000000000000000T4", savePointId: "01J000000000000000000000S5", candidateRevision: 1, candidateManifestDigest: `sha256:${"b".repeat(64)}` } as const;

  it("sends only explicit confirmation and returns the service durable projection", async () => {
    const response = { status: "durable", turnId: "01J000000000000000000000T4", savePointId: "01J000000000000000000000S5", revision: 1, manifestDigest: `sha256:${"a".repeat(64)}`, createdAt: "2026-08-16T07:30:00.000Z", promotedAt: "2026-08-16T08:00:00.000Z", expiresAt: "2026-09-15T08:00:00.000Z", pinned: false, health: "complete", fidelity: "editable-eligible" } as const;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createLoopbackPromotionClient({ origin: "http://127.0.0.1:4174", sessionToken: "test-session-token", fetcher });
    await expect(client.promote(intent)).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:4174/api/candidates/${response.turnId}/promote`, expect.objectContaining({ method: "POST", body: JSON.stringify({ confirm: true, savePointId: intent.savePointId, candidateRevision: intent.candidateRevision, candidateManifestDigest: intent.candidateManifestDigest }), credentials: "same-origin" }));
  });

  it("returns a retryable typed failure without upgrading service results", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "failed", code: "promotion.local-write-failed", message: "Local write failed.", retryable: true }), { status: 503, headers: { "content-type": "application/json" } }));
    const client = createLoopbackPromotionClient({ origin: "http://127.0.0.1:4174", sessionToken: "test-session-token", fetcher });
    const error = await client.promote(intent).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PromotionClientError);
    expect(error).toMatchObject({ code: "promotion.local-write-failed", retryable: true });
  });
});
