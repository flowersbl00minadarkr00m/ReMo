import { createHash } from "node:crypto";
import { LocalSavePointRepository, type PromotionCrashPoint, type PromotionRequest } from "./index.js";

const [projectRoot, crashPoint] = process.argv.slice(2) as [string | undefined, PromotionCrashPoint | undefined];
if (projectRoot === undefined || !["after-blob-rename", "after-transaction-commit"].includes(crashPoint ?? "")) process.exit(64);
const rrweb = Buffer.from("masked rrweb T5");
const screenshot = Buffer.from("masked screenshot T5");
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const request: PromotionRequest = {
  operationId: "operation-T5",
  turnId: "01J000000000000000000000T5",
  savePointId: "01J000000000000000000000S5",
  candidateRevision: 1,
  candidateManifestDigest: `sha256:${"c".repeat(64)}`,
  revision: 1,
  createdAt: "2026-08-16T07:30:00.000Z",
  policyRevision: "remo.privacy.v1",
  bundle: { schemaVersion: "remo.bundle.v1", integrity: { state: "complete" }, evidence: ["safe"] },
  blobs: [
    { role: "rrweb", bytes: rrweb, expectedDigest: digest(rrweb) },
    { role: "screenshot", bytes: screenshot, expectedDigest: digest(screenshot) },
  ],
};
const repository = new LocalSavePointRepository({ projectRoot, crashPoint: crashPoint as PromotionCrashPoint, crashAction: () => process.exit(86) });
repository.promote(request);
process.exit(0);
