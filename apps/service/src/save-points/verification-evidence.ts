import { createHash } from "node:crypto";
import type { CorrelationTuple, EvidenceDescriptor } from "@remo/domain";
import type { VerificationEvidence } from "@remo/evidence-verification";
import type { SavePointStore, StoredSavePoint } from "./save-point-service.js";

export interface VerificationEvidenceRunner {
  run(commandId: string): Promise<VerificationEvidence>;
}

export interface VerificationEvidenceInput {
  readonly commandId: string;
  readonly fixtureId: string;
  readonly correlation: CorrelationTuple;
  readonly capturedAt: string;
  readonly policyRevision: string;
}

function digest(result: VerificationEvidence): string {
  const authoritativeResult = {
    commandId: result.commandId,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimited: result.outputLimited,
    ...(result.stdoutDigest === undefined ? {} : { stdoutDigest: result.stdoutDigest }),
    ...(result.stderrDigest === undefined ? {} : { stderrDigest: result.stderrDigest }),
    reasonCodes: result.reasonCodes,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(authoritativeResult)).digest("hex")}`;
}

export async function collectVerificationEvidence(
  runner: VerificationEvidenceRunner,
  input: VerificationEvidenceInput,
): Promise<EvidenceDescriptor> {
  const result = await runner.run(input.commandId);
  return {
    componentId: `${input.correlation.turnId}:verification`,
    componentType: "verification",
    authority: "fixture",
    correlation: input.correlation,
    capturedAt: input.capturedAt,
    digest: digest(result),
    availability: result.status === "passed" ? "available" : "rejected",
    provenance: "observed",
    policyRevision: input.policyRevision,
    claims: { fixtureId: input.fixtureId },
  };
}

export function createVerificationEvidenceService(
  store: SavePointStore,
  runner: VerificationEvidenceRunner,
): {
  run(savePointId: string, input: Omit<VerificationEvidenceInput, "correlation">): Promise<StoredSavePoint>;
} {
  return {
    async run(savePointId, input) {
      const current = store.get(savePointId);
      if (current === undefined) throw new Error("Save point was not found.");
      const verificationCount = current.finalization.evidence.filter(({ componentType }) => componentType === "verification").length;
      if (verificationCount !== 1) throw new Error("Exactly one verification component is required before verification reconciliation.");
      const verification = await collectVerificationEvidence(runner, {
        ...input,
        correlation: current.finalization.correlation,
      });
      return store.update(savePointId, {
        ...current.finalization,
        evidence: current.finalization.evidence.map((descriptor) => descriptor.componentType === "verification" ? verification : descriptor),
      });
    },
  };
}
