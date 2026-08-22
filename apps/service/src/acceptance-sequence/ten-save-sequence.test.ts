import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runTenSaveSequence, traceEvidenceFromAuthority } from "./ten-save-sequence.js";

const componentTypes = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"];

function oldSyntheticDigest(turnId: string, componentType: string, sourceCommit: string): string {
  return `sha256:${createHash("sha256").update(`${turnId}:${componentType}:${sourceCommit}`).digest("hex")}`;
}

describe("sequential ten-save joined outcome", () => {
  it("joins exact scenarios to SQLite/CAS saves and isolates retry, conflict, quarantine, and deletion", async () => {
    const report = await runTenSaveSequence();
    try {
      expect(report).toMatchObject({ smokeTurns: 3, durableCount: 10, distinctSavePointIds: 10, distinctTurnIds: 10, retryCountAfter: 10, retryIdentityStable: true, missingConfirmationRejected: true, falseConfirmationRejected: true, validConfirmationSucceededOnce: true, failedTurnIsolated: true, discardedTurnIsolated: true, conflictingRetryRejected: true, quarantineEnumerated: true, quarantineIsolated: true, deletionIsolated: true, remainingAfterDeletion: 9, removedDetailAbsent: true, unaffectedUnrenumbered: true, firstAndTenthPolicyEqual: true, sqliteRowsObserved: 10, casBlobsObserved: true });
      expect(report).toMatchObject({ apiRowsObserved: 9, apiStateObserved: true, smoke: { turnsAttempted: 3, candidatesRegistered: 3, confirmationBindingsObserved: 3, missingConfirmationRejections: 3, falseConfirmationRejections: 3, validPromotionsObserved: 3, durableRowsObserved: 3 } });
      expect(report.scenario.reverseDigest).toBe(report.scenario.baseDigest);
      expect(report.summaries).toHaveLength(9);
      expect(report.summaries.map(({ turnNumber }) => turnNumber)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10]);
      expect(new Set(report.summaries.map(({ stablePath }) => stablePath)).size).toBe(9);
      expect(report.smoke.evidence).toHaveLength(3);
      expect(report.promotionEvidence).toHaveLength(10);
      for (const turn of [...report.smoke.evidence, ...report.promotionEvidence]) {
        expect(turn.evidence.map(({ componentType }) => componentType).sort()).toEqual([...componentTypes].sort());
        for (const descriptor of turn.evidence) {
          if (!["rrweb", "screenshot"].includes(descriptor.componentType)) {
            expect(descriptor.digest).not.toBe(oldSyntheticDigest(turn.turnId, descriptor.componentType, turn.sourceCommit));
          }
        }
        const trace = turn.evidence.find(({ componentType }) => componentType === "trace");
        expect(trace).toMatchObject({ authority: "langfuse", availability: "available", provenance: "unknown" });
        expect(trace?.externalId).toMatch(/^(?!0{32}$)[0-9a-f]{32}$/u);
        expect(trace?.externalId).not.toBe(String(Number(turn.turnId.slice(-2))).padStart(32, "0"));
        expect(trace?.claims).toBeUndefined();
        expect(turn.evidence.find(({ componentType }) => componentType === "decision")).toMatchObject({ authority: "fixture", availability: "available", provenance: "user-supplied" });
        expect(turn.evidence.find(({ componentType }) => componentType === "verification")).toMatchObject({ authority: "fixture", availability: "available", provenance: "observed" });
      }
    } finally {
      await report.dispose();
    }
  }, 180_000);

  it("guards against direct promotion, generic synthesized descriptors, and literal success reporting", async () => {
    const source = await readFile(resolve(import.meta.dirname, "ten-save-sequence.ts"), "utf8");
    expect(source).not.toMatch(/repository\.promote\s*\(/u);
    expect(source).not.toMatch(/TYPES\.map|padStart\(32,\s*"0"\)|sha256\(`\$\{turnId\}:\$\{componentType\}:/u);
    for (const field of ["retryIdentityStable", "missingConfirmationRejected", "falseConfirmationRejected", "validConfirmationSucceededOnce", "casBlobsObserved", "apiStateObserved"]) {
      expect(source).not.toMatch(new RegExp(`${field}:\\s*true`, "u"));
    }
  });

  it("represents an absent trace authority without an invented ID, digest, or observed claim", () => {
    const trace = traceEvidenceFromAuthority({ correlation: { projectId: "remo", turnId: "01J00000000000000000000T01", captureWindowId: "window-01", boundaryRevision: "boundary-v1" }, capturedAt: "2026-08-16T07:01:00.000Z" });
    expect(trace).toMatchObject({ componentType: "trace", authority: "langfuse", availability: "missing", provenance: "unknown" });
    expect(trace.externalId).toBeUndefined();
    expect(trace.digest).toBeUndefined();
    expect(trace.claims).toBeUndefined();
  });
});
