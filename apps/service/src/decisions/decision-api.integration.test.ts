import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSavePointRepository } from "@remo/storage-local";
import { createDecisionApi } from "./decision-api.js";
import { createDecisionService, type DecisionIdentity, type DecisionProjection } from "./decision-service.js";
import type { DecisionRecord } from "@remo/domain";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const turnId = "01J00000000000000000000T04";
const savePointId = "01J00000000000000000000S04";
const candidateDigest = `sha256:${"a".repeat(64)}`;
const sessionToken = "t".repeat(43);

function content(question = "Should navigation remain discoverable?") {
  return {
    question: { value: question, provenance: "user-supplied", sourceComponentIds: [] },
    options: { value: [{ id: "a", label: "Use disclosure" }, { id: "b", label: "Hide destinations" }], provenance: "user-supplied", sourceComponentIds: [] },
    selectedOptionId: { value: "a", provenance: "user-supplied", sourceComponentIds: [] },
    owner: { value: "Product owner", provenance: "user-supplied", sourceComponentIds: [] },
    uncertainty: { value: { level: "low", source: "human" }, provenance: "user-supplied", sourceComponentIds: [] },
    evidenceComponentIds: [`${turnId}:screenshot`, `${turnId}:verification`],
    expectedEffect: { value: "Destinations remain reachable.", provenance: "inferred", sourceComponentIds: [`${turnId}:screenshot`] },
    verification: { value: "Check five widths.", provenance: "user-supplied", sourceComponentIds: [`${turnId}:verification`] },
    outcome: { provenance: "unknown", sourceComponentIds: [] },
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as unknown as T;
}

describe("decision API", () => {
  it("enforces bounded candidate capture and append-only durable mutations over the real SQLite seam", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "remo-decision-api-")); roots.push(projectRoot); mkdirSync(join(projectRoot, ".git"));
    let repository = new LocalSavePointRepository({ projectRoot, now: () => new Date("2026-08-18T10:04:00.000Z") });
    repository.registerCandidate({ operationId: "candidate-turn-04", turnId, savePointId, revision: 1, manifestDigest: candidateDigest, createdAt: "2026-08-18T10:00:00.000Z", policyRevision: "policy-v1", manifest: { turnId }, blobs: [] });
    const identity: DecisionIdentity = { savePointId, turnId, evidenceComponentIds: [`${turnId}:screenshot`, `${turnId}:verification`], candidateRevision: 1, candidateManifestDigest: candidateDigest };
    let durable = false; let clock = 4;
    const makeService = () => createDecisionService({ repository, findCandidate: () => durable ? undefined : identity, findDurable: () => durable ? { savePointId, turnId, evidenceComponentIds: identity.evidenceComponentIds } : undefined, now: () => new Date(`2026-08-18T10:${String(clock++).padStart(2, "0")}:00.000Z`) });
    let api: ReturnType<typeof createDecisionApi>;
    const server = createServer((request, response) => { void api.handle(request, response).then((handled) => { if (!handled) response.writeHead(404).end(); }); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Decision API test listener is unavailable.");
    const origin = `http://127.0.0.1:${address.port}`;
    api = createDecisionApi({ allowedOrigin: origin, sessionToken, service: makeService() });
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-remo-session-token": sessionToken, "idempotency-key": `test-${Math.random()}`, ...headers }, body: JSON.stringify(body) });
    const create = (bodyContent: unknown, expectedCandidateRevision = 1) => post(`/api/candidates/${turnId}/decision`, { expectedCandidateRevision, expectedCandidateManifestDigest: candidateDigest, decisionId: "decision-turn-04", content: bodyContent });
    try {
      const absent = await fetch(`${origin}/api/save-points/${savePointId}/decision`); expect(absent.status).toBe(200); expect(await responseJson(absent)).toEqual({ schemaVersion: "remo.decision.absent.v1", state: "unknown" });
      const absentCandidate = await fetch(`${origin}/api/candidates/${turnId}/decision`); expect(absentCandidate.status).toBe(200); expect(await responseJson(absentCandidate)).toEqual({ schemaVersion: "remo.decision.absent.v1", state: "unknown" });
      expect((await create(content(), 2)).status).toBe(409);
      expect((await create(content("<strong>Invented rationale</strong>"))).status).toBe(400);
      expect((await create({ ...content(), evidenceComponentIds: ["01J00000000000000000000T08:verification"] })).status).toBe(400);
      expect((await create({ ...content(), unsupported: true })).status).toBe(400);
      expect((await create(content("x".repeat(17_000)))).status).toBe(413);
      const created = await create(content()); expect(created.status).toBe(201);
      const first = await responseJson<DecisionRecord>(created); expect(first).toMatchObject({ revision: 1, outcome: { provenance: "unknown" }, uncertainty: { value: { level: "low", source: "human" } } });
      const repeated = await create(content()); expect(repeated.status).toBe(201); expect(await responseJson<DecisionRecord>(repeated)).toEqual(first);
      const candidateRead = await fetch(`${origin}/api/candidates/${turnId}/decision`); expect(candidateRead.status).toBe(200);
      const candidateProjection = await responseJson<DecisionProjection>(candidateRead); expect(candidateProjection).toEqual({ current: first, revisions: [first] });
      durable = true; api = createDecisionApi({ allowedOrigin: origin, sessionToken, service: makeService() });
      expect((await post(`/api/save-points/${savePointId}/decision-revisions`, { expectedRevision: 9, mutation: "confirm-inferred", fields: ["expectedEffect"] })).status).toBe(409);
      expect((await post(`/api/save-points/${savePointId}/decision-revisions`, { expectedRevision: 1, mutation: "rewrite-history", changes: {} })).status).toBe(400);
      expect((await post(`/api/save-points/${savePointId}/decision-revisions`, { expectedRevision: 1, mutation: "confirm-inferred", fields: ["expectedEffect"] })).status).toBe(201);
      expect((await post(`/api/save-points/${savePointId}/decision-revisions`, { expectedRevision: 2, mutation: "reconstructed-supplement", changes: { outcome: { value: "Five widths passed.", provenance: "reconstructed", sourceComponentIds: [`${turnId}:verification`] } } })).status).toBe(201);
      expect((await post(`/api/save-points/${savePointId}/decision-revisions`, { expectedRevision: 3, mutation: "correction", changes: { outcome: { value: "Four widths passed; one remained unknown.", provenance: "reconstructed", sourceComponentIds: [`${turnId}:verification`] } } })).status).toBe(201);
      const read = await fetch(`${origin}/api/save-points/${savePointId}/decision`); expect(read.status).toBe(200);
      const projection = await responseJson<DecisionProjection>(read); expect(projection.revisions).toHaveLength(4); expect(projection.revisions[0]!.outcome.provenance).toBe("unknown");
      repository.close(); repository = new LocalSavePointRepository({ projectRoot, now: () => new Date("2026-08-18T10:12:00.000Z") }); api = createDecisionApi({ allowedOrigin: origin, sessionToken, service: makeService() });
      const restarted = await fetch(`${origin}/api/save-points/${savePointId}/decision`); expect(restarted.status).toBe(200); expect((await responseJson<DecisionProjection>(restarted)).current.revision).toBe(4);
    } finally { server.close(); await once(server, "close"); repository.close(); }
  }, 20_000);
});
