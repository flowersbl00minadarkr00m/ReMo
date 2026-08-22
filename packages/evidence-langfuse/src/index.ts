const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/u;
const OBSERVATION_ID = /^(?!0{16}$)[0-9a-f]{16}$/u;

export interface TraceLookupRequest {
  readonly traceId: string;
  readonly observationId?: string;
  readonly expectedTurnId: string;
  readonly credential?: string;
}

export type TraceLookupResult =
  | { readonly status: "matching"; readonly metadataTurnId: string; readonly validatedAt?: string }
  | { readonly status: "missing"; readonly validatedAt?: string }
  | { readonly status: "unreachable"; readonly reasonCode: string; readonly validatedAt?: string }
  | { readonly status: "conflicting"; readonly metadataTurnId: string; readonly validatedAt?: string };

export interface LangfuseLookup {
  lookup(request: TraceLookupRequest): Promise<TraceLookupResult>;
}

export function validateTraceId(value: string): string {
  if (!TRACE_ID.test(value)) throw new TypeError("W3C trace ID must be 32 lowercase hexadecimal characters and not all zero.");
  return value;
}

export function validateObservationId(value: string): string {
  if (!OBSERVATION_ID.test(value)) throw new TypeError("W3C observation ID must be 16 lowercase hexadecimal characters and not all zero.");
  return value;
}

interface LinkOptions {
  readonly baseUrl: string;
  readonly approvedHosts: readonly string[];
  readonly projectId: string;
  readonly traceId: string;
  readonly observationId?: string;
}

function approvedBase(baseUrl: string, approvedHosts: readonly string[]): URL {
  const base = new URL(baseUrl);
  if (base.username !== "" || base.password !== "") throw new TypeError("Langfuse base URL must not contain credentials.");
  if (base.protocol !== "https:") throw new TypeError("Langfuse external links require HTTPS.");
  if (!approvedHosts.some((host) => host.toLocaleLowerCase("en-US") === base.hostname.toLocaleLowerCase("en-US"))) {
    throw new TypeError("Langfuse host is not an approved host.");
  }
  if (base.search !== "" || base.hash !== "") throw new TypeError("Langfuse base URL must not contain a query or fragment.");
  return base;
}

export function buildApprovedLangfuseLink(options: LinkOptions): string {
  const base = approvedBase(options.baseUrl, options.approvedHosts);
  const traceId = validateTraceId(options.traceId);
  const observationId = options.observationId === undefined ? undefined : validateObservationId(options.observationId);
  const link = new URL(`/project/${encodeURIComponent(options.projectId)}/traces/${traceId}`, base.origin);
  if (observationId !== undefined) link.searchParams.set("observation", observationId);
  return link.href;
}

async function readBoundedJson(response: Response, maxResponseBytes: number): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reasonCode: "trace.authority-response-too-large" | "trace.authority-response-invalid" }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxResponseBytes) {
      await response.body?.cancel();
      return { ok: false, reasonCode: "trace.authority-response-too-large" };
    }
  }
  if (response.body === null) return { ok: false, reasonCode: "trace.authority-response-invalid" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel("bounded-response-limit");
        return { ok: false, reasonCode: "trace.authority-response-too-large" };
      }
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reasonCode: "trace.authority-response-invalid" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, reasonCode: "trace.authority-response-invalid" };
  }
}

type FakeScenario = TraceLookupResult & { readonly ignoredFullTracePayload?: unknown };

export function createContractLangfuseFake(scenarios: Readonly<Record<string, FakeScenario>>): LangfuseLookup & {
  requests(): readonly Omit<TraceLookupRequest, "credential">[];
} {
  const history: Omit<TraceLookupRequest, "credential">[] = [];
  return {
    lookup(request) {
      validateTraceId(request.traceId);
      if (request.observationId !== undefined) validateObservationId(request.observationId);
      const safeRequest = {
        traceId: request.traceId,
        ...(request.observationId === undefined ? {} : { observationId: request.observationId }),
        expectedTurnId: request.expectedTurnId,
      };
      history.push(safeRequest);
      const scenario = scenarios[request.traceId];
      if (scenario === undefined) return Promise.resolve({ status: "missing" });
      const validatedAt = scenario.validatedAt;
      switch (scenario.status) {
        case "matching":
          return Promise.resolve({ status: "matching", metadataTurnId: scenario.metadataTurnId, ...(validatedAt === undefined ? {} : { validatedAt }) });
        case "conflicting":
          return Promise.resolve({ status: "conflicting", metadataTurnId: scenario.metadataTurnId, ...(validatedAt === undefined ? {} : { validatedAt }) });
        case "unreachable":
          return Promise.resolve({ status: "unreachable", reasonCode: scenario.reasonCode, ...(validatedAt === undefined ? {} : { validatedAt }) });
        case "missing":
          return Promise.resolve({ status: "missing", ...(validatedAt === undefined ? {} : { validatedAt }) });
      }
    },
    requests() {
      return structuredClone(history);
    },
  };
}

interface LiveOptions {
  readonly baseUrl: string;
  readonly approvedHosts: readonly string[];
  readonly projectId: string;
  readonly maxResponseBytes: number;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}

function correlationMetadata(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const turnId = (metadata as { remo_turn_id?: unknown }).remo_turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

export function createLiveLangfuseLookup(options: LiveOptions): LangfuseLookup {
  const base = approvedBase(options.baseUrl, options.approvedHosts);
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1 || options.maxResponseBytes > 1_048_576) {
    throw new TypeError("Langfuse response bound must be between 1 byte and 1 MiB.");
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());
  return {
    async lookup(request) {
      const traceId = validateTraceId(request.traceId);
      if (request.observationId !== undefined) validateObservationId(request.observationId);
      const endpoint = new URL(`/api/public/traces/${traceId}`, base.origin);
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: "GET",
          headers: request.credential === undefined ? { accept: "application/json" } : { accept: "application/json", authorization: request.credential },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        return { status: "unreachable", reasonCode: "trace.authority-unreachable", validatedAt: now().toISOString() };
      }
      if (response.status === 404) return { status: "missing", validatedAt: now().toISOString() };
      if (!response.ok) return { status: "unreachable", reasonCode: "trace.authority-response-rejected", validatedAt: now().toISOString() };
      const payload = await readBoundedJson(response, options.maxResponseBytes);
      if (!payload.ok) return { status: "unreachable", reasonCode: payload.reasonCode, validatedAt: now().toISOString() };
      const metadataTurnId = correlationMetadata(payload.value);
      if (metadataTurnId === undefined) return { status: "missing", validatedAt: now().toISOString() };
      return metadataTurnId === request.expectedTurnId
        ? { status: "matching", metadataTurnId, validatedAt: now().toISOString() }
        : { status: "conflicting", metadataTurnId, validatedAt: now().toISOString() };
    },
  };
}
