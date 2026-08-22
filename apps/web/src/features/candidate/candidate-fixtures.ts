import {
  PRIVACY_POLICY_REVISION,
  createQuarantineReceipt,
  projectCandidate,
  type CandidateProjection,
  type CandidateConfirmationBinding,
  type EvidenceDescriptor,
  type FidelityEvaluation,
  type IntegrityEvaluation,
} from "@remo/domain/browser";

const turnId = "01J000000000000000000000T4";
const createdAt = "2026-08-16T07:30:00.000Z";
const nomination = {
  status: "candidate",
  categories: ["responsive", "accessibility"],
  boundaries: [{ kind: "verification", boundaryId: "fixture-review", occurredAt: createdAt }],
  reasonCodes: ["nomination.meaningful-change-with-boundary"],
} as const;

const baseEvidence: readonly EvidenceDescriptor[] = [
  ["source", "Source", "git", "observed"],
  ["rrweb", "Replay", "rrweb", "observed"],
  ["screenshot", "Screenshot", "remo", "observed"],
  ["trace", "Trace", "langfuse", "observed"],
  ["decision", "Decision", "remo", "user-supplied"],
  ["verification", "Verification", "fixture", "observed"],
  ["dependencies", "Dependencies", "fixture", "observed"],
  ["lineage", "Lineage", "remo", "observed"],
].map(([componentType, , authority, provenance]) => ({
  componentId: `${turnId}:${componentType}`,
  componentType: componentType as EvidenceDescriptor["componentType"],
  authority: authority as EvidenceDescriptor["authority"],
  correlation: { turnId },
  capturedAt: createdAt,
  digest: `sha256:fixture-${componentType}`,
  provenance: provenance as EvidenceDescriptor["provenance"],
  policyRevision: PRIVACY_POLICY_REVISION,
  availability: "available" as const,
}));

export type CandidateFixtureState = "candidate" | "quarantined" | "inconsistent" | "incomplete";

export function createCandidateFixture(state: CandidateFixtureState, confirmationBinding?: CandidateConfirmationBinding): CandidateProjection {
  const quarantined = state === "quarantined";
  const inconsistent = state === "inconsistent";
  const incomplete = state === "incomplete";
  const evidence = quarantined
    ? []
    : incomplete
      ? baseEvidence.map((component) => component.componentType === "trace" ? { ...component, availability: "unreachable" as const } : component)
      : baseEvidence;
  const integrity: IntegrityEvaluation = quarantined
    ? { state: "quarantined", reasonCodes: ["privacy.failed"], componentIds: [`${turnId}:rrweb`, `${turnId}:screenshot`] }
    : inconsistent
      ? { state: "inconsistent", reasonCodes: ["source.state-mismatch"], componentIds: [`${turnId}:source`, `${turnId}:screenshot`] }
      : incomplete
        ? { state: "incomplete", reasonCodes: ["evidence.component-missing"], componentIds: [`${turnId}:trace`] }
        : { state: "complete", reasonCodes: [], componentIds: [] };
  const fidelity: FidelityEvaluation = quarantined
    ? { state: "unavailable", reasonCodes: ["privacy.failed"] }
    : inconsistent
      ? { state: "historical-only", reasonCodes: ["source.state-mismatch"] }
      : incomplete
        ? { state: "degraded", reasonCodes: ["evidence.component-missing"] }
        : { state: "editable-eligible", reasonCodes: [] };
  const privacy = quarantined
    ? createQuarantineReceipt({ reasonCodes: ["privacy.canary-detected"], failedComponents: ["rrweb", "screenshot"], checkedAt: "2026-08-16T07:31:00.000Z" })
    : { status: "passed", policyRevision: PRIVACY_POLICY_REVISION, rrwebDigest: "sha256:fixture-rrweb", rrwebSize: 12430, screenshotDigest: "sha256:fixture-screenshot", screenshotSize: 48620, checkedAt: createdAt } as const;
  return projectCandidate({ turnId, nomination, evidence, privacy, integrity, fidelity, createdAt, ...(confirmationBinding === undefined ? {} : { confirmationBinding }) });
}

export function createBoundCandidateFixture(state: CandidateFixtureState = "candidate"): CandidateProjection {
  return createCandidateFixture(state, {
    savePointId: "01J000000000000000000000S5",
    candidateRevision: 1,
    candidateManifestDigest: `sha256:${"b".repeat(64)}`,
  });
}
