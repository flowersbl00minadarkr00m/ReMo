import {
  assertDecisionRecord,
  assertDecisionTransition,
  buildDecisionRecord,
  canonicalSerialize,
  DecisionValidationError,
  type DecisionContent,
  type DecisionField,
  type DecisionFieldName,
  type DecisionMutation,
  type DecisionProvenance,
  type DecisionRecord,
} from "@remo/domain";
import { FoundationConflictError, type DecisionRevisionAppend, type DecisionRevisionRead, type DecisionRevisionReceipt } from "@remo/storage-local";

export interface DecisionIdentity {
  readonly savePointId: string;
  readonly turnId: string;
  readonly evidenceComponentIds: readonly string[];
  readonly candidateRevision?: number;
  readonly candidateManifestDigest?: string;
}

export interface DecisionRepository {
  appendDecisionRevision(request: DecisionRevisionAppend): DecisionRevisionReceipt;
  readDecisionRevisions(savePointId: string): readonly DecisionRevisionRead[];
  readLatestDecisionRevision(savePointId: string): DecisionRevisionRead | undefined;
}

export interface DecisionFieldInput<T = unknown> {
  readonly value?: T;
  readonly provenance: DecisionProvenance;
  readonly sourceComponentIds: readonly string[];
}

export interface DecisionContentInput {
  readonly question: DecisionFieldInput<string>;
  readonly options: DecisionFieldInput<readonly { readonly id: string; readonly label: string }[]>;
  readonly selectedOptionId: DecisionFieldInput<string>;
  readonly owner: DecisionFieldInput<string>;
  readonly uncertainty: DecisionFieldInput<{ readonly level: "low" | "medium" | "high" | "unknown"; readonly source: "human" | "agent-observable" | "unknown" }>;
  readonly evidenceComponentIds: readonly string[];
  readonly expectedEffect: DecisionFieldInput<string>;
  readonly verification: DecisionFieldInput<string>;
  readonly outcome: DecisionFieldInput<string>;
}

export type DurableDecisionMutationRequest =
  | { readonly expectedRevision: number; readonly mutation: "confirm-inferred"; readonly fields: readonly DecisionFieldName[] }
  | { readonly expectedRevision: number; readonly mutation: "reconstructed-supplement" | "correction"; readonly changes: Readonly<Partial<Record<DecisionFieldName, DecisionFieldInput>>>; readonly evidenceComponentIds?: readonly string[] };

export interface DecisionProjection {
  readonly current: DecisionRecord;
  readonly revisions: readonly DecisionRecord[];
}

export class DecisionServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "DecisionServiceError";
  }
}

const FIELD_NAMES: readonly DecisionFieldName[] = ["question", "options", "selectedOptionId", "owner", "uncertainty", "expectedEffect", "verification", "outcome"];

function latest(repository: DecisionRepository, savePointId: string): DecisionRecord | undefined {
  const row = repository.readLatestDecisionRevision(savePointId);
  return row === undefined ? undefined : assertDecisionRecord(row.canonicalRecord);
}

function assertAllowedEvidence(record: DecisionRecord, allowed: readonly string[]): void {
  const allowlist = new Set(allowed);
  const references = [
    ...record.evidenceComponentIds,
    ...FIELD_NAMES.flatMap((name) => record[name].sourceComponentIds),
  ];
  if (references.some((componentId) => !allowlist.has(componentId))) throw new DecisionServiceError("decision.evidence-unavailable", "Decision evidence must resolve to an available component on the same turn.", 400);
}

function stampedField(input: DecisionFieldInput, recordedAt: string): DecisionField<unknown> {
  return {
    ...(input.value === undefined ? {} : { value: input.value }),
    provenance: input.provenance,
    sourceComponentIds: input.sourceComponentIds,
    recordedAt,
  };
}

function stampedContent(input: DecisionContentInput, recordedAt: string): DecisionContent {
  return {
    question: stampedField(input.question, recordedAt) as DecisionContent["question"],
    options: stampedField(input.options, recordedAt) as DecisionContent["options"],
    selectedOptionId: stampedField(input.selectedOptionId, recordedAt) as DecisionContent["selectedOptionId"],
    owner: stampedField(input.owner, recordedAt) as DecisionContent["owner"],
    uncertainty: stampedField(input.uncertainty, recordedAt) as DecisionContent["uncertainty"],
    evidenceComponentIds: input.evidenceComponentIds,
    expectedEffect: stampedField(input.expectedEffect, recordedAt) as DecisionContent["expectedEffect"],
    verification: stampedField(input.verification, recordedAt) as DecisionContent["verification"],
    outcome: stampedField(input.outcome, recordedAt) as DecisionContent["outcome"],
  };
}

function append(repository: DecisionRepository, record: DecisionRecord, recordedAt: string): DecisionRecord {
  repository.appendDecisionRevision({ savePointId: record.savePointId, turnId: record.turnId, revision: record.revision, ...(record.predecessorDigest === undefined ? {} : { predecessorDigest: record.predecessorDigest }), canonicalRecord: record, expectedDigest: record.digest, recordedAt });
  return record;
}

function candidateRecord(request: { readonly decisionId: string; readonly content: DecisionContentInput }, identity: DecisionIdentity, recordedAt: string): DecisionRecord {
  return buildDecisionRecord({ decisionId: request.decisionId, savePointId: identity.savePointId, turnId: identity.turnId, revision: 1, ...stampedContent(request.content, recordedAt) });
}

function candidateRecordAllowed(record: DecisionRecord, allowedEvidence: readonly string[]): void {
  if (FIELD_NAMES.some((name) => !["user-supplied", "inferred", "unknown"].includes(record[name].provenance))) throw new DecisionServiceError("decision.candidate-provenance-invalid", "Candidate entry accepts only user-supplied, inferred, or unknown provenance.", 400);
  assertAllowedEvidence(record, allowedEvidence);
}

function serviceError(error: unknown): never {
  if (error instanceof DecisionServiceError) throw error;
  if (error instanceof DecisionValidationError) throw new DecisionServiceError(error.code, error.message, 400);
  if (error instanceof FoundationConflictError) throw new DecisionServiceError(error.code, error.message, 409);
  throw error;
}

export function createDecisionService(options: {
  readonly repository: DecisionRepository;
  readonly findCandidate: (turnId: string) => DecisionIdentity | undefined;
  readonly findDurable: (savePointId: string) => DecisionIdentity | undefined;
  readonly now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const projection = (identity: DecisionIdentity): DecisionProjection | undefined => {
    const revisions = options.repository.readDecisionRevisions(identity.savePointId).map(({ canonicalRecord }) => assertDecisionRecord(canonicalRecord));
    if (revisions.length === 0) return undefined;
    for (let index = 0; index < revisions.length; index += 1) {
      const record = revisions[index]!;
      if (record.savePointId !== identity.savePointId || record.turnId !== identity.turnId || record.revision !== index + 1 || (index === 0 ? record.predecessorDigest !== undefined : record.predecessorDigest !== revisions[index - 1]!.digest)) throw new DecisionServiceError("decision.chain-invalid", "Stored decision revision chain is inconsistent.", 409);
      assertAllowedEvidence(record, identity.evidenceComponentIds);
    }
    return { current: revisions.at(-1)!, revisions };
  };
  return {
    createCandidate(turnId: string, request: { readonly expectedCandidateRevision: number; readonly expectedCandidateManifestDigest: string; readonly decisionId: string; readonly content: DecisionContentInput }): DecisionRecord {
      try {
        const identity = options.findCandidate(turnId);
        if (identity === undefined) throw new DecisionServiceError("decision.candidate-unavailable", "Candidate decision entry is unavailable.", 404);
        if (identity.turnId !== turnId || identity.candidateRevision !== request.expectedCandidateRevision || identity.candidateManifestDigest !== request.expectedCandidateManifestDigest) throw new DecisionServiceError("decision.candidate-stale", "Candidate revision or manifest digest is stale.", 409);
        const existing = latest(options.repository, identity.savePointId);
        if (existing !== undefined) {
          const repeated = candidateRecord(request, identity, existing.question.recordedAt);
          candidateRecordAllowed(repeated, identity.evidenceComponentIds);
          if (repeated.digest === existing.digest) return existing;
          throw new DecisionServiceError("decision.revision-conflict", "Candidate decision identity is already bound to different canonical evidence.", 409);
        }
        const recordedAt = now().toISOString();
        const record = candidateRecord(request, identity, recordedAt);
        candidateRecordAllowed(record, identity.evidenceComponentIds);
        return append(options.repository, record, recordedAt);
      } catch (error) { return serviceError(error); }
    },

    readCandidate(turnId: string): DecisionProjection | undefined {
      const identity = options.findCandidate(turnId);
      return identity === undefined || identity.turnId !== turnId ? undefined : projection(identity);
    },

    read(savePointId: string): DecisionProjection | undefined {
      const identity = options.findDurable(savePointId);
      return identity === undefined ? undefined : projection(identity);
    },

    revise(savePointId: string, request: DurableDecisionMutationRequest): DecisionRecord {
      try {
        const identity = options.findDurable(savePointId);
        if (identity === undefined) throw new DecisionServiceError("decision.save-point-unavailable", "Durable decision evidence is unavailable.", 404);
        const previous = latest(options.repository, savePointId);
        if (previous === undefined) throw new DecisionServiceError("decision.not-found", "No structured decision record exists for this save point.", 404);
        if (request.expectedRevision !== previous.revision) throw new DecisionServiceError("decision.revision-conflict", "Expected decision revision is stale.", 409);
        const recordedAt = now().toISOString();
        const draft = { ...previous, revision: previous.revision + 1, predecessorDigest: previous.digest } as Record<string, unknown>;
        delete draft.digest;
        if (request.mutation === "confirm-inferred") {
          if (request.fields.length < 1 || new Set(request.fields).size !== request.fields.length || request.fields.some((name) => !FIELD_NAMES.includes(name))) throw new DecisionServiceError("decision.confirmation-invalid", "Confirmation fields are empty, duplicated, or unsupported.", 400);
          for (const name of request.fields) draft[name] = { ...(previous[name] as DecisionField<unknown>), confirmedAt: recordedAt };
        } else {
          const changes = Object.entries(request.changes);
          if (changes.length < 1 || changes.some(([name]) => !FIELD_NAMES.includes(name as DecisionFieldName))) throw new DecisionServiceError("decision.mutation-invalid", "Decision mutation fields are empty or unsupported.", 400);
          for (const [name, value] of changes) draft[name] = stampedField(value, recordedAt);
          if (request.evidenceComponentIds !== undefined) draft.evidenceComponentIds = request.evidenceComponentIds;
        }
        const next = buildDecisionRecord(draft as unknown as Omit<DecisionRecord, "schemaVersion" | "digest">);
        assertDecisionTransition(previous, next, request.mutation as DecisionMutation);
        assertAllowedEvidence(next, identity.evidenceComponentIds);
        return append(options.repository, next, recordedAt);
      } catch (error) { return serviceError(error); }
    },
  };
}

export type DecisionService = ReturnType<typeof createDecisionService>;

export function stableDecisionProjection(value: DecisionProjection): string {
  return canonicalSerialize(value);
}
