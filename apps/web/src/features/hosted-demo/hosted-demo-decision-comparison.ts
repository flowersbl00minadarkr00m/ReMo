import type { ComparisonProjection, HistoryPage } from "@remo/domain/browser";
import type { ComparisonClient } from "../comparison/comparison-client.js";
import type { CandidateDecisionInput, DecisionClient, DecisionProjection, DecisionRevisionInput } from "../decision-card/decision-client.js";
import type { HostedDemoFixtureBundle } from "./hosted-demo-fixture.js";
import { HOSTED_DEMO_COMPARISON_KEY, HOSTED_DEMO_COMPARISON_PAIR } from "./hosted-demo-fixture-source.js";

export { HOSTED_DEMO_COMPARISON_PAIR } from "./hosted-demo-fixture-source.js";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function abortError(): Error {
  return typeof DOMException === "undefined" ? Object.assign(new Error("The hosted demo request was aborted."), { name: "AbortError" }) : new DOMException("The hosted demo request was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError();
}

async function settledCopy<T>(value: T, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  await Promise.resolve();
  throwIfAborted(signal);
  return immutableClone(value);
}

const readOnlyError = (): Error => new Error("The hosted decision fixture is read-only.");

export function createHostedDemoDecisionClient(fixture: HostedDemoFixtureBundle): DecisionClient {
  const decision = fixture.decisionsBySavePointId[HOSTED_DEMO_COMPARISON_PAIR.left];
  if (decision === undefined) throw new TypeError("The validated hosted decision projection is unavailable.");
  return {
    createCandidate(turnId: string, input: CandidateDecisionInput) { void turnId; void input; return Promise.reject(readOnlyError()); },
    readCandidate(_turnId: string, signal?: AbortSignal) { return settledCopy<DecisionProjection | undefined>(undefined, signal); },
    read(savePointId: string, signal?: AbortSignal) { return settledCopy<DecisionProjection | undefined>(savePointId === HOSTED_DEMO_COMPARISON_PAIR.left ? decision : undefined, signal); },
    revise(savePointId: string, input: DecisionRevisionInput) { void savePointId; void input; return Promise.reject(readOnlyError()); },
  };
}

export function createHostedDemoComparisonClient(fixture: HostedDemoFixtureBundle): ComparisonClient {
  const comparison = fixture.comparisonsByPair[HOSTED_DEMO_COMPARISON_KEY];
  if (comparison === undefined) throw new TypeError("The validated hosted comparison projection is unavailable.");
  return {
    history(signal: AbortSignal): Promise<HistoryPage> { return settledCopy(fixture.history, signal); },
    async compare(left: string, right: string, signal: AbortSignal): Promise<ComparisonProjection> {
      throwIfAborted(signal);
      if (left !== HOSTED_DEMO_COMPARISON_PAIR.left || right !== HOSTED_DEMO_COMPARISON_PAIR.right) throw new Error("The exact manifest-bound comparison pair is unavailable. No alternate pair was inferred.");
      return settledCopy(comparison, signal);
    },
  };
}
