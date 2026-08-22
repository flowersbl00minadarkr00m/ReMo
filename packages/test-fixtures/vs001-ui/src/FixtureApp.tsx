import { FIXTURE_CONTRACT, FIXTURE_STATE } from "./fixture-contract.js";

export function FixtureApp() {
  return (
    <main className="fixture-shell">
      <header className="fixture-header">
        <div>
          <p className="fixture-kicker">Synthetic acceptance fixture</p>
          <h1>Save point evidence</h1>
        </div>
        <span className="fixture-version">{FIXTURE_CONTRACT.fixtureVersion}</span>
      </header>

      <section className="fixture-summary" aria-labelledby="fixture-summary-title">
        <div>
          <h2 id="fixture-summary-title">Candidate summary</h2>
          <p>A deterministic UI surface for bounded source and browser evidence.</p>
        </div>
        <strong className="fixture-state">Not durable</strong>
      </section>

      <section className="fixture-grid" aria-label="Fixture evidence">
        <article>
          <h2>Evidence selection</h2>
          <dl>
            <div><dt>Active panel</dt><dd>{FIXTURE_STATE.activePanel}</dd></div>
            <div><dt>Selected evidence</dt><dd>{FIXTURE_STATE.selectedEvidenceId}</dd></div>
            <div><dt>Details expanded</dt><dd>{String(FIXTURE_STATE.detailsExpanded)}</dd></div>
            <div><dt>Viewport mode</dt><dd>{FIXTURE_STATE.viewportMode}</dd></div>
          </dl>
        </article>

        <article>
          <h2>Privacy fixture</h2>
          <p data-remo-sensitive data-remo-mask>
            Masked text canary: {FIXTURE_CONTRACT.privacyCanary}
          </p>
          <label>
            Masked input
            <input readOnly value={FIXTURE_CONTRACT.privacyCanary} />
          </label>
          <label>
            Masked notes
            <textarea readOnly value={FIXTURE_CONTRACT.privacyCanary} />
          </label>
          <div data-remo-block hidden>
            Blocked fixture marker
          </div>
        </article>
      </section>
    </main>
  );
}
