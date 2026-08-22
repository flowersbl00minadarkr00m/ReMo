/* global URL, setTimeout */
const DEFAULT_QUIET_MS = 200;
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 10_000;

function serialize(binding) {
  return {
    requestId: binding.requestId,
    lifecycleId: binding.lifecycleId,
    lifecycleUrl: binding.lifecycleUrl,
    method: binding.method,
    url: binding.url,
    state: binding.state,
  };
}

export function createJoinedRequestLifecycle({ firstPartyOrigins }) {
  const allowedOrigins = new Set(firstPartyOrigins);
  const bindings = new WeakMap();
  const pending = new Map();
  const firstPartyRequests = [];
  const failures = [];
  const classifiedFailures = [];
  const unexpectedNetwork = [];
  const completedLifecycles = [];
  let current;
  let requestSequence = 0;
  let lastFirstPartyActivityAt = Date.now();

  const bindingFor = (request) => bindings.get(request);
  const finish = (request, state) => {
    const binding = bindingFor(request);
    if (binding === undefined || !pending.delete(request)) return;
    lastFirstPartyActivityAt = Date.now();
    binding.state = state;
  };

  return {
    begin(lifecycle) {
      if (current !== undefined) throw new Error(`Joined lifecycle ${current.lifecycleId} has not settled.`);
      if (pending.size !== 0) throw new Error(`Cannot begin ${lifecycle.lifecycleId} while ${pending.size} first-party requests remain pending.`);
      current = lifecycle;
    },
    requestStarted(request) {
      requestSequence += 1;
      const url = new URL(request.url());
      const binding = {
        requestId: `joined-request-${requestSequence}`,
        lifecycleId: current?.lifecycleId ?? "unbound",
        lifecycleUrl: current?.lifecycleUrl ?? "unbound",
        method: request.method(),
        url: request.url(),
        state: "started",
      };
      bindings.set(request, binding);
      if (url.protocol === "http:" && allowedOrigins.has(url.origin)) {
        pending.set(request, binding);
        firstPartyRequests.push(binding);
        lastFirstPartyActivityAt = Date.now();
      } else if (url.protocol === "http:") {
        unexpectedNetwork.push(serialize(binding));
      }
      return serialize(binding);
    },
    requestFinished(request) {
      finish(request, "finished");
    },
    requestFailed(request) {
      const binding = bindingFor(request) ?? {
        requestId: `joined-unobserved-${requestSequence + 1}`,
        lifecycleId: current?.lifecycleId ?? "unbound",
        lifecycleUrl: current?.lifecycleUrl ?? "unbound",
        method: request.method(),
        url: request.url(),
      };
      finish(request, "failed");
      failures.push({ ...serialize(binding), errorText: request.failure()?.errorText ?? "failed", classification: "unexpected" });
    },
    assertTransitionReady(label) {
      if (pending.size === 0) return;
      const requests = [...pending.values()].map(serialize);
      throw new Error(`${label}: ${requests.length} first-party requests remain pending: ${JSON.stringify(requests)}`);
    },
    async waitForSettled(label, { quietMs = DEFAULT_QUIET_MS, timeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pending.size === 0 && Date.now() - lastFirstPartyActivityAt >= quietMs) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      this.assertTransitionReady(label);
      throw new Error(`${label}: first-party requests did not remain quiet for ${quietMs}ms before the ${timeoutMs}ms settlement deadline.`);
    },
    async settle(label, options) {
      if (current === undefined) throw new Error(`No joined lifecycle is active for ${label}.`);
      await this.waitForSettled(label, options);
      const lifecycleRequests = firstPartyRequests.filter(({ lifecycleId }) => lifecycleId === current.lifecycleId);
      completedLifecycles.push({ ...current, settledBeforeTransition: true, requestCount: lifecycleRequests.length, requestIds: lifecycleRequests.map(({ requestId }) => requestId) });
      current = undefined;
    },
    snapshot() {
      const pendingRequests = [...pending.values()].map(serialize);
      return {
        current: current === undefined ? null : { ...current },
        pending: pendingRequests,
        firstPartyRequests: firstPartyRequests.map(serialize),
        failures: failures.map((failure) => ({ ...failure })),
        classifiedFailures: classifiedFailures.map((failure) => ({ ...failure })),
        unexpectedNetwork: unexpectedNetwork.map((request) => ({ ...request })),
        completedLifecycles: completedLifecycles.map((lifecycle) => ({ ...lifecycle })),
        unboundRequests: [...firstPartyRequests.map(serialize), ...failures.filter(({ requestId }) => requestId.startsWith("joined-unobserved-")), ...unexpectedNetwork].filter(({ lifecycleId }) => lifecycleId === "unbound"),
      };
    },
  };
}
