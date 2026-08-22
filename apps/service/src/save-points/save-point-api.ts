import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { projectPolicyCategory, projectPolicyRevision, type PolicyCategoryProjection, type PolicyRevisionProjection } from "@remo/domain";
import { buildApprovedLangfuseLink } from "@remo/evidence-langfuse";
import type { SavePointStore, StoredSavePoint } from "./save-point-service.js";
import { BoundedJsonError, readBoundedJson, requireExactEmptyObject } from "./bounded-json-reader.js";

const MAX_RECONCILE_BODY_BYTES = 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

export interface ExternalAuthorityRoots {
  readonly source: { readonly baseUrl: string; readonly approvedHosts: readonly string[] };
  readonly trace: { readonly baseUrl: string; readonly approvedHosts: readonly string[]; readonly projectId: string };
}

export interface SafeSavePointProjection {
  readonly savePointId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly stablePath: string;
  readonly nominationReason: string;
  readonly manifestDigest: string;
  readonly integrity: { readonly state: "Complete" | "Incomplete" | "Inconsistent"; readonly explanation: string; readonly reasonCodes: readonly string[] };
  readonly fidelity: { readonly state: "Editable eligible" | "Degraded" | "Historical only"; readonly explanation: string };
  readonly privacy: { readonly state: "Pass"; readonly explanation: string };
  readonly retention: StoredSavePoint["retention"];
  readonly policyRevisions: Readonly<Record<"Capture" | "Privacy" | "Integrity" | "Fidelity" | "Retention", PolicyRevisionProjection>>;
  readonly displayId: string;
  readonly boundaryRevision: string;
  readonly components: readonly {
    readonly type: StoredSavePoint["finalization"]["evidence"][number]["componentType"];
    readonly label: string;
    readonly authority: string;
    readonly availability: "Available" | "Missing" | "Unreachable" | "Conflicting";
    readonly provenance: "Observed" | "User-supplied" | "Unknown";
    readonly authorityMode: "fixture" | "live";
    readonly policyRevision: string;
    readonly policyCategory: PolicyCategoryProjection;
    readonly description: string;
    readonly externalUrl?: string;
    readonly externalLabel?: string;
    readonly local: boolean;
  }[];
  readonly promotionAllowed: boolean;
  readonly traceValidatedAt?: string;
}

function exactLoopbackOrigin(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) throw new Error("Save-point API requires one exact IPv4 loopback Origin.");
  return origin.origin;
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function drainRejectedRequest(request: IncomingMessage): void {
  if (!request.complete && !request.destroyed) request.resume();
}

function approvedSourceLink(root: ExternalAuthorityRoots["source"], commit: string): string {
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new TypeError("Source authority requires an exact lowercase Git commit identifier.");
  const base = new URL(root.baseUrl);
  if (base.username !== "" || base.password !== "") throw new TypeError("Source authority root must not contain credentials.");
  if (base.protocol !== "https:") throw new TypeError("Source authority links require HTTPS.");
  if (!root.approvedHosts.some((host) => host.toLocaleLowerCase("en-US") === base.hostname.toLocaleLowerCase("en-US"))) throw new TypeError("Source authority host is not approved.");
  if (base.search !== "" || base.hash !== "") throw new TypeError("Source authority root must not contain a query or fragment.");
  const rootPath = base.pathname.replace(/\/+$/u, "");
  return new URL(`${rootPath}/commit/${commit}`, base.origin).href;
}

const LABELS = { source: "Source change", rrweb: "Rendered session", screenshot: "Masked screenshot", trace: "Langfuse trace", decision: "Decision context", verification: "Verification", dependencies: "Dependencies", lineage: "Lineage" } as const;

export function safeProjection(record: StoredSavePoint, roots: ExternalAuthorityRoots): SafeSavePointProjection {
  const components = record.finalization.evidence.map((descriptor) => {
    const conflicting = descriptor.correlation.turnId !== undefined && descriptor.correlation.turnId !== record.turnId;
    const availability: "Available" | "Missing" | "Unreachable" | "Conflicting" = conflicting ? "Conflicting" : descriptor.availability === "available" ? "Available" : descriptor.availability === "missing" ? "Missing" : descriptor.availability === "unreachable" ? "Unreachable" : "Conflicting";
    const provenance: "Observed" | "User-supplied" | "Unknown" = descriptor.provenance === "observed" ? "Observed" : descriptor.provenance === "user-supplied" ? "User-supplied" : "Unknown";
    const authorityMode: "fixture" | "live" = descriptor.claims?.fixtureId === undefined ? "live" : "fixture";
    let external: { readonly externalUrl: string; readonly externalLabel: string } | undefined;
    if (descriptor.componentType === "source" && descriptor.claims?.sourceState !== undefined) {
      external = { externalUrl: approvedSourceLink(roots.source, descriptor.claims.sourceState), externalLabel: "Open exact source change" };
    } else if (descriptor.componentType === "trace" && descriptor.externalId !== undefined && descriptor.availability !== "missing" && descriptor.availability !== "unreachable") {
      external = { externalUrl: buildApprovedLangfuseLink({ ...roots.trace, traceId: descriptor.externalId }), externalLabel: "Open authoritative trace" };
    }
    return {
      type: descriptor.componentType,
      label: LABELS[descriptor.componentType],
      authority: descriptor.authority === "git" ? "Git" : descriptor.authority === "langfuse" ? "Langfuse" : descriptor.authority === "rrweb" ? "rrweb" : descriptor.authority === "fixture" ? "Fixture" : "ReMo",
      availability,
      provenance,
      authorityMode,
      policyRevision: descriptor.policyRevision,
      policyCategory: projectPolicyCategory(descriptor.policyRevision),
      description: descriptor.componentType === "trace"
        ? availability === "Available" ? "Supplied W3C trace metadata matches this turn." : availability === "Conflicting" ? "The authority reports a different remo_turn_id. Trust and editable eligibility are blocked." : "The authority cannot currently validate the supplied trace. Local evidence remains available."
        : descriptor.componentType === "source" ? `Exact allowed-path change at commit ${descriptor.claims?.sourceState ?? "unknown"}.`
        : descriptor.componentType === "decision" ? "User-supplied acceptance context; no private reasoning is claimed."
        : "Privacy-cleared evidence for this bounded turn.",
      ...(external ?? {}),
      local: !["git", "langfuse"].includes(descriptor.authority),
    };
  });
  return {
    savePointId: record.savePointId,
    turnId: record.turnId,
    revision: record.revision,
    stablePath: record.stablePath,
    displayId: `SP-${record.savePointId.slice(-6)}`,
    boundaryRevision: record.finalization.correlation.boundaryRevision,
    nominationReason: record.nominationReason,
    manifestDigest: record.manifestDigest,
    integrity: { state: record.integrity.state === "complete" ? "Complete" : record.integrity.state === "inconsistent" ? "Inconsistent" : "Incomplete", explanation: record.integrity.state === "complete" ? "All required evidence is available and agrees on this turn." : record.integrity.state === "inconsistent" ? "Evidence authority identities conflict; trust is blocked." : "Some evidence is missing or unavailable; safe local evidence remains inspectable.", reasonCodes: record.integrity.reasonCodes },
    fidelity: { state: record.fidelity.state === "editable-eligible" ? "Editable eligible" : record.fidelity.state === "historical-only" ? "Historical only" : "Degraded", explanation: record.fidelity.state === "editable-eligible" ? "Required source, rendered, dependency, and verification evidence is complete." : "Historical local evidence is safe to inspect, but reproducibility is not claimed." },
    privacy: { state: "Pass", explanation: "Rendered evidence passed privacy policy before local persistence." },
    retention: record.retention,
    policyRevisions: {
      Capture: projectPolicyRevision("Capture", record.policyRevisions.capture),
      Privacy: projectPolicyRevision("Privacy", record.policyRevisions.privacy),
      Integrity: projectPolicyRevision("Integrity", record.policyRevisions.integrity),
      Fidelity: projectPolicyRevision("Fidelity", record.policyRevisions.fidelity),
      Retention: projectPolicyRevision("Retention", record.policyRevisions.retention),
    },
    components,
    promotionAllowed: record.promotionAllowed,
    ...(record.traceValidatedAt === undefined ? {} : { traceValidatedAt: record.traceValidatedAt }),
  };
}

export function createSavePointApi(options: {
  readonly allowedOrigin: string;
  readonly store: SavePointStore;
  readonly reconcile: (savePointId: string, idempotencyKey: string) => Promise<StoredSavePoint>;
  readonly authorityRoots: ExternalAuthorityRoots;
  readonly sessionToken?: string;
}): {
  readonly sessionToken: string;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
} {
  const origin = exactLoopbackOrigin(options.allowedOrigin);
  const sessionToken = options.sessionToken ?? randomBytes(32).toString("base64url");
  if (sessionToken.length < 32) throw new TypeError("Save-point session token must contain at least 32 characters.");
  return {
    sessionToken,
    async handle(request, response) {
      if (request.socket.remoteAddress !== "127.0.0.1") { writeJson(response, 403, { error: "save-point.loopback-required" }); return; }
      const match = /^\/api\/save-points\/([A-Za-z0-9_-]{1,128})(\/reconcile)?$/u.exec(request.url ?? "");
      if (match === null) { drainRejectedRequest(request); writeJson(response, 404, { error: "save-point.unknown-route" }); return; }
      const savePointId = match[1]!;
      if (request.method === "GET" && match[2] === undefined) {
        const record = options.store.get(savePointId);
        if (record === undefined) { writeJson(response, 404, { error: "save-point.not-found" }); return; }
        writeJson(response, 200, safeProjection(record, options.authorityRoots));
        return;
      }
      if (request.headers.origin !== origin) { drainRejectedRequest(request); writeJson(response, 403, { error: "save-point.origin-rejected" }); return; }
      if (!sameToken(request.headers["x-remo-session-token"] as string | undefined, sessionToken)) { drainRejectedRequest(request); writeJson(response, 401, { error: "save-point.session-token-required" }); return; }
      if (request.method === "POST" && match[2] === "/reconcile" && typeof request.headers["content-type"] === "string" && JSON_CONTENT_TYPE.test(request.headers["content-type"])) {
        const idempotencyKey = request.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(idempotencyKey)) {
          drainRejectedRequest(request);
          writeJson(response, 400, { error: "save-point.idempotency-key-required" });
          return;
        }
        if (request.headers["transfer-encoding"] !== undefined) {
          drainRejectedRequest(request);
          writeJson(response, 400, { error: "save-point.transfer-encoding-rejected" });
          return;
        }
        try {
          requireExactEmptyObject(await readBoundedJson(request, MAX_RECONCILE_BODY_BYTES));
          writeJson(response, 200, safeProjection(await options.reconcile(savePointId, idempotencyKey), options.authorityRoots));
        } catch (error) {
          if (error instanceof BoundedJsonError) {
            if (!response.destroyed) writeJson(response, error.code === "request-too-large" ? 413 : 400, { error: `save-point.${error.code}` });
            return;
          }
          writeJson(response, 409, { error: "save-point.reconcile-failed" });
        }
        return;
      }
      drainRejectedRequest(request);
      writeJson(response, 415, { error: "save-point.get-or-json-reconcile-required" });
    },
  };
}
