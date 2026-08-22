import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { FixtureApp } from "./FixtureApp.js";
import { FIXTURE_CONTRACT } from "./fixture-contract.js";
import fixtureStyles from "./styles.css?inline";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Fixture root element is missing");
}

const isExactRoute =
  window.location.origin === "http://127.0.0.1:4173" &&
  window.location.pathname === "/fixture/save-point";

flushSync(() => {
  createRoot(root).render(
    <StrictMode>
      {isExactRoute ? (
        <>
          <style data-remo-fixture-styles>{fixtureStyles}</style>
          <FixtureApp />
        </>
      ) : (
        <main className="route-error" role="alert">
          <h1>Fixture route blocked</h1>
          <p>Use exactly http://127.0.0.1:4173/fixture/save-point.</p>
        </main>
      )}
    </StrictMode>,
  );
});

if (isExactRoute && root.querySelector("main.fixture-shell") !== null) {
  root.dataset.remoFixtureRoot = FIXTURE_CONTRACT.replayFixtureVersion;
}
