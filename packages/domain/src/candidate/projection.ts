import type { NominationResult } from "../capture/nomination.js";
import type {
  EvidenceDescriptor,
  FidelityEvaluation,
  IntegrityEvaluation,
  Provenance,
} from "../contracts.js";
import type { PrivacyReceipt } from "../privacy/receipt.js";

export type CandidateReviewState =
  | "candidate"
  | "incomplete"
  | "inconsistent"
  | "quarantined"
  | "discarded";

export interface CandidateComponentProjection {
  readonly componentType: EvidenceDescriptor["componentType"];
  readonly label: string;
  readonly availability: EvidenceDescriptor["availability"];
  readonly authority: EvidenceDescriptor["authority"];
  readonly provenance: Provenance;
  readonly identityStatus: "matched" | "missing" | "conflicting";
}

export interface CandidateProjection {
  readonly kind: "candidate";
  readonly state: CandidateReviewState;
  readonly turnId: string;
  readonly nominationCategories: readonly string[];
  readonly nominationBoundaries: readonly string[];
  readonly components: readonly CandidateComponentProjection[];
  readonly privacy: PrivacyReceipt;
  readonly integrity: IntegrityEvaluation;
  readonly fidelity: FidelityEvaluation;
  readonly expiresAt: string;
  readonly blockingReasons: readonly string[];
  readonly canConfirm: boolean;
  readonly reproducible: boolean;
  readonly screenshotPreviewAvailable: boolean;
  readonly replayPreviewAvailable: boolean;
  readonly confirmationBinding?: CandidateConfirmationBinding;
}

export interface CandidateConfirmationBinding {
  readonly savePointId: string;
  readonly candidateRevision: number;
  readonly candidateManifestDigest: string;
}

const COMPONENT_LABELS: Record<EvidenceDescriptor["componentType"], string> = {
  source: "Source",
  rrweb: "Replay",
  screenshot: "Screenshot",
  trace: "Trace",
  decision: "Decision",
  verification: "Verification",
  dependencies: "Dependencies",
  lineage: "Lineage",
};

function identityStatus(
  descriptor: EvidenceDescriptor,
  integrity: IntegrityEvaluation,
): CandidateComponentProjection["identityStatus"] {
  if (descriptor.availability !== "available") return "missing";
  return integrity.componentIds.includes(descriptor.componentId) && integrity.state === "inconsistent"
    ? "conflicting"
    : "matched";
}

function reviewState(privacy: PrivacyReceipt, integrity: IntegrityEvaluation): CandidateReviewState {
  if (privacy.status === "quarantined" || integrity.state === "quarantined") return "quarantined";
  if (integrity.state === "inconsistent") return "inconsistent";
  if (integrity.state === "incomplete") return "incomplete";
  return "candidate";
}

export function projectCandidate(input: {
  readonly turnId: string;
  readonly nomination: NominationResult;
  readonly evidence: readonly EvidenceDescriptor[];
  readonly privacy: PrivacyReceipt;
  readonly integrity: IntegrityEvaluation;
  readonly fidelity: FidelityEvaluation;
  readonly createdAt: string;
  readonly confirmationBinding?: CandidateConfirmationBinding;
}): CandidateProjection {
  const state = reviewState(input.privacy, input.integrity);
  const nominated = input.nomination.status === "candidate";
  const sourceRenderMismatch = input.integrity.reasonCodes.some((reason) =>
    ["correlation.turn-mismatch", "correlation.window-mismatch", "source.state-mismatch", "fixture.identity-mismatch"].includes(reason),
  );
  const blockingReasons = [
    ...(!nominated ? ["nomination.required"] : []),
    ...(input.privacy.status === "quarantined" ? input.privacy.reasonCodes : []),
    ...input.integrity.reasonCodes,
    ...(input.confirmationBinding === undefined ? ["candidate.confirmation-binding-missing"] : []),
  ];
  const hasAvailable = (componentType: EvidenceDescriptor["componentType"]) =>
    input.evidence.some((component) => component.componentType === componentType && component.availability === "available");
  return {
    kind: "candidate",
    state,
    turnId: input.turnId,
    nominationCategories: input.nomination.status === "candidate" ? input.nomination.categories : [],
    nominationBoundaries: input.nomination.status === "candidate" ? input.nomination.boundaries.map(({ kind }) => kind) : [],
    components: input.evidence.map((descriptor) => ({
      componentType: descriptor.componentType,
      label: COMPONENT_LABELS[descriptor.componentType],
      availability: descriptor.availability,
      authority: descriptor.authority,
      provenance: descriptor.provenance,
      identityStatus: identityStatus(descriptor, input.integrity),
    })),
    privacy: input.privacy,
    integrity: input.integrity,
    fidelity: input.fidelity,
    expiresAt: new Date(Date.parse(input.createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
    blockingReasons: [...new Set(blockingReasons)].sort(),
    canConfirm: nominated && input.privacy.status === "passed" && input.integrity.state === "complete" && input.confirmationBinding !== undefined,
    reproducible: input.integrity.state === "complete" && !sourceRenderMismatch,
    screenshotPreviewAvailable: state !== "quarantined" && hasAvailable("screenshot"),
    replayPreviewAvailable: state !== "quarantined" && hasAvailable("rrweb"),
    ...(input.confirmationBinding === undefined ? {} : { confirmationBinding: input.confirmationBinding }),
  };
}

export function discardCandidate(candidate: CandidateProjection): CandidateProjection {
  return {
    ...candidate,
    state: "discarded",
    canConfirm: false,
    reproducible: false,
    screenshotPreviewAvailable: false,
    replayPreviewAvailable: false,
    blockingReasons: ["candidate.discarded"],
  };
}

export type ConfirmIntent =
  | ({ readonly status: "ready-for-durable-promotion"; readonly turnId: string } & CandidateConfirmationBinding)
  | { readonly status: "blocked"; readonly reasonCodes: readonly string[] };

export function requestConfirmIntent(candidate: CandidateProjection): ConfirmIntent {
  return candidate.canConfirm && candidate.confirmationBinding !== undefined
    ? { status: "ready-for-durable-promotion", turnId: candidate.turnId, ...candidate.confirmationBinding }
    : { status: "blocked", reasonCodes: candidate.blockingReasons };
}
