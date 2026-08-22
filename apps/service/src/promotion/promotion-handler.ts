import type { ConfirmIntent } from "@remo/domain";
import type { CandidateReviewRecord } from "../candidates/candidate-service.js";
import { PromotionError, type DurableSaveProjection } from "./promotion-service.js";
import type { OperationalDiagnosticsReporter } from "../support/operational-jsonl.js";

export interface PromotionHttpResponse {
  readonly status: number;
  readonly body: DurableSaveProjection | { readonly status: "failed"; readonly code: string; readonly message: string; readonly retryable: boolean };
}

export function createPromotionHandler(input: {
  readonly findCandidate: (turnId: string) => CandidateReviewRecord | undefined;
  readonly promote: (record: CandidateReviewRecord | undefined, intent: ConfirmIntent) => Promise<DurableSaveProjection>;
  readonly diagnostics?: OperationalDiagnosticsReporter;
}): (turnId: string, body: unknown) => Promise<PromotionHttpResponse> {
  const attempts = new Map<string, number>();
  return async (turnId, body) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { status: 400, body: { status: "failed", code: "promotion.invalid-confirmation-schema", message: "The exact bound confirmation JSON is required.", retryable: false } };
    const request = body as Record<string, unknown>;
    const keys = Object.keys(request).sort();
    const expected = ["candidateManifestDigest", "candidateRevision", "confirm", "savePointId"];
    const valid = keys.length === expected.length && keys.every((key, index) => key === expected[index])
      && request.confirm === true
      && typeof request.savePointId === "string" && /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(request.savePointId)
      && Number.isSafeInteger(request.candidateRevision) && Number(request.candidateRevision) > 0
      && typeof request.candidateManifestDigest === "string" && /^sha256:[0-9a-f]{64}$/u.test(request.candidateManifestDigest);
    if (!valid) {
      const code = request.confirm === true ? "promotion.invalid-confirmation-schema" : "promotion.confirmation-required";
      return { status: 400, body: { status: "failed", code, message: "The exact bound confirmation JSON is required.", retryable: false } };
    }
    const candidate = input.findCandidate(turnId);
    const startedAt = Date.now();
    const retryCount = attempts.get(turnId) ?? 0;
    attempts.set(turnId, retryCount + 1);
    try {
      const promoted = await input.promote(candidate, { status: "ready-for-durable-promotion", turnId, savePointId: request.savePointId as string, candidateRevision: request.candidateRevision as number, candidateManifestDigest: request.candidateManifestDigest as string });
      input.diagnostics?.report({ operationId: "promotion.commit", turnIds: [turnId], savePointIds: [promoted.savePointId], reasonCodes: retryCount === 0 ? [] : ["promotion.retry"], durationMs: Date.now() - startedAt, perTurnLatencyMs: Date.now() - startedAt, retryCount, sizes: candidate?.status === "reviewable" ? { eventBytes: candidate.safeEvidence.rrwebBytes.byteLength, blobBytes: candidate.safeEvidence.rrwebBytes.byteLength + candidate.safeEvidence.screenshotBytes.byteLength } : {}, digests: { manifest: [promoted.manifestDigest] }, policyVersions: candidate?.status === "reviewable" ? { privacy: candidate.finalization.policyRevision, integrity: candidate.finalization.policyRevision } : {}, outcomes: { privacy: candidate?.status === "reviewable" ? "passed" : "unavailable", integrity: "complete" }, result: "pass" });
      return { status: 200, body: promoted };
    } catch (error) {
      const failure = error instanceof PromotionError ? error : new PromotionError("promotion.unknown", "The local durable save failed.", true);
      input.diagnostics?.report({ operationId: "promotion.commit", turnIds: [turnId], savePointIds: typeof request.savePointId === "string" ? [request.savePointId] : [], reasonCodes: [failure.code], durationMs: Date.now() - startedAt, perTurnLatencyMs: Date.now() - startedAt, retryCount, sizes: candidate?.status === "reviewable" ? { eventBytes: candidate.safeEvidence.rrwebBytes.byteLength, blobBytes: candidate.safeEvidence.rrwebBytes.byteLength + candidate.safeEvidence.screenshotBytes.byteLength } : {}, digests: {}, policyVersions: candidate?.status === "reviewable" ? { privacy: candidate.finalization.policyRevision, integrity: candidate.finalization.policyRevision } : {}, outcomes: { privacy: candidate?.status === "reviewable" ? "passed" : candidate?.status === "quarantined" ? "quarantined" : "unavailable", integrity: candidate?.status === "reviewable" ? candidate.evaluated.integrity.state : "unavailable" }, result: failure.retryable ? "unavailable" : "fail" });
      return { status: failure.retryable ? 503 : 409, body: { status: "failed", code: failure.code, message: failure.message, retryable: failure.retryable } };
    }
  };
}
