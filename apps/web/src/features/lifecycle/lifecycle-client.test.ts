// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1/" }
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackLifecycleClient } from "./lifecycle-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("lifecycle client intent idempotency", () => {
  const sessionToken = (): string => randomBytes(32).toString("base64url");
  it("uses a fresh key for each later intent while a retry closure retains its original key", async () => {
    const projection = { subject: "durable", id: "save-t7", turnId: "turn-t7", savePointId: "save-t7", revision: 1, state: "active", createdAt: "2026-08-01T00:00:00.000Z", promotedAt: "2026-08-01T00:00:00.000Z", originalExpiresAt: "2026-08-31T00:00:00.000Z", expiresAt: "2026-08-31T00:00:00.000Z", pinned: false, changed: true };
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(projection), { status: 200 })));
    vi.stubGlobal("fetch", fetch);
    const client = createLoopbackLifecycleClient({ origin: "http://127.0.0.1", sessionToken: sessionToken() });
    const retryPinIntent = () => client.pin("save-t7", "intent-pin-2");

    await client.pin("save-t7", "intent-pin-1");
    await client.unpin("save-t7", false, "intent-unpin-1");
    await retryPinIntent();
    await retryPinIntent();

    const keys = fetch.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>).map((headers) => headers["idempotency-key"]);
    expect(keys).toEqual(["intent-pin-1", "intent-unpin-1", "intent-pin-2", "intent-pin-2"]);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
  });

  it("rejects unsafe caller-supplied intent keys before sending", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = createLoopbackLifecycleClient({ origin: "http://127.0.0.1", sessionToken: sessionToken() });
    await expect(client.pin("save-t7", "pin;whoami")).rejects.toThrow(/intent key/u);
    expect(fetch).not.toHaveBeenCalled();
  });
});
