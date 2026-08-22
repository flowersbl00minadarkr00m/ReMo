import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nominateMeaningfulChange } from "../../../../domain/src/capture/nomination.ts";
import { VS001_SCENARIOS } from "./scenarios.mjs";

/** @typedef {ReadonlyMap<string,string>} FixtureTree */
/** @param {FixtureTree} tree */
function digest(tree) {
  const canonical = [...tree.entries()].sort(([left], [right]) => left.localeCompare(right, "en-US"));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** @param {FixtureTree} tree @param {readonly import('../../../../domain/src/capture/nomination.ts').SourceChange[]} changes @returns {FixtureTree} */
function apply(tree, changes) {
  const next = new Map(tree);
  for (const change of changes) {
    const actual = next.get(change.path) ?? "";
    if (actual !== change.before) throw new Error(`Scenario patch preimage mismatch for ${change.path}`);
    if (change.after === "") next.delete(change.path); else next.set(change.path, change.after);
  }
  return next;
}

/** @param {string} [projectRoot] @returns {Promise<FixtureTree>} */
export async function loadFixtureBase(projectRoot = resolve(import.meta.dirname, "../../../../..")) {
  const files = ["FixtureApp.tsx", "styles.css"];
  return new Map(await Promise.all(files.map(async (file) => {
    const path = `packages/test-fixtures/vs001-ui/src/${file}`;
    return [path, await readFile(resolve(projectRoot, path), "utf8")];
  })));
}

/** @param {FixtureTree} tree @param {import('./scenarios.mjs').VS001_SCENARIOS[number]} scenario */
function verifyForward(tree, scenario) {
  const nomination = nominateMeaningfulChange({ changes: scenario.forward, boundaries: [{ kind: "verification", boundaryId: `scenario-${String(scenario.turn).padStart(2, "0")}`, occurredAt: `2026-08-16T08:${String(scenario.turn).padStart(2, "0")}:00.000Z` }], uncertainty: false });
  if (nomination.status !== "candidate") throw new Error(`Scenario ${scenario.turn} did not qualify`);
  for (const category of scenario.requiredCategories) if (!nomination.categories.includes(category)) throw new Error(`Scenario ${scenario.turn} is missing ${category}`);
  const forwardTree = apply(tree, scenario.forward);
  const restoredTree = apply(forwardTree, scenario.inverse);
  if (digest(restoredTree) !== digest(tree)) throw new Error(`Scenario ${scenario.turn} inverse did not restore its preimage`);
  const removed = nominateMeaningfulChange({ changes: [...tree.entries()].map(([path, before]) => ({ path, before, after: restoredTree.get(path) ?? "" })), boundaries: [{ kind: "verification", boundaryId: "inverse", occurredAt: "2026-08-16T09:00:00.000Z" }], uncertainty: false });
  if (removed.status !== "no-candidate") throw new Error(`Scenario ${scenario.turn} inverse left a qualifying change`);
  return { tree: forwardTree, result: { turn: scenario.turn, name: scenario.name, categories: nomination.categories, forwardDigest: digest(forwardTree), restoredDigest: digest(restoredTree) } };
}

/** @param {string} [projectRoot] */
export async function verifyScenarioSequence(projectRoot) {
  const base = await loadFixtureBase(projectRoot);
  const baseDigest = digest(base);
  let current = base;
  const results = [];
  for (const scenario of VS001_SCENARIOS) { const verified = verifyForward(current, scenario); current = verified.tree; results.push(verified.result); }
  const finalDigest = digest(current);
  for (const scenario of [...VS001_SCENARIOS].reverse()) current = apply(current, scenario.inverse);
  const reverseDigest = digest(current);
  if (reverseDigest !== baseDigest) throw new Error("Full reverse sequence did not restore the exact base digest");
  return { version: "vs001-scenarios-v1", baseDigest, finalDigest, reverseDigest, scenarios: results };
}
