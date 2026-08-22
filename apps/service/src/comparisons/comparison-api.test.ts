import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { ComparisonSideInput } from "@remo/domain";
import { createComparisonApi } from "./comparison-api.js";

const servers: ReturnType<typeof createServer>[] = [];
const side = (savePointId: string): ComparisonSideInput => ({ savePointId, state: "missing", screenshot: { availability: "missing" }, source: { state: "unknown", summary: "Source unavailable" }, decision: { state: "unknown" }, verification: { state: "unknown", summary: "Verification unavailable" }, integrity: { state: "unavailable", explanation: "Unavailable" }, fidelity: { state: "unavailable", explanation: "Unavailable" } });

async function fixture() {
  const api = createComparisonApi({ resolveSide: side });
  const server = createServer((request, response) => { if (!api.handle(request, response)) response.writeHead(404).end(); }); servers.push(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => { for (const server of servers.splice(0)) { server.close(); await once(server, "close"); } });

describe("comparison API", () => {
  it("requires an explicit distinct pair and remains read-only", async () => {
    const origin = await fixture();
    expect((await fetch(`${origin}/api/comparisons`)).status).toBe(400);
    const same = await fetch(`${origin}/api/comparisons?left=save-a&right=save-a`); expect(same.status).toBe(400); expect(await same.json()).toMatchObject({ error: "comparison.same-identity" });
    expect((await fetch(`${origin}/api/comparisons?left=save-a&right=save-b`, { method: "POST" })).status).toBe(405);
  });
  it("returns degraded sides without inventing protected evidence", async () => {
    const response = await fetch(`${await fixture()}/api/comparisons?left=missing-a&right=missing-b`); expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>; expect(body).toMatchObject({ left: { role: "before", state: "missing", screenshot: { availability: "missing" } }, right: { role: "after", state: "missing" }, parityClaimAllowed: false });
    expect(JSON.stringify(body)).not.toContain("blobRef"); expect(JSON.stringify(body)).not.toContain("filesystem");
  });
});
