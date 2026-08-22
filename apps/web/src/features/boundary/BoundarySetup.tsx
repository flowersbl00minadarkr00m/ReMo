import { useRef, useState } from "react";
import {
  createPassingPreflightInput,
  evaluateBoundaryPreflight,
  type BoundaryPreflightInput,
  type BoundaryPreflightResult,
  type PreflightCategory,
} from "../../../../service/src/boundaries/preflight.js";

interface BoundarySetupProps {
  input?: BoundaryPreflightInput;
  initialResult?: BoundaryPreflightResult | null;
}

interface ScopeFieldProps {
  label: string;
  value: string;
}

interface DisplayedCheck {
  category: PreflightCategory;
  label: string;
  status: "pass" | "fail" | "pending";
}

const CATEGORY_SUMMARIES: Record<PreflightCategory, string> = {
  project: "Canonical registry path",
  source: "Evidence-bearing paths",
  browser: "Origin, route, and root",
  privacy: "Mask and block selectors",
  state: "Allowed browser-state keys",
  verification: "Commands and viewports",
  fixture: "Package and version",
};

function ScopeField({ label, value }: ScopeFieldProps) {
  return (
    <div className="scope-field">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function StatusIcon({ status }: { status: "pass" | "fail" | "pending" }) {
  if (status === "pass") {
    return <span className="status-icon" aria-hidden="true">✓</span>;
  }
  if (status === "fail") {
    return <span className="status-icon" aria-hidden="true">!</span>;
  }
  return <span className="status-icon" aria-hidden="true">—</span>;
}

export function BoundarySetup({
  input = createPassingPreflightInput(),
  initialResult = null,
}: BoundarySetupProps) {
  const [result, setResult] = useState<BoundaryPreflightResult | null>(initialResult);
  const blockingSummary = useRef<HTMLDivElement>(null);

  function runPreflight(): void {
    const nextResult = evaluateBoundaryPreflight(input);
    setResult(nextResult);
    if (!nextResult.ready) {
      window.requestAnimationFrame(() => blockingSummary.current?.focus());
    }
  }

  const displayedChecks: readonly DisplayedCheck[] =
    result?.checks ??
    Object.entries(CATEGORY_SUMMARIES).map(([category, label]) => ({
      category: category as PreflightCategory,
      label,
      status: "pending" as const,
    }));

  return (
    <div className="boundary-layout">
      <header className="boundary-heading">
        <div>
          <h1>Configure capture boundary</h1>
        </div>
        <div className="capture-status" role="status" aria-live="polite">
          <span className="capture-dot" aria-hidden="true" />
          <strong>Capture off</strong>
        </div>
      </header>

      <div className="boundary-columns">
        <div className="boundary-form">
          <section className="boundary-section" aria-labelledby="project-scope-title">
            <div className="section-heading">
              <h2 id="project-scope-title">Project scope</h2>
              <p>Limit evidence to the canonical project and binding source path.</p>
            </div>
            <div className="field-grid two-up">
              <ScopeField label="Registry identity" value={input.registryIdentity} />
              <ScopeField label="Canonical project" value={input.canonicalProjectPath} />
              <ScopeField label="Fixture package" value={input.fixturePackage} />
              <ScopeField label="Evidence-bearing source" value={input.sourceAllowlist.join(", ")} />
            </div>
          </section>

          <section className="boundary-section" aria-labelledby="browser-scope-title">
            <div className="section-heading">
              <h2 id="browser-scope-title">Browser scope</h2>
              <p>Allow one loopback origin, one route, and one DOM root.</p>
            </div>
            <div className="field-grid three-up">
              <ScopeField label="Allowed origin" value={input.origin} />
              <ScopeField label="Exact route" value={input.route} />
              <ScopeField label="Capture root" value={input.captureRoot} />
            </div>
          </section>

          <section className="boundary-section" aria-labelledby="privacy-title">
            <div className="section-heading">
              <h2 id="privacy-title">Privacy and browser state</h2>
              <p>Mask sensitive content, block unsafe elements, and deny ambient state.</p>
            </div>
            <div className="field-grid two-up">
              <ScopeField label="Mask selectors" value={input.maskSelectors.join(", ")} />
              <ScopeField label="Block selectors" value={input.blockSelectors.join(", ")} />
              <ScopeField label="Allowed state keys" value={input.stateKeys.join(", ")} />
              <ScopeField label="Fixture version" value={input.fixtureVersion} />
            </div>
          </section>

          <section className="boundary-section verification-section" aria-labelledby="verification-title">
            <div className="section-heading">
              <h2 id="verification-title">Verification</h2>
              <p>Every approved check must pass before the boundary is ready.</p>
            </div>
            <ul className="command-list" aria-label="Approved verification commands">
              {input.commands.map((command) => <li key={command}><code>{command}</code></li>)}
            </ul>
            <div className="verification-actions">
              <span className="viewport-copy">1440 × 900 capture · 390 × 844 responsive</span>
              <button className="button secondary-button" type="button" onClick={runPreflight}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 7 6-7 6Z" /></svg>
                Run preflight
              </button>
            </div>
          </section>
        </div>

        <aside className="boundary-aside" aria-label="Boundary status">
          <section className="aside-section excluded-section">
            <h2>Excluded by default</h2>
            <ul>
              {[
                "Raw keystrokes",
                "Clipboard contents",
                "Other applications",
                "Private messages",
                "Outside routes and paths",
              ].map((item) => (
                <li key={item}><span aria-hidden="true">⊘</span>{item}</li>
              ))}
            </ul>
          </section>

          <section className="aside-section preflight-summary" aria-labelledby="summary-title">
            <h2 id="summary-title">Preflight summary</h2>
            <ul>
              {displayedChecks.map((check) => (
                <li key={check.category}>
                  <span>{check.label}</span>
                  <strong className={`summary-state ${check.status}`}>
                    <StatusIcon status={check.status} />
                    {check.status === "pending" ? "Not run" : check.status === "pass" ? "Pass" : "Blocked"}
                  </strong>
                </li>
              ))}
            </ul>
            <div className="overall-status">
              <span>Overall status</span>
              <strong>{result === null ? "Not checked" : result.ready ? "Ready" : "Blocked"}</strong>
            </div>
            <p>
              {result === null
                ? "Run preflight to inspect every mandatory boundary."
                : result.ready
                  ? "All mandatory checks pass. Recording is still off."
                  : `${result.failures.length} blocking check${result.failures.length === 1 ? "" : "s"} must be fixed.`}
            </p>
          </section>

          {result !== null && !result.ready ? (
            <div className="blocking-summary" ref={blockingSummary} tabIndex={-1} role="alert">
              <h2>Capture remains off</h2>
              <ol>
                {result.failures.map((failure) => (
                  <li key={`${failure.reasonCode}-${failure.explanation}`}>
                    <code>{failure.reasonCode}</code>
                    <p>{failure.explanation}</p>
                    <strong>Recovery: {failure.recovery}</strong>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="off-notice" role="note">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 10v6m0-9h.01" /></svg>
            <p>Boundary setup does not start capture or persist evidence.</p>
          </div>
        </aside>
      </div>

      <footer className="boundary-footer">
        <p><strong>Recording is off.</strong> T2 verifies the boundary only.</p>
        <button className="button primary-button" type="button" disabled>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.7c0 3.6-2.5 6-6 7.8-3.5-1.8-6-4.2-6-7.8V5Z" /></svg>
          Start bounded turn
        </button>
      </footer>
    </div>
  );
}
