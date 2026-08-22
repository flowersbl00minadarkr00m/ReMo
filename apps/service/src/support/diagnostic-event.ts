const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const OPAQUE_OPERATION_INSTANCE_ID = /^opi\.v1\.[0-9a-f]{64}$/u;
const REASON_CODE = /^[a-z0-9][a-z0-9._-]{0,159}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RESULTS = new Set<DiagnosticResult>(["pass", "degraded", "fail", "unavailable"]);
const OUTCOMES = new Set<DiagnosticOutcome>(["passed", "complete", "incomplete", "inconsistent", "quarantined", "deleted", "retained", "expired", "unavailable", "journaled", "succeeded", "failed-no-effect", "recovery-required", "exact-success", "absent", "blocked"]);
const MAX_ITEMS = 64;

export type DiagnosticResult = "pass" | "degraded" | "fail" | "unavailable";
export type DiagnosticOutcome = "passed" | "complete" | "incomplete" | "inconsistent" | "quarantined" | "deleted" | "retained" | "expired" | "unavailable" | "journaled" | "succeeded" | "failed-no-effect" | "recovery-required" | "exact-success" | "absent" | "blocked";

export interface PayloadNeutralDiagnosticEvent {
  readonly eventId: string;
  readonly operationId: string;
  readonly operationInstanceId?: string;
  readonly occurredAt?: string;
  readonly turnIds: readonly string[];
  readonly savePointIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly durationMs?: number;
  readonly perTurnLatencyMs?: number;
  readonly retryCount?: number;
  readonly sizes: Readonly<Record<string, number>>;
  readonly digests: Readonly<Record<string, readonly string[]>>;
  readonly policyVersions: Readonly<Record<string, string>>;
  readonly outcomes?: Readonly<{
    privacy?: DiagnosticOutcome;
    integrity?: DiagnosticOutcome;
    sweep?: DiagnosticOutcome;
    deletion?: DiagnosticOutcome;
    branch?: DiagnosticOutcome;
  }>;
  readonly result: DiagnosticResult;
}

function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER.test(value)) throw new TypeError(`${field} must be a bounded identifier`);
}

function assertMetric(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`${field} must be a non-negative safe integer`);
}

export function assertPayloadNeutralDiagnosticEvent(value: PayloadNeutralDiagnosticEvent): void {
  assertIdentifier(value.eventId, "eventId");
  assertIdentifier(value.operationId, "operationId");
  if (value.operationInstanceId !== undefined && !OPAQUE_OPERATION_INSTANCE_ID.test(value.operationInstanceId)) throw new TypeError("operationInstanceId must be an opaque diagnostics identity");
  if (value.occurredAt !== undefined && !Number.isFinite(Date.parse(value.occurredAt))) throw new TypeError("occurredAt must be an ISO timestamp");
  if (value.turnIds.length > MAX_ITEMS || value.savePointIds.length > MAX_ITEMS || value.reasonCodes.length > MAX_ITEMS) throw new TypeError("diagnostic collections are bounded");
  for (const id of [...value.turnIds, ...value.savePointIds]) assertIdentifier(id, "identity");
  for (const reasonCode of value.reasonCodes) {
    if (!REASON_CODE.test(reasonCode)) throw new TypeError("reasonCodes must contain canonical reason codes only");
  }
  assertMetric(value.durationMs, "durationMs");
  assertMetric(value.perTurnLatencyMs, "perTurnLatencyMs");
  assertMetric(value.retryCount, "retryCount");
  if (Object.keys(value.sizes).length > MAX_ITEMS || Object.keys(value.digests).length > MAX_ITEMS || Object.keys(value.policyVersions).length > MAX_ITEMS) throw new TypeError("diagnostic maps are bounded");
  for (const [key, size] of Object.entries(value.sizes)) {
    assertIdentifier(key, "size identifier");
    assertMetric(size, "size");
  }
  for (const [key, digests] of Object.entries(value.digests)) {
    assertIdentifier(key, "digest identifier");
    if (digests.length > MAX_ITEMS || !digests.every((digest) => DIGEST.test(digest))) throw new TypeError("digests must contain bounded canonical SHA-256 values only");
  }
  for (const [key, version] of Object.entries(value.policyVersions)) {
    assertIdentifier(key, "policy identifier");
    assertIdentifier(version, "policy version");
  }
  for (const outcome of Object.values(value.outcomes ?? {})) {
    if (!OUTCOMES.has(outcome)) throw new TypeError("outcomes must contain canonical payload-neutral states only");
  }
  if (!RESULTS.has(value.result)) throw new TypeError("result must be a canonical diagnostic result");
}

export function serializeDiagnosticEvent(value: PayloadNeutralDiagnosticEvent): string {
  assertPayloadNeutralDiagnosticEvent(value);
  return JSON.stringify({
    eventId: value.eventId,
    operationId: value.operationId,
    ...(value.operationInstanceId === undefined ? {} : { operationInstanceId: value.operationInstanceId }),
    ...(value.occurredAt === undefined ? {} : { occurredAt: value.occurredAt }),
    turnIds: [...value.turnIds],
    savePointIds: [...value.savePointIds],
    reasonCodes: [...value.reasonCodes],
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    ...(value.perTurnLatencyMs === undefined ? {} : { perTurnLatencyMs: value.perTurnLatencyMs }),
    ...(value.retryCount === undefined ? {} : { retryCount: value.retryCount }),
    sizes: value.sizes,
    digests: value.digests,
    policyVersions: value.policyVersions,
    ...(value.outcomes === undefined ? {} : { outcomes: value.outcomes }),
    result: value.result,
  });
}
