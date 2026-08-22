import { pathToFileURL } from "node:url";
import { runTenSaveSequence } from "./ten-save-sequence.js";

export async function verifyTenSave(): Promise<void> {
  const report = await runTenSaveSequence();
  try {
    process.stdout.write(`${JSON.stringify({ event: "remo.vs001.ten-save.verified", scenarioVersion: report.scenario.version, baseDigest: report.scenario.baseDigest, reverseDigest: report.scenario.reverseDigest, smokeTurns: report.smokeTurns, smokeCandidatesRegistered: report.smoke.candidatesRegistered, smokeConfirmationBindingsObserved: report.smoke.confirmationBindingsObserved, smokeMissingConfirmationRejections: report.smoke.missingConfirmationRejections, smokeFalseConfirmationRejections: report.smoke.falseConfirmationRejections, smokeValidPromotionsObserved: report.smoke.validPromotionsObserved, durableCount: report.durableCount, distinctSavePointIds: report.distinctSavePointIds, retryCountAfter: report.retryCountAfter, missingConfirmationRejected: report.missingConfirmationRejected, falseConfirmationRejected: report.falseConfirmationRejected, validConfirmationSucceededOnce: report.validConfirmationSucceededOnce, failedTurnIsolated: report.failedTurnIsolated, discardedTurnIsolated: report.discardedTurnIsolated, quarantineEnumerated: report.quarantineEnumerated, quarantineIsolated: report.quarantineIsolated, deletionIsolated: report.deletionIsolated, remainingAfterDeletion: report.remainingAfterDeletion, unaffectedUnrenumbered: report.unaffectedUnrenumbered, sqliteRowsObserved: report.sqliteRowsObserved, casBlobsObserved: report.casBlobsObserved, apiRowsObserved: report.apiRowsObserved, apiStateObserved: report.apiStateObserved })}\n`);
  } finally {
    await report.dispose();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyTenSave();
