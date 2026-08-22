import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "@remo/domain";
import type { DecisionRevisionAppend, DecisionRevisionRead, DecisionRevisionReceipt } from "@remo/storage-local";
import { createDecisionService, DecisionServiceError, type DecisionContentInput, type DecisionIdentity, type DecisionRepository } from "./decision-service.js";

const turnId = "01J00000000000000000000T04";
const savePointId = "01J00000000000000000000S04";
const manifestDigest = `sha256:${"a".repeat(64)}`;
const components = ["source", "screenshot", "verification", "decision"].map((type) => `${turnId}:${type}`);
const identity: DecisionIdentity = { savePointId, turnId, evidenceComponentIds: components, candidateRevision: 1, candidateManifestDigest: manifestDigest };

class MemoryDecisionRepository implements DecisionRepository {
  readonly rows: DecisionRevisionRead[] = [];
  appendDecisionRevision(request: DecisionRevisionAppend): DecisionRevisionReceipt {
    const row = { savePointId: request.savePointId, turnId: request.turnId, revision: request.revision, ...(request.predecessorDigest === undefined ? {} : { predecessorDigest: request.predecessorDigest }), digest: request.expectedDigest, recordedAt: request.recordedAt, canonicalRecord: request.canonicalRecord };
    this.rows.push(row);
    return row;
  }
  readDecisionRevisions(target: string): readonly DecisionRevisionRead[] { return this.rows.filter(({ savePointId: id }) => id === target); }
  readLatestDecisionRevision(target: string): DecisionRevisionRead | undefined { return this.readDecisionRevisions(target).at(-1); }
}

function content(): DecisionContentInput {
  return {
    question: { value: "Should the narrow layout keep every workflow destination discoverable?", provenance: "user-supplied", sourceComponentIds: [] },
    options: { value: [{ id: "disclosure", label: "Use a navigation disclosure" }, { id: "hidden", label: "Hide secondary destinations" }], provenance: "user-supplied", sourceComponentIds: [] },
    selectedOptionId: { value: "disclosure", provenance: "user-supplied", sourceComponentIds: [] },
    owner: { value: "Product owner", provenance: "user-supplied", sourceComponentIds: [] },
    uncertainty: { value: { level: "low", source: "human" }, provenance: "user-supplied", sourceComponentIds: [] },
    evidenceComponentIds: [`${turnId}:screenshot`, `${turnId}:verification`],
    expectedEffect: { value: "Primary workflow destinations remain reachable without overflow.", provenance: "inferred", sourceComponentIds: [`${turnId}:screenshot`] },
    verification: { value: "Check keyboard traversal at all five approved widths.", provenance: "user-supplied", sourceComponentIds: [`${turnId}:verification`] },
    outcome: { provenance: "unknown", sourceComponentIds: [] },
  };
}

function harness() {
  const repository = new MemoryDecisionRepository();
  let candidate: DecisionIdentity | undefined = identity;
  let durable: DecisionIdentity | undefined;
  let index = 0;
  const stamps = ["2026-08-18T10:04:00.000Z", "2026-08-18T10:05:00.000Z", "2026-08-18T10:08:00.000Z", "2026-08-18T10:09:00.000Z"];
  const service = createDecisionService({ repository, findCandidate: () => candidate, findDurable: () => durable, now: () => new Date(stamps[index++]!) });
  return { repository, service, promote() { candidate = undefined; durable = { savePointId, turnId, evidenceComponentIds: components }; } };
}

describe("decision service", () => {
  it("captures before promotion and preserves inferred confirmation, reconstruction, correction, and unknown history", () => {
    const test = harness();
    const first = test.service.createCandidate(turnId, { expectedCandidateRevision: 1, expectedCandidateManifestDigest: manifestDigest, decisionId: "decision-turn-04", content: content() });
    expect(first).toMatchObject({ revision: 1, outcome: { provenance: "unknown" }, uncertainty: { value: { level: "low", source: "human" } }, expectedEffect: { provenance: "inferred" } });
    test.promote();
    const confirmed = test.service.revise(savePointId, { expectedRevision: 1, mutation: "confirm-inferred", fields: ["expectedEffect"] });
    expect(confirmed.expectedEffect).toMatchObject({ provenance: "inferred", confirmedAt: "2026-08-18T10:05:00.000Z" });
    test.service.revise(savePointId, { expectedRevision: 2, mutation: "reconstructed-supplement", changes: { outcome: { value: "The five-width verification passed.", provenance: "reconstructed", sourceComponentIds: [`${turnId}:verification`] } } });
    const corrected = test.service.revise(savePointId, { expectedRevision: 3, mutation: "correction", changes: { outcome: { value: "Four widths passed; the narrowest result remained unknown.", provenance: "reconstructed", sourceComponentIds: [`${turnId}:verification`] } } });
    const projection = test.service.read(savePointId)!;
    expect(projection.revisions.map(({ revision }) => revision)).toEqual([1, 2, 3, 4]);
    expect(projection.revisions[0]!.outcome.provenance).toBe("unknown");
    expect(projection.revisions[2]!.outcome.value).toBe("The five-width verification passed.");
    expect(projection.current).toEqual(corrected);
    expect(projection.revisions.slice(1).map(({ predecessorDigest }) => predecessorDigest)).toEqual(projection.revisions.slice(0, -1).map(({ digest }) => digest));
  });

  it("fails closed on stale candidate/durable revisions and unavailable evidence", () => {
    const test = harness();
    expect(() => test.service.createCandidate(turnId, { expectedCandidateRevision: 2, expectedCandidateManifestDigest: manifestDigest, decisionId: "decision-turn-04", content: content() })).toThrowError(DecisionServiceError);
    const invalid = content();
    expect(() => test.service.createCandidate(turnId, { expectedCandidateRevision: 1, expectedCandidateManifestDigest: manifestDigest, decisionId: "decision-turn-04", content: { ...invalid, evidenceComponentIds: [`${turnId}:not-present`] } })).toThrowError(/available component/u);
    const first = test.service.createCandidate(turnId, { expectedCandidateRevision: 1, expectedCandidateManifestDigest: manifestDigest, decisionId: "decision-turn-04", content: content() });
    expect(first.revision).toBe(1);
    test.promote();
    expect(() => test.service.revise(savePointId, { expectedRevision: 9, mutation: "confirm-inferred", fields: ["expectedEffect"] })).toThrowError(/stale/u);
    expect(test.repository.rows).toHaveLength(1);
  });

  it("recovers an exact committed candidate decision without creating a duplicate", () => {
    const test = harness();
    const request = { expectedCandidateRevision: 1, expectedCandidateManifestDigest: manifestDigest, decisionId: "decision-turn-04", content: content() } as const;
    const committed = test.service.createCandidate(turnId, request);
    expect(test.service.readCandidate(turnId)?.current).toEqual(committed);
    expect(test.service.createCandidate(turnId, request)).toEqual(committed);
    expect(test.repository.rows).toHaveLength(1);
    expect(() => test.service.createCandidate(turnId, { ...request, content: { ...content(), owner: { value: "Different owner", provenance: "user-supplied", sourceComponentIds: [] } } })).toThrow(/different canonical evidence/u);
    expect(test.repository.rows).toHaveLength(1);
  });

  it("does not accept retroactive observed correction or a made-up outcome", () => {
    const test = harness();
    test.service.createCandidate(turnId, { expectedCandidateRevision: 1, expectedCandidateManifestDigest: manifestDigest, decisionId: "decision-turn-04", content: content() });
    test.promote();
    expect(() => test.service.revise(savePointId, { expectedRevision: 1, mutation: "correction", changes: { outcome: { value: "It worked", provenance: "observed", sourceComponentIds: [`${turnId}:verification`] } } })).toThrowError(/retroactive observed/u);
    const stored = test.repository.rows[0]!.canonicalRecord as DecisionRecord;
    expect(stored.outcome).toEqual({ provenance: "unknown", sourceComponentIds: [], recordedAt: "2026-08-18T10:04:00.000Z" });
  });
});
