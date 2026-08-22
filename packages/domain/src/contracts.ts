export const BUNDLE_SCHEMA_VERSION = "remo.bundle.v1" as const;
export const STABLE_ID_VERSION = "ulid-v1" as const;

export type BundleSchemaVersion = typeof BUNDLE_SCHEMA_VERSION;
export type StableIdVersion = typeof STABLE_ID_VERSION;

export type ComponentType =
  | "source"
  | "rrweb"
  | "screenshot"
  | "trace"
  | "decision"
  | "verification"
  | "dependencies"
  | "lineage";

export const REQUIRED_COMPONENT_TYPES: readonly ComponentType[] = [
  "source",
  "rrweb",
  "screenshot",
  "trace",
  "decision",
  "verification",
  "dependencies",
  "lineage",
];

export type EvidenceAuthority =
  | "git"
  | "rrweb"
  | "langfuse"
  | "remo"
  | "fixture";

export type EvidenceAvailability =
  | "available"
  | "missing"
  | "unreachable"
  | "rejected";

export const PROVENANCE_VALUES = [
  "observed",
  "user-supplied",
  "inferred",
  "reconstructed",
  "unknown",
] as const;

export type Provenance = (typeof PROVENANCE_VALUES)[number];

export function isProvenance(value: string): value is Provenance {
  return PROVENANCE_VALUES.some((candidate) => candidate === value);
}

export interface CorrelationTuple {
  projectId: string;
  turnId: string;
  captureWindowId: string;
  boundaryRevision: string;
}

export interface EvidenceClaims {
  sourceState?: string;
  fixtureId?: string;
}

export interface EvidenceDescriptor {
  componentId: string;
  componentType: ComponentType;
  authority: EvidenceAuthority;
  correlation: Partial<CorrelationTuple>;
  capturedAt: string;
  windowStart?: string;
  windowEnd?: string;
  digest?: string;
  blobRef?: string;
  externalId?: string;
  externalUrl?: string;
  availability: EvidenceAvailability;
  provenance: Provenance;
  policyRevision: string;
  claims?: EvidenceClaims;
}

export type IntegrityState =
  | "complete"
  | "incomplete"
  | "inconsistent"
  | "quarantined";

export type FidelityState =
  | "editable-eligible"
  | "historical-only"
  | "degraded"
  | "unavailable";

export type CandidateLifecycleState =
  | "capturing"
  | "settled"
  | "no-candidate"
  | "candidate"
  | "incomplete"
  | "inconsistent"
  | "quarantined"
  | "durable"
  | "discarded"
  | "expired"
  | "deleted";

export const REASON_CODES = [
  "privacy.failed",
  "evidence.duplicate-component",
  "correlation.project-mismatch",
  "correlation.turn-mismatch",
  "correlation.window-mismatch",
  "correlation.boundary-mismatch",
  "source.state-mismatch",
  "fixture.identity-mismatch",
  "policy.revision-mismatch",
  "evidence.component-missing",
  "evidence.correlation-proof-missing",
  "evidence.digest-missing",
  "trace.id-proof-missing",
  "evidence.unavailable",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface PrivacyEvaluationInput {
  status: "passed" | "failed";
  reasonCodes: readonly ReasonCode[];
  failedComponentIds?: readonly string[];
}

export interface IntegrityEvaluation {
  state: IntegrityState;
  reasonCodes: readonly ReasonCode[];
  componentIds: readonly string[];
}

export interface FidelityEvaluation {
  state: FidelityState;
  reasonCodes: readonly ReasonCode[];
}

export interface FinalizationInput {
  schemaVersion: BundleSchemaVersion;
  identityVersion: StableIdVersion;
  policyRevision: string;
  savePointId: string;
  correlation: CorrelationTuple;
  privacy: PrivacyEvaluationInput;
  evidence: readonly EvidenceDescriptor[];
}

export interface BundleManifest {
  schemaVersion: BundleSchemaVersion;
  identityVersion: StableIdVersion;
  policyRevision: string;
  savePointId: string;
  correlation: CorrelationTuple;
  privacy: {
    status: "passed" | "failed";
    reasonCodes: readonly ReasonCode[];
  };
  evidence: readonly EvidenceDescriptor[];
  integrity: IntegrityEvaluation;
  fidelity: FidelityEvaluation;
}

export interface EvaluatedBundle {
  manifest: BundleManifest;
  canonicalManifest: string;
  manifestDigest: string;
  integrity: IntegrityEvaluation;
  fidelity: FidelityEvaluation;
  promotionAllowed: boolean;
}
