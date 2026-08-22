import { LocalSavePointRepository, type ReconciliationCrashPoint } from "../index.js";

const [projectRoot, crashPoint] = process.argv.slice(2) as [string | undefined, ReconciliationCrashPoint | undefined];
if (projectRoot === undefined || crashPoint === undefined) process.exit(2);

const savePointId = "01J000000000000000000000S5";
const turnId = "01J000000000000000000000T5";
const repository = new LocalSavePointRepository({
  projectRoot,
  now: () => new Date("2026-08-16T08:05:00.000Z"),
  crashPoint,
  crashAction: () => process.exit(87),
});
const current = repository.getCurrentRevision(savePointId);
if (current === undefined) process.exit(3);
repository.appendReconciliation({
  savePointId,
  turnId,
  expectedRevision: current.revision,
  expectedManifestDigest: current.manifestDigest,
  traceValidatedAt: "2026-08-16T08:04:00.000Z",
  bundle: { schemaVersion: "remo.bundle.v1", savePointId, correlation: { turnId }, integrity: { state: "incomplete" }, evidence: ["safe"] },
});
process.exit(4);
