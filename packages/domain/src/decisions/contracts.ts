import { canonicalSerialize, sha256Canonical } from "../canonical.js";

export const DECISION_SCHEMA_VERSION = "remo.decision.v1" as const;
export const MAX_DECISION_TEXT_LENGTH = 512;
export const MAX_DECISION_OPTION_LABEL_LENGTH = 160;
export const MAX_DECISION_OPTIONS = 8;
export const MAX_DECISION_EVIDENCE_REFERENCES = 16;

export type DecisionProvenance = "observed" | "user-supplied" | "inferred" | "reconstructed" | "unknown";
export type DecisionFieldName = "question" | "options" | "selectedOptionId" | "owner" | "uncertainty" | "expectedEffect" | "verification" | "outcome";
export type DecisionMutation = "confirm-inferred" | "reconstructed-supplement" | "correction";

export interface DecisionField<T> {
  readonly value?: T;
  readonly provenance: DecisionProvenance;
  readonly sourceComponentIds: readonly string[];
  readonly recordedAt: string;
  readonly confirmedAt?: string;
}

export interface DecisionOption {
  readonly id: string;
  readonly label: string;
}

export interface DecisionUncertainty {
  readonly level: "low" | "medium" | "high" | "unknown";
  readonly source: "human" | "agent-observable" | "unknown";
}

export interface DecisionContent {
  readonly question: DecisionField<string>;
  readonly options: DecisionField<readonly DecisionOption[]>;
  readonly selectedOptionId: DecisionField<string>;
  readonly owner: DecisionField<string>;
  readonly uncertainty: DecisionField<DecisionUncertainty>;
  readonly evidenceComponentIds: readonly string[];
  readonly expectedEffect: DecisionField<string>;
  readonly verification: DecisionField<string>;
  readonly outcome: DecisionField<string>;
}

export interface DecisionRecord extends DecisionContent {
  readonly schemaVersion: typeof DECISION_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly predecessorDigest?: string;
  readonly digest: string;
}

export class DecisionValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DecisionValidationError";
  }
}

function fail(code: string, message: string): never {
  throw new DecisionValidationError(code, message);
}

function assertIdentity(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) fail("decision.identity-invalid", `${label} is malformed.`);
  return value;
}

function assertDigest(value: string, label: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) fail("decision.digest-invalid", `${label} is malformed.`);
  return value;
}

function timestamp(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) fail("decision.timestamp-invalid", `${label} must be an exact UTC ISO timestamp.`);
  return value;
}

function plainText(value: string, label: string, maximum = MAX_DECISION_TEXT_LENGTH): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > maximum) fail("decision.text-invalid", `${label} must contain 1-${maximum} normalized characters.`);
  if (/[<>]/u.test(normalized) || /(?:https?:\/\/|www\.|javascript:|data:text\/html)/iu.test(normalized)) fail("decision.unsafe-text", `${label} cannot contain HTML or an arbitrary URL.`);
  if (/\p{Cc}/u.test(normalized)) fail("decision.text-invalid", `${label} contains a control character.`);
  return normalized;
}

function componentIds(values: readonly string[], turnId: string, label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_DECISION_EVIDENCE_REFERENCES) fail("decision.evidence-invalid", `${label} has too many evidence references.`);
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}:[A-Za-z0-9._-]{1,64}$/u.test(value) || !value.startsWith(`${turnId}:`)) fail("decision.evidence-cross-turn", `${label} must reference this decision turn.`);
    return value;
  });
  if (new Set(normalized).size !== normalized.length) fail("decision.evidence-invalid", `${label} contains duplicate evidence references.`);
  return [...normalized].sort((left, right) => left.localeCompare(right, "en-US"));
}

function field<T>(input: DecisionField<T>, turnId: string, label: string, normalizeValue: (value: T) => T): DecisionField<T> {
  if (input === null || typeof input !== "object" || !["observed", "user-supplied", "inferred", "reconstructed", "unknown"].includes(input.provenance)) fail("decision.provenance-invalid", `${label} provenance is invalid.`);
  const recordedAt = timestamp(input.recordedAt, `${label}.recordedAt`);
  const sources = componentIds(input.sourceComponentIds, turnId, `${label}.sourceComponentIds`);
  if (input.provenance === "unknown") {
    if (input.value !== undefined || input.confirmedAt !== undefined || sources.length !== 0) fail("decision.unknown-invalid", `${label} must remain valueless, unconfirmed, and unsourced when unknown.`);
    return { provenance: "unknown", sourceComponentIds: [], recordedAt };
  }
  if (input.value === undefined) fail("decision.value-required", `${label} requires a value for ${input.provenance} provenance.`);
  const confirmedAt = input.confirmedAt === undefined ? undefined : timestamp(input.confirmedAt, `${label}.confirmedAt`);
  if (confirmedAt !== undefined && input.provenance !== "inferred") fail("decision.confirmation-invalid", `${label} confirmation cannot change provenance or confirm a non-inferred value.`);
  if (confirmedAt !== undefined && Date.parse(confirmedAt) < Date.parse(recordedAt)) fail("decision.confirmation-invalid", `${label} confirmation predates its value.`);
  return { value: normalizeValue(input.value), provenance: input.provenance, sourceComponentIds: sources, recordedAt, ...(confirmedAt === undefined ? {} : { confirmedAt }) };
}

function textField(input: DecisionField<string>, turnId: string, label: string): DecisionField<string> {
  return field(input, turnId, label, (value) => plainText(value, label));
}

function optionsField(input: DecisionField<readonly DecisionOption[]>, turnId: string): DecisionField<readonly DecisionOption[]> {
  return field(input, turnId, "options", (values) => {
    if (!Array.isArray(values) || values.length < 1 || values.length > MAX_DECISION_OPTIONS) fail("decision.options-invalid", `options must contain 1-${MAX_DECISION_OPTIONS} entries.`);
    const normalized = (values as readonly unknown[]).map((option, index) => {
      if (option === null || typeof option !== "object") fail("decision.options-invalid", `options[${index}] is malformed.`);
      const candidate = option as { readonly id?: unknown; readonly label?: unknown };
      if (typeof candidate.id !== "string" || typeof candidate.label !== "string") fail("decision.options-invalid", `options[${index}] requires plain-text identity and label values.`);
      return { id: assertIdentity(candidate.id, `options[${index}].id`), label: plainText(candidate.label, `options[${index}].label`, MAX_DECISION_OPTION_LABEL_LENGTH) };
    });
    if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) fail("decision.options-invalid", "Option identities must be unique.");
    return normalized;
  });
}

function uncertaintyField(input: DecisionField<DecisionUncertainty>, turnId: string): DecisionField<DecisionUncertainty> {
  return field(input, turnId, "uncertainty", (value) => {
    if (!["low", "medium", "high", "unknown"].includes(value.level) || !["human", "agent-observable", "unknown"].includes(value.source)) fail("decision.uncertainty-invalid", "Uncertainty level or source is unsupported.");
    if ((value.level === "unknown") !== (value.source === "unknown")) fail("decision.uncertainty-invalid", "Unknown uncertainty requires an unknown source, and known uncertainty requires a named source.");
    if (input.provenance === "user-supplied" && value.source !== "human") fail("decision.uncertainty-invalid", "User-supplied uncertainty must name the human source.");
    if ((input.provenance === "inferred" || input.provenance === "observed") && value.source !== "agent-observable") fail("decision.uncertainty-invalid", "Observable or inferred uncertainty must name the observable-evidence source.");
    return { level: value.level, source: value.source };
  });
}

function canonicalPayload(record: Omit<DecisionRecord, "digest">): Omit<DecisionRecord, "digest"> {
  return record;
}

export function buildDecisionRecord(input: Omit<DecisionRecord, "schemaVersion" | "digest">): DecisionRecord {
  const decisionId = assertIdentity(input.decisionId, "decisionId");
  const savePointId = assertIdentity(input.savePointId, "savePointId");
  const turnId = assertIdentity(input.turnId, "turnId");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail("decision.revision-invalid", "Decision revision must be a positive safe integer.");
  if ((input.revision === 1) !== (input.predecessorDigest === undefined)) fail("decision.predecessor-invalid", "Only revision 1 may omit a predecessor digest.");
  const predecessorDigest = input.predecessorDigest === undefined ? undefined : assertDigest(input.predecessorDigest, "predecessorDigest");
  const normalized: Omit<DecisionRecord, "digest"> = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    decisionId,
    savePointId,
    turnId,
    revision: input.revision,
    ...(predecessorDigest === undefined ? {} : { predecessorDigest }),
    question: textField(input.question, turnId, "question"),
    options: optionsField(input.options, turnId),
    selectedOptionId: textField(input.selectedOptionId, turnId, "selectedOptionId"),
    owner: textField(input.owner, turnId, "owner"),
    uncertainty: uncertaintyField(input.uncertainty, turnId),
    evidenceComponentIds: componentIds(input.evidenceComponentIds, turnId, "evidenceComponentIds"),
    expectedEffect: textField(input.expectedEffect, turnId, "expectedEffect"),
    verification: textField(input.verification, turnId, "verification"),
    outcome: textField(input.outcome, turnId, "outcome"),
  };
  const selected = normalized.selectedOptionId.value;
  if (selected !== undefined && normalized.options.value !== undefined && !normalized.options.value.some(({ id }) => id === selected)) fail("decision.selection-invalid", "The selected option does not exist in the recorded options.");
  const digest = sha256Canonical(canonicalPayload(normalized));
  return { ...normalized, digest };
}

export function assertDecisionRecord(value: unknown): DecisionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("decision.record-invalid", "Decision record must be an object.");
  const record = value as DecisionRecord;
  if (record.schemaVersion !== DECISION_SCHEMA_VERSION || typeof record.digest !== "string") fail("decision.record-invalid", "Decision schema or digest is invalid.");
  const rebuilt = buildDecisionRecord(record);
  if (rebuilt.digest !== record.digest || canonicalSerialize(rebuilt) !== canonicalSerialize(record)) fail("decision.digest-invalid", "Decision record does not match its canonical digest.");
  return rebuilt;
}

function changedFields(previous: DecisionRecord, next: DecisionRecord): readonly DecisionFieldName[] {
  const names: readonly DecisionFieldName[] = ["question", "options", "selectedOptionId", "owner", "uncertainty", "expectedEffect", "verification", "outcome"];
  return names.filter((name) => canonicalSerialize(previous[name]) !== canonicalSerialize(next[name]));
}

export function assertDecisionTransition(previousValue: unknown, nextValue: unknown, mutation: DecisionMutation): DecisionRecord {
  const previous = assertDecisionRecord(previousValue);
  const next = assertDecisionRecord(nextValue);
  if (next.decisionId !== previous.decisionId || next.savePointId !== previous.savePointId || next.turnId !== previous.turnId || next.revision !== previous.revision + 1 || next.predecessorDigest !== previous.digest) fail("decision.revision-conflict", "Decision successor identity, revision, or predecessor is stale.");
  const changed = changedFields(previous, next);
  if (changed.length === 0 && canonicalSerialize(previous.evidenceComponentIds) === canonicalSerialize(next.evidenceComponentIds)) fail("decision.mutation-empty", "Decision revision does not change any supported evidence.");
  if (mutation === "confirm-inferred") {
    if (canonicalSerialize(previous.evidenceComponentIds) !== canonicalSerialize(next.evidenceComponentIds)) fail("decision.confirmation-invalid", "Confirmation cannot replace evidence references.");
    for (const name of changed) {
      const before = previous[name] as DecisionField<unknown>;
      const after = next[name] as DecisionField<unknown>;
      const beforeWithoutConfirmation = { ...before, confirmedAt: undefined };
      const afterWithoutConfirmation = { ...after, confirmedAt: undefined };
      if (before.provenance !== "inferred" || after.provenance !== "inferred" || before.confirmedAt !== undefined || after.confirmedAt === undefined || canonicalSerialize(beforeWithoutConfirmation) !== canonicalSerialize(afterWithoutConfirmation)) fail("decision.confirmation-invalid", `${name} confirmation must preserve the inferred value and provenance.`);
    }
  } else if (mutation === "reconstructed-supplement") {
    for (const name of changed) {
      const before = previous[name] as DecisionField<unknown>;
      const after = next[name] as DecisionField<unknown>;
      if (before.provenance !== "unknown" || after.provenance !== "reconstructed") fail("decision.supplement-invalid", `${name} supplements may only add reconstructed evidence to an unknown field.`);
    }
  } else {
    for (const name of changed) {
      const after = next[name] as DecisionField<unknown>;
      if (after.provenance === "observed") fail("decision.correction-invalid", `${name} cannot be corrected into retroactive observed provenance.`);
    }
  }
  return next;
}
