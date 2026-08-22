import {
  BUNDLE_SCHEMA_VERSION,
  REQUIRED_COMPONENT_TYPES,
  STABLE_ID_VERSION,
  type BundleManifest,
  type CorrelationTuple,
  type EvidenceDescriptor,
  type EvaluatedBundle,
  type FidelityEvaluation,
  type FinalizationInput,
  type IntegrityEvaluation,
  type ReasonCode,
} from "./contracts.js";
import { canonicalSerialize, sha256Canonical } from "./canonical.js";

interface EvaluationFindings {
  readonly reasons: Set<ReasonCode>;
  readonly componentIds: Set<string>;
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const W3C_TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/;

function assertStableUlid(name: string, value: string): void {
  if (!ULID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a canonical ULID`);
  }
}

function addFinding(
  findings: EvaluationFindings,
  reason: ReasonCode,
  componentId?: string,
): void {
  findings.reasons.add(reason);
  if (componentId !== undefined) {
    findings.componentIds.add(componentId);
  }
}

function compareCorrelation(
  expected: CorrelationTuple,
  descriptor: EvidenceDescriptor,
  missing: EvaluationFindings,
  conflicts: EvaluationFindings,
): void {
  const fields: ReadonlyArray<
    readonly [keyof CorrelationTuple, ReasonCode]
  > = [
    ["projectId", "correlation.project-mismatch"],
    ["turnId", "correlation.turn-mismatch"],
    ["captureWindowId", "correlation.window-mismatch"],
    ["boundaryRevision", "correlation.boundary-mismatch"],
  ];

  for (const [field, mismatchReason] of fields) {
    const actual = descriptor.correlation[field];
    if (actual === undefined || actual.length === 0) {
      addFinding(missing, "evidence.correlation-proof-missing", descriptor.componentId);
    } else if (actual !== expected[field]) {
      addFinding(conflicts, mismatchReason, descriptor.componentId);
    }
  }
}

function findClaimConflicts(
  descriptors: readonly EvidenceDescriptor[],
  claim: "sourceState" | "fixtureId",
  reason: ReasonCode,
  findings: EvaluationFindings,
): void {
  const values = new Set(
    descriptors
      .map((descriptor) => descriptor.claims?.[claim])
      .filter((value): value is string => value !== undefined),
  );
  if (values.size > 1) {
    for (const descriptor of descriptors) {
      if (descriptor.claims?.[claim] !== undefined) {
        addFinding(findings, reason, descriptor.componentId);
      }
    }
  }
}

function toEvaluation(
  state: IntegrityEvaluation["state"],
  findings: EvaluationFindings,
): IntegrityEvaluation {
  return {
    state,
    reasonCodes: [...findings.reasons].sort(),
    componentIds: [...findings.componentIds].sort(),
  };
}

function evaluateIntegrity(input: FinalizationInput): IntegrityEvaluation {
  if (input.privacy.status === "failed") {
    const privacyFindings: EvaluationFindings = {
      reasons: new Set(["privacy.failed"]),
      componentIds: new Set(input.privacy.failedComponentIds ?? []),
    };
    return toEvaluation("quarantined", privacyFindings);
  }

  const conflicts: EvaluationFindings = {
    reasons: new Set(),
    componentIds: new Set(),
  };
  const missing: EvaluationFindings = {
    reasons: new Set(),
    componentIds: new Set(),
  };
  const byType = new Map<string, EvidenceDescriptor[]>();

  for (const descriptor of input.evidence) {
    const descriptors = byType.get(descriptor.componentType) ?? [];
    descriptors.push(descriptor);
    byType.set(descriptor.componentType, descriptors);
    compareCorrelation(input.correlation, descriptor, missing, conflicts);

    if (descriptor.policyRevision !== input.policyRevision) {
      addFinding(conflicts, "policy.revision-mismatch", descriptor.componentId);
    }
    if (descriptor.availability !== "available") {
      addFinding(missing, "evidence.unavailable", descriptor.componentId);
    }
    if (descriptor.digest === undefined || descriptor.digest.length === 0) {
      addFinding(missing, "evidence.digest-missing", descriptor.componentId);
    }
    if (
      descriptor.componentType === "trace" &&
      (descriptor.externalId === undefined ||
        !W3C_TRACE_ID_PATTERN.test(descriptor.externalId))
    ) {
      addFinding(missing, "trace.id-proof-missing", descriptor.componentId);
    }
  }

  for (const componentType of REQUIRED_COMPONENT_TYPES) {
    const descriptors = byType.get(componentType) ?? [];
    if (descriptors.length === 0) {
      addFinding(missing, "evidence.component-missing", componentType);
    } else if (descriptors.length > 1) {
      for (const descriptor of descriptors) {
        addFinding(conflicts, "evidence.duplicate-component", descriptor.componentId);
      }
    }
  }

  findClaimConflicts(input.evidence, "sourceState", "source.state-mismatch", conflicts);
  findClaimConflicts(input.evidence, "fixtureId", "fixture.identity-mismatch", conflicts);

  if (conflicts.reasons.size > 0) {
    return toEvaluation("inconsistent", conflicts);
  }
  if (missing.reasons.size > 0) {
    return toEvaluation("incomplete", missing);
  }
  return toEvaluation("complete", { reasons: new Set(), componentIds: new Set() });
}

function evaluateFidelity(
  integrity: IntegrityEvaluation,
  evidence: readonly EvidenceDescriptor[],
): FidelityEvaluation {
  if (integrity.state === "complete") {
    return { state: "editable-eligible", reasonCodes: [] };
  }
  if (integrity.state === "quarantined") {
    return { state: "unavailable", reasonCodes: integrity.reasonCodes };
  }

  const renderedEvidenceAvailable = evidence.some(
    ({ componentType, availability }) =>
      (componentType === "rrweb" || componentType === "screenshot") &&
      availability === "available",
  );
  if (!renderedEvidenceAvailable) {
    return { state: "unavailable", reasonCodes: integrity.reasonCodes };
  }
  return {
    state: integrity.state === "inconsistent" ? "historical-only" : "degraded",
    reasonCodes: integrity.reasonCodes,
  };
}

function compareCanonicalDescriptors(
  left: EvidenceDescriptor,
  right: EvidenceDescriptor,
): number {
  const leftCanonical = canonicalSerialize(left);
  const rightCanonical = canonicalSerialize(right);
  return leftCanonical < rightCanonical
    ? -1
    : leftCanonical > rightCanonical
      ? 1
      : 0;
}

export function evaluateBundle(input: FinalizationInput): EvaluatedBundle {
  if (input.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new TypeError("Unsupported bundle schema");
  }
  if (input.identityVersion !== STABLE_ID_VERSION) {
    throw new TypeError("Unsupported identity version");
  }
  assertStableUlid("turnId", input.correlation.turnId);
  assertStableUlid("savePointId", input.savePointId);

  const evidence = input.evidence
    .map((descriptor) => {
      const safeDescriptor = { ...descriptor };
      if (input.privacy.status === "failed") {
        delete safeDescriptor.blobRef;
      }
      return safeDescriptor;
    })
    .sort(compareCanonicalDescriptors);
  const integrity = evaluateIntegrity({ ...input, evidence });
  const fidelity = evaluateFidelity(integrity, evidence);
  const manifest: BundleManifest = {
    schemaVersion: input.schemaVersion,
    identityVersion: input.identityVersion,
    policyRevision: input.policyRevision,
    savePointId: input.savePointId,
    correlation: input.correlation,
    privacy: {
      status: input.privacy.status,
      reasonCodes: [...input.privacy.reasonCodes].sort(),
    },
    evidence,
    integrity,
    fidelity,
  };
  const canonicalManifest = canonicalSerialize(manifest);

  return {
    manifest,
    canonicalManifest,
    manifestDigest: sha256Canonical(manifest),
    integrity,
    fidelity,
    promotionAllowed: integrity.state === "complete",
  };
}
