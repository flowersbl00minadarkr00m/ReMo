const MEDIA_REQUEST = /^http:\/\/127\.0\.0\.1:4175\/api\/save-points\/[A-Za-z0-9_-]+\/media\/(?:screenshot|rrweb)$/u;

export function createNavigationRequestLifecycle() {
  let current;
  return {
    begin(navigation) {
      if (current !== undefined) throw new Error(`Navigation ${current.navigationId} has not settled.`);
      current = navigation;
    },
    documentLoaded(navigationId) {
      if (current?.navigationId !== navigationId) throw new Error(`Navigation ${navigationId} is not active.`);
    },
    settle(navigationId) { if (current?.navigationId === navigationId) current = undefined; },
    current() { return current; },
  };
}

export function isCausallyBoundNavigationMediaFailure({ binding, method, url, errorText }) {
  return errorText === "net::ERR_ABORTED"
    && method === "GET"
    && MEDIA_REQUEST.test(url)
    && typeof binding?.navigationId === "string"
    && typeof binding.navigationUrl === "string";
}
