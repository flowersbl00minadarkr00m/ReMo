import type { IncomingMessage } from "node:http";

export type BoundedJsonErrorCode = "request-aborted" | "request-invalid-json" | "request-too-large";

export class BoundedJsonError extends Error {
  constructor(readonly code: BoundedJsonErrorCode) {
    super(code);
    this.name = "BoundedJsonError";
  }
}

export async function readBoundedJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  const declaredTooLarge = typeof declaredLength === "string" && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBodyBytes;
  let size = 0;
  let tooLarge = declaredTooLarge;
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of request) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > maxBodyBytes) tooLarge = true;
      if (!tooLarge) chunks.push(bytes);
    }
  } catch {
    throw new BoundedJsonError("request-aborted");
  }
  if (request.aborted || !request.complete) throw new BoundedJsonError("request-aborted");
  if (tooLarge) throw new BoundedJsonError("request-too-large");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BoundedJsonError("request-invalid-json");
  }
}

export function requireExactEmptyObject(value: unknown): void {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== 0) throw new BoundedJsonError("request-invalid-json");
}
