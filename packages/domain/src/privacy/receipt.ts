export const PRIVACY_POLICY_REVISION = "remo.privacy.v1" as const;

export type PrivacyReasonCode =
  | "privacy.canary-detected"
  | "privacy.forbidden-field"
  | "privacy.origin-mismatch"
  | "privacy.frame-scope"
  | "privacy.selector-missing"
  | "privacy.selector-ambiguous"
  | "privacy.screenshot-mask-invalid";

export interface PrivacyPassReceipt {
  readonly status: "passed";
  readonly policyRevision: typeof PRIVACY_POLICY_REVISION;
  readonly rrwebDigest: string;
  readonly rrwebSize: number;
  readonly screenshotDigest: string;
  readonly screenshotSize: number;
  readonly checkedAt: string;
}

export interface PrivacyQuarantineReceipt {
  readonly status: "quarantined";
  readonly policyRevision: typeof PRIVACY_POLICY_REVISION;
  readonly reasonCodes: readonly PrivacyReasonCode[];
  readonly failedComponents: readonly ("rrweb" | "screenshot" | "boundary")[];
  readonly checkedAt: string;
}

export type PrivacyReceipt = PrivacyPassReceipt | PrivacyQuarantineReceipt;

export function createQuarantineReceipt(input: {
  readonly reasonCodes: readonly PrivacyReasonCode[];
  readonly failedComponents: readonly ("rrweb" | "screenshot" | "boundary")[];
  readonly checkedAt: string;
}): PrivacyQuarantineReceipt {
  return {
    status: "quarantined",
    policyRevision: PRIVACY_POLICY_REVISION,
    reasonCodes: [...new Set(input.reasonCodes)].sort(),
    failedComponents: [...new Set(input.failedComponents)].sort(),
    checkedAt: input.checkedAt,
  };
}
