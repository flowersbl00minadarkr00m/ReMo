import { assertDecisionRecord, type DecisionFieldName, type DecisionRecord } from "@remo/domain/browser";

export interface DecisionProjection {
  readonly current: DecisionRecord;
  readonly revisions: readonly DecisionRecord[];
}

export interface CandidateDecisionInput {
  readonly expectedCandidateRevision: number;
  readonly expectedCandidateManifestDigest: string;
  readonly decisionId: string;
  readonly content: unknown;
}

export type DecisionRevisionInput =
  | { readonly expectedRevision: number; readonly mutation: "confirm-inferred"; readonly fields: readonly DecisionFieldName[] }
  | { readonly expectedRevision: number; readonly mutation: "reconstructed-supplement" | "correction"; readonly changes: Readonly<Record<string, unknown>>; readonly evidenceComponentIds?: readonly string[] };

export interface DecisionClient {
  createCandidate(turnId: string, input: CandidateDecisionInput): Promise<DecisionRecord>;
  readCandidate?(turnId: string, signal?: AbortSignal): Promise<DecisionProjection | undefined>;
  read(savePointId: string, signal?: AbortSignal): Promise<DecisionProjection | undefined>;
  revise(savePointId: string, input: DecisionRevisionInput): Promise<DecisionRecord>;
}

function exactLoopback(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new Error("Decision evidence requires the exact IPv4 loopback origin.");
  return origin.origin;
}

async function failure(response: Response): Promise<Error & { readonly retryable?: boolean }> {
  const body = await response.json().catch(() => ({})) as { readonly message?: unknown; readonly error?: unknown; readonly retryable?: unknown };
  return Object.assign(new Error(typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "Decision evidence request failed."), { retryable: body.retryable === true });
}

export function createLoopbackDecisionClient(options: { readonly origin: string; readonly sessionToken?: string; readonly fetcher?: typeof fetch }): DecisionClient {
  const origin = exactLoopback(options.origin);
  const fetcher = options.fetcher ?? fetch;
  const mutate = async (path: string, input: unknown): Promise<DecisionRecord> => {
    if (options.sessionToken === undefined) throw Object.assign(new Error("The authenticated decision session is unavailable."), { retryable: false });
    const response = await fetcher(`${origin}${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-remo-session-token": options.sessionToken, "idempotency-key": `decision-${crypto.randomUUID()}` }, body: JSON.stringify(input) });
    if (!response.ok) throw await failure(response);
    return assertDecisionRecord(await response.json() as unknown);
  };
  const read = async (path: string, signal?: AbortSignal): Promise<DecisionProjection | undefined> => {
    const response = await fetcher(`${origin}${path}`, { method: "GET", credentials: "same-origin", ...(signal === undefined ? {} : { signal }) });
    if (!response.ok) throw await failure(response);
    const value = await response.json() as { readonly schemaVersion?: unknown; readonly state?: unknown; readonly current?: unknown; readonly revisions?: unknown };
    if (value.schemaVersion === "remo.decision.absent.v1" && value.state === "unknown" && value.current === undefined && value.revisions === undefined) return undefined;
    if (!Array.isArray(value.revisions)) throw new Error("Decision revision projection is malformed.");
    const revisions = value.revisions.map(assertDecisionRecord);
    const current = assertDecisionRecord(value.current);
    if (revisions.length < 1 || revisions.at(-1)?.digest !== current.digest) throw new Error("Decision revision projection is inconsistent.");
    return { current, revisions };
  };
  return {
    createCandidate: (turnId, input) => mutate(`/api/candidates/${encodeURIComponent(turnId)}/decision`, input),
    readCandidate: (turnId, signal) => read(`/api/candidates/${encodeURIComponent(turnId)}/decision`, signal),
    read: (savePointId, signal) => read(`/api/save-points/${encodeURIComponent(savePointId)}/decision`, signal),
    revise: (savePointId, input) => mutate(`/api/save-points/${encodeURIComponent(savePointId)}/decision-revisions`, input),
  };
}
