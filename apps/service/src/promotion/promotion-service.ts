import { createHash } from "node:crypto";
import { evaluateBundle, type ConfirmIntent, type EvidenceDescriptor } from "@remo/domain";
import type { DurableSaveReceipt, SavePointRepository } from "@remo/storage-local";
import type { CandidateReviewRecord } from "../candidates/candidate-service.js";

export interface DurableSaveProjection {
  readonly status: "durable";
  readonly turnId: string;
  readonly savePointId: string;
  readonly revision: number;
  readonly manifestDigest: string;
  readonly createdAt: string;
  readonly promotedAt: string;
  readonly expiresAt: string;
  readonly pinned: false;
  readonly health: "complete";
  readonly fidelity: "editable-eligible";
}

export class PromotionError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "PromotionError";
  }
}

function operationId(turnId: string): string {
  return `promote-${createHash("sha256").update(turnId).digest("hex").slice(0, 24)}`;
}

function durableBlobRef(digest: string): string {
  const hex = digest.slice("sha256:".length);
  return `blobs/sha256/${hex.slice(0, 2)}/${hex}`;
}

function withDurableBlobRefs(evidence: readonly EvidenceDescriptor[]): readonly EvidenceDescriptor[] {
  return evidence.map((descriptor) =>
    (descriptor.componentType === "rrweb" || descriptor.componentType === "screenshot") && descriptor.digest !== undefined
      ? { ...descriptor, blobRef: durableBlobRef(descriptor.digest) }
      : descriptor,
  );
}

function browserProjection(receipt: DurableSaveReceipt): DurableSaveProjection {
  if (receipt.health !== "complete") throw new PromotionError("promotion.materialization-incomplete", "The durable identity exists, but its local manifest is incomplete. Retry to reconcile the same identity.", true);
  return {
    status: "durable",
    turnId: receipt.turnId,
    savePointId: receipt.savePointId,
    revision: receipt.revision,
    manifestDigest: receipt.manifestDigest,
    createdAt: receipt.createdAt,
    promotedAt: receipt.promotedAt,
    expiresAt: receipt.expiresAt,
    pinned: false,
    health: "complete",
    fidelity: "editable-eligible",
  };
}

export function createPromotionService(repository: SavePointRepository): {
  promote(record: CandidateReviewRecord | undefined, intent: ConfirmIntent): Promise<DurableSaveProjection>;
} {
  return {
    promote(record, intent) {
      return Promise.resolve().then(() => {
        if (intent.status !== "ready-for-durable-promotion") throw new PromotionError("promotion.confirmation-required", "Explicit durable confirmation is required.", false);
        const existing = repository.getDurable(intent.turnId);
        if (existing !== undefined) {
          if (existing.savePointId !== intent.savePointId || existing.candidateRevision !== intent.candidateRevision || existing.candidateManifestDigest !== intent.candidateManifestDigest) {
            throw new PromotionError("promotion.candidate-binding-stale", "Confirmation does not match the committed candidate identity.", false);
          }
          return browserProjection(existing);
        }
        if (record === undefined) throw new PromotionError("promotion.candidate-not-found", "The candidate is no longer available and no matching durable save exists.", false);
        if (record.status !== "reviewable") throw new PromotionError("promotion.candidate-not-reviewable", "Only a privacy-cleared reviewable candidate can be promoted.", false);
        if (intent.turnId !== record.projection.turnId || intent.turnId !== record.finalization.correlation.turnId) throw new PromotionError("promotion.turn-mismatch", "Confirmation intent does not match the candidate turn.", false);
        const binding = record.projection.confirmationBinding;
        if (binding === undefined || binding.savePointId !== intent.savePointId || binding.candidateRevision !== intent.candidateRevision || binding.candidateManifestDigest !== intent.candidateManifestDigest) {
          throw new PromotionError("promotion.candidate-binding-stale", "Confirmation does not match the current reviewed candidate identity.", false);
        }

        const fresh = evaluateBundle(record.finalization);
        if (!fresh.promotionAllowed || fresh.manifestDigest !== record.manifestDigest || record.projection.integrity.state !== fresh.integrity.state || !record.projection.canConfirm) {
          throw new PromotionError("promotion.blocking-check-changed", "Candidate blocking checks or canonical manifest changed before promotion.", false);
        }
        const durableBundle = evaluateBundle({ ...record.finalization, evidence: withDurableBlobRefs(record.finalization.evidence) });
        if (!durableBundle.promotionAllowed) throw new PromotionError("promotion.blocked", "The canonical durable manifest did not pass blocking checks.", false);

        try {
          return browserProjection(repository.promote({
            operationId: operationId(intent.turnId),
            turnId: intent.turnId,
            savePointId: record.finalization.savePointId,
            revision: 1,
            candidateRevision: intent.candidateRevision,
            candidateManifestDigest: intent.candidateManifestDigest,
            createdAt: record.createdAt,
            policyRevision: record.finalization.policyRevision,
            bundle: durableBundle.manifest,
            blobs: [
              { role: "rrweb", bytes: record.safeEvidence.rrwebBytes, expectedDigest: record.safeEvidence.receipt.rrwebDigest },
              { role: "screenshot", bytes: record.safeEvidence.screenshotBytes, expectedDigest: record.safeEvidence.receipt.screenshotDigest },
            ],
          }));
        } catch (error) {
          if (error instanceof PromotionError) throw error;
          throw new PromotionError("promotion.local-write-failed", "The local durable save could not be completed. The same confirmation can be retried safely.", true);
        }
      });
    },
  };
}
