import { describe, expect, it } from "vitest";
import type { EvidenceDescriptor } from "../contracts.js";
import { createQuarantineReceipt, PRIVACY_POLICY_REVISION } from "../privacy/receipt.js";
import { discardCandidate, projectCandidate, requestConfirmIntent } from "./projection.js";

const nomination = {
  status: "candidate",
  categories: ["responsive"],
  boundaries: [{ kind: "verification", boundaryId: "fixture-check", occurredAt: "2026-08-16T07:00:00.000Z" }],
  reasonCodes: ["nomination.meaningful-change-with-boundary"],
} as const;
const evidence: EvidenceDescriptor[] = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"].map((componentType) => ({
  componentId: `turn:${componentType}`,
  componentType: componentType as EvidenceDescriptor["componentType"],
  authority: componentType === "source" ? "git" : componentType === "trace" ? "langfuse" : componentType === "rrweb" ? "rrweb" : "remo",
  correlation: { turnId: "01J000000000000000000000T4" },
  capturedAt: "2026-08-16T07:00:00.000Z",
  digest: `sha256:${componentType}`,
  availability: "available",
  provenance: componentType === "decision" ? "user-supplied" : "observed",
  policyRevision: PRIVACY_POLICY_REVISION,
}));

const passReceipt = {
  status: "passed",
  policyRevision: PRIVACY_POLICY_REVISION,
  rrwebDigest: "sha256:rrweb",
  rrwebSize: 10,
  screenshotDigest: "sha256:screenshot",
  screenshotSize: 20,
  checkedAt: "2026-08-16T07:00:00.000Z",
} as const;

const confirmationBinding = {
  savePointId: "01J000000000000000000000S4",
  candidateRevision: 1,
  candidateManifestDigest: `sha256:${"a".repeat(64)}`,
} as const;

describe("candidate projection", () => {
  it("exposes nomination, provenance, expiry, and readiness without claiming persistence", () => {
    const projection = projectCandidate({
      turnId: "01J000000000000000000000T4",
      nomination,
      evidence,
      privacy: passReceipt,
      integrity: { state: "complete", reasonCodes: [], componentIds: [] },
      fidelity: { state: "editable-eligible", reasonCodes: [] },
      createdAt: "2026-08-16T07:00:00.000Z",
      confirmationBinding,
    });
    expect(projection).toMatchObject({ state: "candidate", canConfirm: true, reproducible: true });
    expect(projection.nominationCategories).toEqual(["responsive"]);
    expect(projection.components.find(({ componentType }) => componentType === "decision")?.provenance).toBe("user-supplied");
    expect(projection.expiresAt).toBe("2026-08-23T07:00:00.000Z");
    expect(requestConfirmIntent(projection)).toEqual({ status: "ready-for-durable-promotion", turnId: projection.turnId, ...confirmationBinding });
  });

  it("blocks confirmation when a passing browser projection has no server-issued immutable binding", () => {
    const projection = projectCandidate({
      turnId: "01J000000000000000000000T4",
      nomination,
      evidence,
      privacy: passReceipt,
      integrity: { state: "complete", reasonCodes: [], componentIds: [] },
      fidelity: { state: "editable-eligible", reasonCodes: [] },
      createdAt: "2026-08-16T07:00:00.000Z",
    });
    expect(projection.canConfirm).toBe(false);
    expect(projection.blockingReasons).toContain("candidate.confirmation-binding-missing");
    expect(requestConfirmIntent(projection)).toEqual({ status: "blocked", reasonCodes: ["candidate.confirmation-binding-missing"] });
  });

  it("applies quarantine before inconsistency and strips all preview availability", () => {
    const projection = projectCandidate({
      turnId: "01J000000000000000000000T4",
      nomination,
      evidence,
      privacy: createQuarantineReceipt({ reasonCodes: ["privacy.canary-detected"], failedComponents: ["rrweb"], checkedAt: "2026-08-16T07:00:00.000Z" }),
      integrity: { state: "inconsistent", reasonCodes: ["correlation.turn-mismatch"], componentIds: ["turn:trace"] },
      fidelity: { state: "historical-only", reasonCodes: ["correlation.turn-mismatch"] },
      createdAt: "2026-08-16T07:00:00.000Z",
    });
    expect(projection.state).toBe("quarantined");
    expect(projection.canConfirm).toBe(false);
    expect(projection.screenshotPreviewAvailable).toBe(false);
    expect(projection.replayPreviewAvailable).toBe(false);
  });

  it("blocks reproducibility on a source/render mismatch and safely discards", () => {
    const projection = projectCandidate({
      turnId: "01J000000000000000000000T4",
      nomination,
      evidence,
      privacy: passReceipt,
      integrity: { state: "inconsistent", reasonCodes: ["source.state-mismatch"], componentIds: ["turn:source", "turn:screenshot"] },
      fidelity: { state: "historical-only", reasonCodes: ["source.state-mismatch"] },
      createdAt: "2026-08-16T07:00:00.000Z",
    });
    expect(projection.state).toBe("inconsistent");
    expect(projection.reproducible).toBe(false);
    expect(requestConfirmIntent(projection).status).toBe("blocked");
    expect(discardCandidate(projection)).toMatchObject({ state: "discarded", screenshotPreviewAvailable: false, replayPreviewAvailable: false });
  });
});
