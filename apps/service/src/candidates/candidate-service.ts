import {
  discardCandidate,
  evaluateBundle,
  projectCandidate,
  requestConfirmIntent,
  type CandidateProjection,
  type ConfirmIntent,
  type EvidenceDescriptor,
  type EvaluatedBundle,
  type FinalizationInput,
  type NominationResult,
  type PrivacyPassReceipt,
  type PrivacyQuarantineReceipt,
} from "@remo/domain";

export type PrivacyCaptureResult =
  | { readonly status: "passed"; readonly evidence: { readonly rrwebBytes: Buffer; readonly screenshotBytes: Buffer; readonly receipt: PrivacyPassReceipt } }
  | { readonly status: "quarantined"; readonly receipt: PrivacyQuarantineReceipt };

export type CandidateReviewRecord =
  | {
      readonly status: "reviewable";
      readonly projection: CandidateProjection;
      readonly safeEvidence: Extract<PrivacyCaptureResult, { status: "passed" }>["evidence"];
      readonly finalization: FinalizationInput;
      readonly evaluated: EvaluatedBundle;
      readonly createdAt: string;
      readonly manifestDigest: string;
    }
  | { readonly status: "quarantined"; readonly projection: CandidateProjection; readonly receipt: PrivacyQuarantineReceipt };

function safeDescriptors(descriptors: readonly EvidenceDescriptor[], privacy: Extract<PrivacyCaptureResult, { status: "passed" }>["evidence"]): readonly EvidenceDescriptor[] {
  return descriptors.map((descriptor) => descriptor.componentType === "rrweb"
    ? { ...descriptor, digest: privacy.receipt.rrwebDigest, blobRef: `memory:${privacy.receipt.rrwebDigest}` }
    : descriptor.componentType === "screenshot"
      ? { ...descriptor, digest: privacy.receipt.screenshotDigest, blobRef: `memory:${privacy.receipt.screenshotDigest}` }
      : descriptor);
}

export function createCandidateReview(input: {
  readonly finalization: Omit<FinalizationInput, "privacy" | "evidence"> & { readonly evidence: readonly EvidenceDescriptor[] };
  readonly nomination: NominationResult;
  readonly privacyCapture: PrivacyCaptureResult;
  readonly createdAt: string;
}): CandidateReviewRecord {
  if (input.privacyCapture.status === "quarantined") {
    const integrity = { state: "quarantined", reasonCodes: ["privacy.failed"], componentIds: [...input.privacyCapture.receipt.failedComponents] } as const;
    return {
      status: "quarantined",
      receipt: input.privacyCapture.receipt,
      projection: projectCandidate({ turnId: input.finalization.correlation.turnId, nomination: input.nomination, evidence: [], privacy: input.privacyCapture.receipt, integrity, fidelity: { state: "unavailable", reasonCodes: ["privacy.failed"] }, createdAt: input.createdAt }),
    };
  }
  const evidence = safeDescriptors(input.finalization.evidence, input.privacyCapture.evidence);
  const finalization: FinalizationInput = { ...input.finalization, evidence, privacy: { status: "passed", reasonCodes: [] } };
  const evaluated = evaluateBundle(finalization);
  return {
    status: "reviewable",
    safeEvidence: input.privacyCapture.evidence,
    finalization,
    evaluated,
    createdAt: input.createdAt,
    manifestDigest: evaluated.manifestDigest,
    projection: projectCandidate({
      turnId: input.finalization.correlation.turnId,
      nomination: input.nomination,
      evidence,
      privacy: input.privacyCapture.evidence.receipt,
      integrity: evaluated.integrity,
      fidelity: evaluated.fidelity,
      createdAt: input.createdAt,
      confirmationBinding: { savePointId: input.finalization.savePointId, candidateRevision: 1, candidateManifestDigest: evaluated.manifestDigest },
    }),
  };
}

export function discardCandidateReview(record: CandidateReviewRecord): CandidateProjection {
  if (record.status === "reviewable") {
    record.safeEvidence.rrwebBytes.fill(0);
    record.safeEvidence.screenshotBytes.fill(0);
  }
  return discardCandidate(record.projection);
}

export function confirmCandidateIntent(record: CandidateReviewRecord): ConfirmIntent {
  return requestConfirmIntent(record.projection);
}
