import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateHostedDemoFixture } from "./hosted-demo-fixture.js";
import {
  createHostedDemoComparisonClient,
  createHostedDemoDecisionClient,
} from "./hosted-demo-decision-comparison.js";

const publicRoot = resolve(import.meta.dirname, "../../../public/hosted-demo");
const manifest = JSON.parse(readFileSync(resolve(publicRoot, "fixture-manifest.json"), "utf8")) as unknown;
const fixtureText = readFileSync(resolve(publicRoot, "fixture.json"), "utf8");
const fixture = validateHostedDemoFixture(manifest, fixtureText);
const projections = () => ({
  fixtureRevision: fixture.fixtureRevision,
  media: structuredClone(fixture.media),
  decisionsBySavePointId: structuredClone(fixture.decisionsBySavePointId),
  comparisonsByPair: structuredClone(fixture.comparisonsByPair),
  preflight: structuredClone(fixture.preflight),
  simulatedBranch: structuredClone(fixture.simulatedBranch),
});

describe("hosted T3 fixture authority and no-fetch adapters", () => {
  it("exposes the exact human-provenance Turn 4 decision without inventing rationale", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const projection = await createHostedDemoDecisionClient(fixture).read("demo-save-04");
    expect(projection?.current).toMatchObject({
      savePointId: "demo-save-04",
      turnId: "demo-turn-04",
      revision: 1,
      question: { value: "Should the navigation hierarchy change at this boundary?", provenance: "user-supplied" },
      selectedOptionId: { value: "adopt", provenance: "user-supplied" },
      owner: { value: "UI supervisor", provenance: "user-supplied" },
      uncertainty: { value: { level: "low", source: "human" }, provenance: "user-supplied" },
      outcome: { provenance: "unknown" },
    });
    expect(projection?.current.options.value).toEqual([
      { id: "adopt", label: "Adopt the revised hierarchy" },
      { id: "retain", label: "Keep the prior hierarchy" },
    ]);
    expect(projection?.current.evidenceComponentIds).toEqual(["demo-turn-04:rrweb", "demo-turn-04:screenshot"]);
    expect(projection?.revisions).toHaveLength(1);
    expect(await createHostedDemoDecisionClient(fixture).read("demo-save-05")).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("allows only the exact Turn 4 before and Turn 5 after pair and returns defensive projections", async () => {
    const client = createHostedDemoComparisonClient(fixture);
    const controller = new AbortController();
    const history = await client.history(controller.signal);
    expect(history).not.toBe(fixture.history);
    expect(Object.isFrozen(history)).toBe(true);
    const comparison = await client.compare("demo-save-04", "demo-save-05", controller.signal);
    expect(comparison.left).toMatchObject({ role: "before", savePointId: "demo-save-04", turnId: "demo-turn-04", screenshot: { availability: "available", componentId: "demo-turn-04:screenshot" } });
    expect(comparison.right).toMatchObject({ role: "after", savePointId: "demo-save-05", turnId: "demo-turn-05", screenshot: { availability: "available", componentId: "demo-turn-05:screenshot" } });
    expect(comparison.parityClaimAllowed).toBe(false);
    expect(comparison.qualifiers).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "blocks-equivalence" })]));
    await expect(client.compare("demo-save-05", "demo-save-04", controller.signal)).rejects.toThrow(/exact manifest-bound comparison pair is unavailable/iu);
    await expect(client.compare("demo-save-04", "demo-save-99", controller.signal)).rejects.toThrow(/exact manifest-bound comparison pair is unavailable/iu);
  });

  it("honors aborts and rejects decision mutation in the read-only hosted boundary", async () => {
    const controller = new AbortController();
    controller.abort();
    const decision = createHostedDemoDecisionClient(fixture);
    const comparison = createHostedDemoComparisonClient(fixture);
    await expect(decision.read("demo-save-04", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(comparison.history(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(comparison.compare("demo-save-04", "demo-save-05", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(decision.createCandidate("demo-turn-04", { expectedCandidateRevision: 1, expectedCandidateManifestDigest: `sha256:${"a".repeat(64)}`, decisionId: "blocked", content: {} })).rejects.toThrow(/read-only/iu);
    await expect(decision.revise("demo-save-04", { expectedRevision: 1, mutation: "confirm-inferred", fields: ["expectedEffect"] })).rejects.toThrow(/read-only/iu);
  });

  it("fails closed on mismatched decision identity, pair identity, or comparison evidence", () => {
    const decisionMismatch = projections() as unknown as { decisionsBySavePointId: { "demo-save-04": { current: { turnId: string } } } };
    decisionMismatch.decisionsBySavePointId["demo-save-04"].current.turnId = "demo-turn-05";
    expect(() => validateHostedDemoFixture(manifest, fixtureText, decisionMismatch)).toThrow(/decision|media binding/iu);

    const pairMismatch = projections() as unknown as { comparisonsByPair: { "demo-save-04::demo-save-05": { right: { savePointId: string } } } };
    pairMismatch.comparisonsByPair["demo-save-04::demo-save-05"].right.savePointId = "demo-save-09";
    expect(() => validateHostedDemoFixture(manifest, fixtureText, pairMismatch)).toThrow(/comparison identity|projection|replay path/iu);

    const screenshotMismatch = projections() as unknown as { comparisonsByPair: { "demo-save-04::demo-save-05": { right: { screenshot: { digest: string } } } } };
    screenshotMismatch.comparisonsByPair["demo-save-04::demo-save-05"].right.screenshot.digest = `sha256:${"0".repeat(64)}`;
    expect(() => validateHostedDemoFixture(manifest, fixtureText, screenshotMismatch)).toThrow(/screenshot|comparison/iu);
  });

  it("rejects media, preflight, and branch drift at the same unified validation boundary", () => {
    const mediaMismatch = projections() as unknown as { media: { kind: string; digest: string }[] };
    mediaMismatch.media.find(({ kind }) => kind === "replay")!.digest = `sha256:${"0".repeat(64)}`;
    expect(() => validateHostedDemoFixture(manifest, fixtureText, mediaMismatch)).toThrow(/immutable revision/u);

    const preflightMismatch = projections() as unknown as { preflight: { evaluatedAt: string } };
    preflightMismatch.preflight.evaluatedAt = "2030-01-01T00:00:01.000Z";
    expect(() => validateHostedDemoFixture(manifest, fixtureText, preflightMismatch)).toThrow(/digest|receipt|immutable revision/u);

    const branchMismatch = projections() as unknown as { simulatedBranch: { updatedAt: string } };
    branchMismatch.simulatedBranch.updatedAt = "2026-08-20T12:04:31.000Z";
    expect(() => validateHostedDemoFixture(manifest, fixtureText, branchMismatch)).toThrow(/immutable revision/u);
  });
});
