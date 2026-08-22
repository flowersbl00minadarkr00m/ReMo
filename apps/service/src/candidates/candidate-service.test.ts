import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ComponentType, CorrelationTuple, EvidenceDescriptor } from "@remo/domain";
import { confirmCandidateIntent, createCandidateReview, discardCandidateReview } from "./candidate-service.js";

const PRIVACY_POLICY_REVISION = "remo.privacy.v1";
const turnId = "01J000000000000000000000T4";
const correlation: CorrelationTuple = { projectId: "remo", turnId, captureWindowId: "window-t4", boundaryRevision: "boundary-v1" };
const types: readonly ComponentType[] = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"];
const descriptors: EvidenceDescriptor[] = types.map((componentType) => ({
  componentId: `${turnId}:${componentType}`,
  componentType,
  authority: componentType === "source" ? "git" : componentType === "rrweb" ? "rrweb" : componentType === "trace" ? "langfuse" : "remo",
  correlation,
  capturedAt: "2026-08-16T07:30:00.000Z",
  digest: `sha256:${componentType}`,
  ...(componentType === "trace" ? { externalId: "0123456789abcdef0123456789abcdef" } : {}),
  availability: "available",
  provenance: componentType === "decision" ? "user-supplied" : "observed",
  policyRevision: PRIVACY_POLICY_REVISION,
  claims: { sourceState: "tree-t4", fixtureId: "vs001-fixture" },
}));
// This is the exact successful output shape returned by the existing T3 nomination seam.
const nomination = {
  status: "candidate",
  categories: ["structure", "accessibility"],
  boundaries: [{ kind: "verification", boundaryId: "fixture-check", occurredAt: "2026-08-16T07:30:00.000Z" }],
  reasonCodes: ["nomination.meaningful-change-with-boundary"],
} as const;

function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function passingCapture() {
  const rrwebBytes = Buffer.from("masked rrweb");
  const screenshotBytes = Buffer.from("masked screenshot");
  return {
    status: "passed",
    evidence: {
      rrwebBytes,
      screenshotBytes,
      receipt: {
        status: "passed",
        policyRevision: PRIVACY_POLICY_REVISION,
        rrwebDigest: digest(rrwebBytes),
        rrwebSize: rrwebBytes.byteLength,
        screenshotDigest: digest(screenshotBytes),
        screenshotSize: screenshotBytes.byteLength,
        checkedAt: "2026-08-16T07:30:00.000Z",
      },
    },
  } as const;
}

function finalization(evidence: readonly EvidenceDescriptor[] = descriptors) {
  return { schemaVersion: "remo.bundle.v1", identityVersion: "ulid-v1", policyRevision: PRIVACY_POLICY_REVISION, savePointId: "01J000000000000000000000S4", correlation, evidence } as const;
}

describe("candidate service", () => {
  it("joins the existing T3 nomination result to privacy-cleared bytes and expresses readiness intent only", () => {
    const record = createCandidateReview({ finalization: finalization(), nomination, privacyCapture: passingCapture(), createdAt: "2026-08-16T07:30:00.000Z" });
    expect(record.status).toBe("reviewable");
    expect(record.projection).toMatchObject({ state: "candidate", canConfirm: true, reproducible: true });
    expect(confirmCandidateIntent(record)).toEqual({ status: "ready-for-durable-promotion", turnId, savePointId: "01J000000000000000000000S4", candidateRevision: 1, candidateManifestDigest: record.status === "reviewable" ? record.manifestDigest : "" });
    expect(JSON.stringify(record)).not.toContain("durableManifestDigest");
  });

  it("returns only an approved metadata receipt when the canary gate fails", () => {
    const privacyCapture = {
      status: "quarantined",
      receipt: { status: "quarantined", policyRevision: PRIVACY_POLICY_REVISION, reasonCodes: ["privacy.canary-detected"], failedComponents: ["rrweb", "screenshot"], checkedAt: "2026-08-16T07:31:00.000Z" },
    } as const;
    const record = createCandidateReview({ finalization: finalization(), nomination, privacyCapture, createdAt: "2026-08-16T07:31:00.000Z" });
    expect(record.status).toBe("quarantined");
    expect(record.projection).toMatchObject({ state: "quarantined", canConfirm: false, screenshotPreviewAvailable: false, replayPreviewAvailable: false });
    expect(Object.keys(record)).toEqual(["status", "receipt", "projection"]);
    expect(confirmCandidateIntent(record).status).toBe("blocked");
  });

  it("inherits canonical source/render mismatch reproducibility and incomplete-state semantics", () => {
    const inconsistentEvidence = descriptors.map((descriptor) => descriptor.componentType === "screenshot" ? { ...descriptor, claims: { ...descriptor.claims, sourceState: "tree-other" } } : descriptor);
    const inconsistent = createCandidateReview({ finalization: finalization(inconsistentEvidence), nomination, privacyCapture: passingCapture(), createdAt: "2026-08-16T07:30:00.000Z" });
    const incomplete = createCandidateReview({ finalization: finalization(descriptors.filter(({ componentType }) => componentType !== "trace")), nomination, privacyCapture: passingCapture(), createdAt: "2026-08-16T07:30:00.000Z" });
    expect(inconsistent.projection).toMatchObject({ state: "inconsistent", canConfirm: false, reproducible: false });
    expect(inconsistent.projection.blockingReasons).toContain("source.state-mismatch");
    expect(incomplete.projection).toMatchObject({ state: "incomplete", canConfirm: false });
  });

  it("zeros in-memory candidate buffers and returns a payload-free discarded projection", () => {
    const record = createCandidateReview({ finalization: finalization(), nomination, privacyCapture: passingCapture(), createdAt: "2026-08-16T07:30:00.000Z" });
    if (record.status !== "reviewable") throw new Error("expected reviewable fixture");
    const discarded = discardCandidateReview(record);
    expect(record.safeEvidence.rrwebBytes.every((byte) => byte === 0)).toBe(true);
    expect(record.safeEvidence.screenshotBytes.every((byte) => byte === 0)).toBe(true);
    expect(discarded).toMatchObject({ state: "discarded", canConfirm: false, screenshotPreviewAvailable: false, replayPreviewAvailable: false });
  });
});
