import type { HistoryPage } from "@remo/domain/browser";
import type { HistoryDetailSummary } from "../history-filmstrip/ReplayWorkspace.js";
import type { HistoryClient } from "../history-filmstrip/history-client.js";
import type { HostedDemoFixtureBundle } from "./hosted-demo-fixture.js";

function abortError(): Error {
  return typeof DOMException === "undefined" ? Object.assign(new Error("The hosted demo request was aborted."), { name: "AbortError" }) : new DOMException("The hosted demo request was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError();
}

function defensiveCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    Object.freeze(item);
    Object.values(item as Record<string, unknown>).forEach(freeze);
  };
  freeze(copy);
  return copy;
}

export class HostedDemoHistoryClient implements HistoryClient {
  readonly #history: HistoryPage;

  constructor(fixture: HostedDemoFixtureBundle) {
    this.#history = fixture.history;
  }

  async list(signal?: AbortSignal): Promise<HistoryPage> {
    throwIfAborted(signal);
    await Promise.resolve();
    throwIfAborted(signal);
    return defensiveCopy(this.#history);
  }
}

export class HostedDemoDetailLoader {
  readonly #details: Readonly<Record<string, HistoryDetailSummary>>;

  constructor(fixture: HostedDemoFixtureBundle) {
    this.#details = fixture.detailsBySavePointId;
  }

  async load(savePointId: string, signal?: AbortSignal): Promise<HistoryDetailSummary> {
    throwIfAborted(signal);
    const detail = this.#details[savePointId];
    if (detail === undefined) throw new Error("Hosted demo detail is unavailable for this fixture identity.");
    await Promise.resolve();
    throwIfAborted(signal);
    return defensiveCopy(detail);
  }
}
