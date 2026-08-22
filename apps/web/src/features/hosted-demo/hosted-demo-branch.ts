import { canonicalSerialize } from "@remo/domain";
import type { BranchOrchestrationClient, BranchResult } from "../branch-preflight/branch-orchestration-client.js";
import type { BranchPreflightClient } from "../branch-preflight/branch-preflight-client.js";
import type { HostedDemoFixtureBundle } from "./hosted-demo-fixture.js";
import { HOSTED_DEMO_BRANCH_SAVE_POINT_ID, HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION } from "./hosted-demo-fixture-source.js";

export { HOSTED_DEMO_BRANCH_SAVE_POINT_ID, HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION } from "./hosted-demo-fixture-source.js";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return value;
}

function abortError(): Error {
  return typeof DOMException === "undefined" ? Object.assign(new Error("The simulated demo request was aborted."), { name: "AbortError" }) : new DOMException("The simulated demo request was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function copy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

async function settle(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await Promise.resolve();
  throwIfAborted(signal);
}

export function createHostedDemoBranchPreflightClient(fixture: HostedDemoFixtureBundle): BranchPreflightClient {
  const receipt = fixture.preflight;
  return {
    async preflight(savePointId, revision, signal) {
      await settle(signal);
      if (savePointId !== HOSTED_DEMO_BRANCH_SAVE_POINT_ID || revision !== HOSTED_DEMO_BRANCH_SAVE_POINT_REVISION) throw new Error("The simulated preflight is available only for the fixed Turn 4 fixture identity.");
      return copy(receipt);
    },
  };
}

export function createHostedDemoBranchOrchestrationClient(fixture: HostedDemoFixtureBundle, options: { readonly initiallyCreated?: boolean; readonly onCreated?: (result: BranchResult) => void } = {}): BranchOrchestrationClient {
  const receipt = fixture.preflight;
  const branch = fixture.simulatedBranch;
  let created = options.initiallyCreated === true;
  return {
    async confirm(candidate, displayLabel, idempotencyKey, signal) {
      await settle(signal);
      const exactReceipt = canonicalSerialize(candidate) === canonicalSerialize(receipt);
      if (!exactReceipt || displayLabel !== `Alternate from ${HOSTED_DEMO_BRANCH_SAVE_POINT_ID}` || idempotencyKey !== `branch-${receipt.target.operationId}`) {
        throw new Error("The simulated branch receipt is stale or unsupported. The unchanged original future remains selected.");
      }
      const result = copy(branch);
      if (!created) {
        created = true;
        options.onCreated?.(result);
      }
      return result;
    },
    async list(savePointId, signal) {
      await settle(signal);
      if (savePointId !== HOSTED_DEMO_BRANCH_SAVE_POINT_ID) throw new Error("The simulated lineage is unavailable for this fixture identity.");
      return created ? [copy(branch)] : [];
    },
  };
}

export function originalFutureInventory<T extends { readonly sequenceNo: number }>(items: readonly T[]): readonly T[] {
  return items.filter(({ sequenceNo }) => sequenceNo > 4).map((item) => item);
}
