/** @typedef {import('../../../../domain/src/capture/nomination.ts').MeaningfulChangeCategory} MeaningfulChangeCategory */
/** @typedef {import('../../../../domain/src/capture/nomination.ts').SourceChange} SourceChange */
/** @typedef {{version:'vs001-scenario-v1',turn:number,name:string,requiredCategories:readonly MeaningfulChangeCategory[],forward:readonly SourceChange[],inverse:readonly SourceChange[]}} VersionedScenario */

/** @param {string} name */
const source = (name) => `packages/test-fixtures/vs001-ui/src/scenario-${name}`;
/** @param {string} path @param {string} after @returns {readonly [SourceChange, SourceChange]} */
const patch = (path, after) => [{ path, before: "", after }, { path, before: after, after: "" }];

const definitions = [
  { name: "summary-hierarchy.tsx", requiredCategories: ["structure", "accessibility"], code: `export function SummaryHierarchy() { return <header aria-label="Save summary"><h1>Save point evidence</h1><p>Durable status and turn metadata</p></header>; }` },
  { name: "desktop-detail-layout.css", requiredCategories: ["layout/style-system", "responsive"], code: `.scenario-detail { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; gap: 1.5rem; } @media (max-width: 900px) { .scenario-detail { grid-template-columns: 1fr; } }` },
  { name: "evidence-disclosure.tsx", requiredCategories: ["interaction", "accessibility"], code: `export function EvidenceDisclosure() { return <details><summary aria-label="Toggle evidence details">Evidence details</summary><p>Expanded evidence</p></details>; }` },
  { name: "integrity-region.tsx", requiredCategories: ["structure", "accessibility"], code: `export function IntegrityRegion() { return <section role="status" aria-label="Integrity complete"><strong>Complete</strong><p>All required evidence agrees.</p></section>; }` },
  { name: "responsive-panel.css", requiredCategories: ["layout/style-system", "responsive"], code: `@media (max-width: 680px) { .scenario-evidence-panel { display: none; } .scenario-primary-action { display: block; } }` },
  { name: "confirmation-focus.tsx", requiredCategories: ["interaction", "accessibility"], code: `export function ConfirmationSummary() { return <section role="status" tabIndex={-1}><button type="button" onClick={() => undefined}>Confirm save</button><p>Confirmation updates this status region.</p></section>; }` },
  { name: "retention-group.tsx", requiredCategories: ["structure", "interaction"], code: `export function RetentionGroup() { return <section><h2>Retention</h2><button type="button" onClick={() => undefined}>Pin locally</button></section>; }` },
  { name: "trace-authority.tsx", requiredCategories: ["interaction", "accessibility"], code: `export function TraceAuthority() { return <a href="https://traces.example.test" aria-label="Open trace authority" onClick={() => undefined}>Authority unavailable</a>; }` },
  { name: "privacy-quarantine.tsx", requiredCategories: ["interaction", "accessibility"], code: `export function PrivacyQuarantine() { return <section role="alert" aria-live="assertive"><p>Privacy failed.</p><button type="button" onClick={() => undefined}>Quarantine evidence</button></section>; }` },
  { name: "mobile-stop.tsx", requiredCategories: ["responsive", "accessibility"], code: `export function MobileStop() { return <button type="button" aria-label="Stop bounded capture">Stop</button>; }\n/* paired exact responsive patch */`, extra: { path: source("mobile-actions.css"), code: `@media (max-width: 680px) { .scenario-actions { display: flex; flex-direction: column; } .scenario-stop { order: -1; } }` } },
];

/** @type {readonly VersionedScenario[]} */
export const VS001_SCENARIOS = definitions.map((definition, index) => {
  const [forward, inverse] = patch(source(definition.name), definition.code);
  const extra = "extra" in definition ? patch(definition.extra.path, definition.extra.code) : undefined;
  return { version: "vs001-scenario-v1", turn: index + 1, name: definition.name.replace(/\.(?:tsx|css)$/u, ""), requiredCategories: definition.requiredCategories, forward: extra === undefined ? [forward] : [forward, extra[0]], inverse: extra === undefined ? [inverse] : [extra[1], inverse] };
});
