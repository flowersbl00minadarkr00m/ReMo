export const EVIDENCE_MEDIA_ROLES = ["screenshot", "rrweb"] as const;
export type EvidenceMediaRole = (typeof EVIDENCE_MEDIA_ROLES)[number];

export const EVIDENCE_MEDIA_FAILURE_REASONS = [
  "media.invalid-role",
  "media.save-not-found",
  "media.lifecycle-unavailable",
  "media.quarantined",
  "media.stale-binding",
  "media.component-missing",
  "media.component-mismatch",
  "media.catalog-missing",
  "media.catalog-mismatch",
  "media.oversized",
  "media.path-invalid",
  "media.link-rejected",
  "media.missing",
  "media.size-mismatch",
  "media.digest-mismatch",
] as const;
export type EvidenceMediaFailureReason = (typeof EVIDENCE_MEDIA_FAILURE_REASONS)[number];

export interface EvidenceMediaReadRequest {
  readonly savePointId: string;
  readonly componentId: string;
  readonly role: EvidenceMediaRole;
  readonly expectedRevision: number;
  readonly expectedManifestDigest: string;
  readonly expectedDigest: string;
}

export type EvidenceMediaReadResult =
  | { readonly status: "available"; readonly savePointId: string; readonly componentId: string; readonly role: EvidenceMediaRole; readonly digest: string; readonly byteSize: number; readonly contentType: "image/png" | "application/json"; readonly bytes: Buffer }
  | { readonly status: "unavailable"; readonly reasonCode: EvidenceMediaFailureReason };

export interface EvidenceMediaReader {
  readEvidenceMedia(request: EvidenceMediaReadRequest): EvidenceMediaReadResult;
}

export function isEvidenceMediaRole(value: string): value is EvidenceMediaRole {
  return EVIDENCE_MEDIA_ROLES.some((role) => role === value);
}
