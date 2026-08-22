import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HostedDemoDetailLoader, HostedDemoHistoryClient } from "./hosted-demo-clients.js";
import { validateHostedDemoFixture } from "./hosted-demo-fixture.js";

const publicRoot = resolve(import.meta.dirname, "../../../public/hosted-demo");
const fixture = validateHostedDemoFixture(
  JSON.parse(readFileSync(resolve(publicRoot, "fixture-manifest.json"), "utf8")) as unknown,
  readFileSync(resolve(publicRoot, "fixture.json"), "utf8"),
);

describe("hosted demo no-fetch adapters", () => {
  it("returns independent deeply immutable history projections without fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const client = new HostedDemoHistoryClient(fixture);
    const first = await client.list();
    const second = await client.list();
    expect(first).not.toBe(second);
    expect(first.anchors).not.toBe(second.anchors);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.anchors[0])).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("honors abort signals and rejects unknown or tombstone detail identities", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new HostedDemoHistoryClient(fixture).list(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const loader = new HostedDemoDetailLoader(fixture);
    await expect(loader.load("demo-save-04")).resolves.toMatchObject({ savePointId: "demo-save-04", turnId: "demo-turn-04" });
    await expect(loader.load("demo-save-06")).rejects.toThrow(/unavailable/u);
    await expect(loader.load("unknown-save-point")).rejects.toThrow(/unavailable/u);
    await expect(loader.load("demo-save-04", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
