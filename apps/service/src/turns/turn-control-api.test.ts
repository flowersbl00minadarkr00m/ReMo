import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTurnControlApi, type SettlingTurn } from "./turn-control-api.js";

let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => { await closeServer?.(); closeServer = undefined; });

describe("loopback turn control API", () => {
  it("requires exact loopback, allowed Origin, ephemeral token, and known turn", async () => {
    const stop = vi.fn(() => Promise.resolve({ status: "no-candidate" as const }));
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeServer = async () => { server.close(); await once(server, "close"); };
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing loopback address");
    const origin = `http://127.0.0.1:${address.port}`;
    const api = createTurnControlApi({ allowedOrigin: origin });
    server.on("request", (request, response) => void api.handle(request, response));
    api.register("turn-3", { stop } satisfies SettlingTurn);

    const rejected = await fetch(`${origin}/api/turns/turn-3/stop`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
    expect(rejected.status).toBe(401);
    const wrongOrigin = await fetch(`${origin}/api/turns/turn-3/stop`, { method: "POST", headers: { origin: "http://127.0.0.1:9", "content-type": "application/json", "x-remo-session-token": api.sessionToken }, body: "{}" });
    expect(wrongOrigin.status).toBe(403);
    const accepted = await fetch(`${origin}/api/turns/turn-3/stop`, { method: "POST", headers: { origin, "content-type": "application/json", "x-remo-session-token": api.sessionToken }, body: JSON.stringify({ boundaries: [] }) });
    expect(accepted.status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(accepted.headers.has("access-control-allow-origin")).toBe(false);
  });
});
