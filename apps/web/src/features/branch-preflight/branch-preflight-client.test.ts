import { describe, expect, it, vi } from "vitest";
import { createLoopbackBranchPreflightClient } from "./branch-preflight-client.js";

describe("branch preflight client", () => {
  it("uses authenticated same-origin POST, exact revision binding, and caller cancellation", async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST"); expect(init?.credentials).toBe("same-origin"); expect(init?.headers).toMatchObject({ "x-remo-session-token": "token" }); expect(init?.body).toBe("{\"savePointRevision\":3}"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response("{}", { status: 500, headers: { "content-type": "application/json" } }));
    });
    const client = createLoopbackBranchPreflightClient({ origin: "http://127.0.0.1:4175", sessionToken: "token", fetcher: fetcher as typeof fetch });
    await expect(client.preflight("save-1", 3, new AbortController().signal)).rejects.toThrow(/preflight/u);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
