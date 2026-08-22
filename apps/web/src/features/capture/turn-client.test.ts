// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createLoopbackTurnClient } from "./turn-client.js";

describe("same-origin turn Stop client", () => {
  it("uses the exact same-origin route and ephemeral token", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ status: "no-candidate" }), { status: 200, headers: { "content-type": "application/json" } })));
    const client = createLoopbackTurnClient({ origin: "http://127.0.0.1:4174", turnId: "turn-3", sessionToken: "ephemeral-test-token", fetcher });
    await client.stop([{ kind: "human-intervention", boundaryId: "user-stop", occurredAt: "2026-08-16T06:00:00.000Z" }]);
    const call = fetcher.mock.calls[0];
    if (call === undefined) throw new Error("Stop request was not sent");
    const [url, init] = call;
    expect(url).toBe("http://127.0.0.1:4174/api/turns/turn-3/stop");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toEqual({ "content-type": "application/json", "x-remo-session-token": "ephemeral-test-token" });
  });

  it("rejects a non-loopback origin and reports a failed response", async () => {
    expect(() => createLoopbackTurnClient({ origin: "https://remo.example", turnId: "turn-3", sessionToken: "token", fetcher: vi.fn() })).toThrow("loopback");
    const client = createLoopbackTurnClient({ origin: "http://127.0.0.1:4174", turnId: "turn-3", sessionToken: "ephemeral-token", fetcher: vi.fn(() => Promise.resolve(new Response("failure", { status: 503 }))) });
    await expect(client.stop([])).rejects.toThrow("Stop could not be confirmed");
  });
});
