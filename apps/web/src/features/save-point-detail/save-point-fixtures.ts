import { projectPolicyCategory, projectPolicyRevision, type PolicyCategoryProjection, type PolicyRevisionProjection } from "@remo/domain/browser";

export type EvidenceDetailState = "complete" | "degraded" | "inconsistent";

export interface EvidenceDetailComponent {
  readonly type: "source" | "rrweb" | "screenshot" | "trace" | "decision" | "verification" | "dependencies" | "lineage";
  readonly label: string;
  readonly authority: string;
  readonly availability: "Available" | "Missing" | "Unreachable" | "Conflicting";
  readonly provenance: "Observed" | "User-supplied" | "Unknown";
  readonly authorityMode: "fixture" | "live";
  readonly policyRevision: string;
  readonly policyCategory: PolicyCategoryProjection;
  readonly description: string;
  readonly externalUrl?: string;
  readonly externalLabel?: string;
  readonly local: boolean;
}

export interface EvidenceDetailProjection {
  readonly savePointId: string;
  readonly displayId: string;
  readonly turnId: string;
  readonly boundaryRevision: string;
  readonly stablePath: string;
  readonly nominationReason: string;
  readonly manifestDigest: string;
  readonly integrity: { readonly state: "Complete" | "Incomplete" | "Inconsistent"; readonly explanation: string; readonly reasonCodes: readonly string[] };
  readonly fidelity: { readonly state: "Editable eligible" | "Degraded" | "Historical only"; readonly explanation: string };
  readonly privacy: { readonly state: "Pass"; readonly explanation: string };
  readonly retention: { readonly promotedAt: string; readonly expiresAt: string; readonly pinned: boolean };
  readonly policyRevisions: Readonly<Record<"Capture" | "Privacy" | "Integrity" | "Fidelity" | "Retention", PolicyRevisionProjection>>;
  readonly components: readonly EvidenceDetailComponent[];
  readonly revision?: number;
  readonly traceValidatedAt?: string;
  readonly promotionAllowed?: boolean;
}

const TRACE_ID = "0123456789abcdef0123456789abcdef";

export function createEvidenceDetailFixture(state: EvidenceDetailState): EvidenceDetailProjection {
  const traceState = state === "complete" ? "Available" : state === "degraded" ? "Unreachable" : "Conflicting";
  const components: EvidenceDetailComponent[] = [
    { type: "source", label: "Source change", authority: "Git", authorityMode: "fixture", availability: "Available", provenance: "Observed", policyRevision: "source-v2", policyCategory: projectPolicyCategory("source-v2"), description: "Exact allowed-path change at commit 54474fd8.", externalUrl: "https://github.com/example/remo/commit/54474fd8d763cb9acaaa2e83b6df44df36fe7d92", externalLabel: "Open exact source change", local: false },
    { type: "rrweb", label: "Rendered session", authority: "rrweb", authorityMode: "fixture", availability: "Available", provenance: "Observed", policyRevision: "capture-v2", policyCategory: projectPolicyCategory("capture-v2"), description: "Bounded, privacy-checked recording for this turn.", local: true },
    { type: "screenshot", label: "Masked screenshot", authority: "ReMo", authorityMode: "fixture", availability: "Available", provenance: "Observed", policyRevision: "privacy-v4", policyCategory: projectPolicyCategory("privacy-v4"), description: "Immutable selected-viewport image, masked before persistence.", local: true },
    { type: "trace", label: "Langfuse trace", authority: "Langfuse", authorityMode: "fixture", availability: traceState, provenance: "Observed", policyRevision: "trace-v1", policyCategory: projectPolicyCategory("trace-v1"), description: state === "complete" ? "Supplied W3C trace metadata matches this turn." : state === "degraded" ? "The authority cannot currently validate the supplied trace. Local evidence remains available." : "The authority reports a different remo_turn_id. Trust and editable eligibility are blocked.", ...(state === "degraded" ? {} : { externalUrl: `https://traces.example.test/project/remo/traces/${TRACE_ID}`, externalLabel: "Open authoritative trace" }), local: false },
    { type: "decision", label: "Decision context", authority: "ReMo", authorityMode: "fixture", availability: "Available", provenance: "User-supplied", policyRevision: "decision-v1", policyCategory: projectPolicyCategory("decision-v1"), description: "User-supplied acceptance context; no private reasoning is claimed.", local: true },
    { type: "verification", label: "Verification", authority: "Fixture", authorityMode: "fixture", availability: "Available", provenance: "Observed", policyRevision: "verification-v2", policyCategory: projectPolicyCategory("verification-v2"), description: "Allowlisted responsive and accessibility checks passed.", local: true },
    { type: "dependencies", label: "Dependencies", authority: "Fixture", authorityMode: "fixture", availability: "Available", provenance: "Observed", policyRevision: "fixture-v1", policyCategory: projectPolicyCategory("fixture-v1"), description: "Approved fixture, viewport, browser, lockfile, and network-mock descriptors.", local: true },
    { type: "lineage", label: "Lineage", authority: "ReMo", authorityMode: "fixture", availability: "Available", provenance: "Observed", policyRevision: "lineage-v1", policyCategory: projectPolicyCategory("lineage-v1"), description: "Baseline source and capture-window identity for this save.", local: true },
  ];
  return {
    savePointId: "01J000000000000000000000S6",
    displayId: "SP-006",
    turnId: "01J000000000000000000000T6",
    boundaryRevision: "boundary-v1",
    stablePath: "/save-points/01J000000000000000000000S6",
    nominationReason: "Responsive and accessibility verification passed after a meaningful UI change.",
    manifestDigest: `sha256:${"b3f9a1e7c2d8f4a69d4b7c1e2f8a5b63".repeat(2)}`,
    integrity: state === "complete"
      ? { state: "Complete", explanation: "All required evidence is available and agrees on this turn.", reasonCodes: [] }
      : state === "degraded"
        ? { state: "Incomplete", explanation: "Trace validation is unavailable; safe local evidence remains inspectable.", reasonCodes: ["evidence.unavailable"] }
        : { state: "Inconsistent", explanation: "Trace metadata conflicts with this turn. Promotion and editable eligibility are blocked.", reasonCodes: ["correlation.turn-mismatch"] },
    fidelity: state === "complete"
      ? { state: "Editable eligible", explanation: "Required source, rendered, dependency, and verification evidence is complete." }
      : state === "degraded"
        ? { state: "Degraded", explanation: "Historical local evidence is safe to inspect, but reproducibility is not claimed." }
        : { state: "Historical only", explanation: "Safe immutable evidence remains viewable; this save is not eligible for editable reconstruction." },
    privacy: { state: "Pass", explanation: "Rendered evidence passed privacy policy before local persistence." },
    retention: { promotedAt: "2026-08-16T10:24:00.000Z", expiresAt: "2026-09-15T10:24:00.000Z", pinned: false },
    policyRevisions: {
      Capture: projectPolicyRevision("Capture", "capture-v2"),
      Privacy: projectPolicyRevision("Privacy", "privacy-v4"),
      Integrity: projectPolicyRevision("Integrity", "integrity-v3"),
      Fidelity: projectPolicyRevision("Fidelity", "fidelity-v2"),
      Retention: projectPolicyRevision("Retention", "retention-v1"),
    },
    components,
  };
}
