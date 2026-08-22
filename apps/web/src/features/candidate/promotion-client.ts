import type { ConfirmIntent } from "@remo/domain/browser";

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

export interface PromotionClient {
  promote(intent: Extract<ConfirmIntent, { status: "ready-for-durable-promotion" }>): Promise<DurableSaveProjection>;
}

export class PromotionClientError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "PromotionClientError";
  }
}

function isDurableProjection(value: unknown): value is DurableSaveProjection {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return item.status === "durable"
    && typeof item.turnId === "string"
    && typeof item.savePointId === "string"
    && Number.isSafeInteger(item.revision)
    && typeof item.manifestDigest === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(item.manifestDigest)
    && typeof item.createdAt === "string"
    && typeof item.promotedAt === "string"
    && typeof item.expiresAt === "string"
    && item.pinned === false
    && item.health === "complete"
    && item.fidelity === "editable-eligible";
}

export function createLoopbackPromotionClient(options: {
  readonly origin: string;
  readonly sessionToken: string;
  readonly fetcher?: typeof fetch;
}): PromotionClient {
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username !== "" || origin.password !== "") throw new TypeError("Promotion origin must be IPv4 loopback HTTP");
  if (options.sessionToken.length < 1) throw new TypeError("Promotion session token is required");
  const fetcher = options.fetcher ?? fetch;
  return {
    async promote(intent) {
      const response = await fetcher(new URL(`/api/candidates/${encodeURIComponent(intent.turnId)}/promote`, origin).toString(), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-remo-session-token": options.sessionToken },
        body: JSON.stringify({ confirm: true, savePointId: intent.savePointId, candidateRevision: intent.candidateRevision, candidateManifestDigest: intent.candidateManifestDigest }),
      });
      const body = await response.json() as unknown;
      if (!response.ok) {
        const failure = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
        throw new PromotionClientError(
          typeof failure.code === "string" ? failure.code : "promotion.invalid-error-response",
          typeof failure.message === "string" ? failure.message : "The local promotion service returned an invalid failure response.",
          failure.retryable === true,
        );
      }
      if (!isDurableProjection(body) || body.turnId !== intent.turnId) throw new PromotionClientError("promotion.invalid-success-response", "The local promotion service returned an invalid durable result.", true);
      return body;
    },
  };
}
