import { useCallback, useEffect, useState } from "react";
import { HostedDemoHistory, matchHostedDemoRoute } from "./HostedDemoHistory.js";
import { HostedDemoShell } from "./HostedDemoShell.js";
import { loadHostedDemoFixture, type HostedDemoFixtureBundle } from "./hosted-demo-fixture.js";

export interface HostedDemoAppProps {
  readonly loadFixture?: (signal?: AbortSignal) => Promise<HostedDemoFixtureBundle>;
}

export function HostedDemoApp({ loadFixture = loadHostedDemoFixture }: HostedDemoAppProps = {}) {
  const [path, setPath] = useState(() => window.location.pathname);
  const [attempt, setAttempt] = useState(0);
  const [fixtureState, setFixtureState] = useState<{ readonly status: "loading" } | { readonly status: "unavailable" } | { readonly status: "ready"; readonly fixture: HostedDemoFixtureBundle }>({ status: "loading" });
  const route = matchHostedDemoRoute(path);
  const supportedRoute = route.kind !== "unsupported";

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!supportedRoute) return;
    const controller = new AbortController();
    setFixtureState({ status: "loading" });
    loadFixture(controller.signal).then((fixture) => {
      if (!controller.signal.aborted) setFixtureState({ status: "ready", fixture });
    }, () => {
      if (!controller.signal.aborted) setFixtureState({ status: "unavailable" });
    });
    return () => controller.abort();
  }, [attempt, loadFixture, supportedRoute]);

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  }, []);

  if (route.kind === "unsupported") return <HostedDemoShell path={path}><section className="hosted-demo-unavailable" role="alert"><h2>Demonstration route unavailable</h2><p>This address is outside the closed hosted-demo route set. No fixture or evidence request was made.</p><a href="/save-points">Open the synthetic history</a></section></HostedDemoShell>;
  if (fixtureState.status === "loading") return <HostedDemoShell path={path}><section className="hosted-demo-loading" role="status"><h2>Validating hosted demonstration</h2><p>Checking the immutable fixture manifest before rendering evidence.</p></section></HostedDemoShell>;
  if (fixtureState.status === "unavailable") return <HostedDemoShell path={path}><section className="hosted-demo-unavailable" role="alert"><h2>Hosted demonstration unavailable</h2><p>The synthetic fixture failed schema, identity, digest, URL, credential, or path validation. No demo evidence is ready.</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry fixture validation</button></section></HostedDemoShell>;
  return <HostedDemoShell path={path}><HostedDemoHistory fixture={fixtureState.fixture} route={route} navigate={navigate} /></HostedDemoShell>;
}

export { HostedDemoApp as App };
