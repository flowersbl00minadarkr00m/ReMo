// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1/" }
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackReconcileClient } from "./save-point-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("loopback reconciliation client", () => {
  it("posts only the stable save identity with a deterministic idempotency key", async () => {
    const projection = { savePointId: "01J000000000000000000000S6", stablePath: "/save-points/01J000000000000000000000S6" };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(projection), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createLoopbackReconcileClient({ origin: "http://127.0.0.1", sessionToken: "session-token-at-least-thirty-two-characters" });
    await expect(client.reconcile("01J000000000000000000000S6")).resolves.toMatchObject(projection);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("http://127.0.0.1/api/save-points/01J000000000000000000000S6/reconcile");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(headers["idempotency-key"]).toBe("reconcile-01J000000000000000000000S6");
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/rrweb|screenshot|decision|blobRef|tracePayload/u);
  });

  it("rejects a successful response that attempts to replace the requested identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ savePointId: "another-save", stablePath: "/save-points/another-save" }), { status: 200 })));
    const client = createLoopbackReconcileClient({ origin: "http://127.0.0.1", sessionToken: "session-token-at-least-thirty-two-characters" });
    await expect(client.reconcile("01J000000000000000000000S6")).rejects.toThrow(/identity/u);
  });

  it("rejects non-loopback origins and injection-shaped identities", async () => {
    expect(() => createLoopbackReconcileClient({ origin: "https://example.test", sessionToken: "session-token-at-least-thirty-two-characters" })).toThrow(/loopback/u);
    const client = createLoopbackReconcileClient({ origin: "http://127.0.0.1", sessionToken: "session-token-at-least-thirty-two-characters" });
    await expect(client.reconcile("save;whoami")).rejects.toThrow(/identity/u);
  });
});
