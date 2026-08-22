import { join, resolve } from "node:path";
import { BranchGitAdapter } from "@remo/branch-git";
import { deriveBranchPreflightIdentity, evaluateBranchPreflight } from "@remo/domain";
import { inspectBranchPreflightRepository } from "@remo/evidence-git";
import { LocalSavePointRepository } from "@remo/storage-local";
import { createBranchOrchestrationService, type BranchCrashPoint } from "./branch-orchestration-service.js";

const SAVE_ID = "01J000000000000000000000S5";
const DIGEST = `sha256:${"b".repeat(64)}`;
const crashPoints = new Set<BranchCrashPoint>(["before-journal-fsync", "before-git", "after-git", "before-sqlite-success", "after-receipt"]);
const [projectRootInput, crashPointInput] = process.argv.slice(2);
if (projectRootInput === undefined || !crashPoints.has(crashPointInput as BranchCrashPoint)) process.exit(64);
const projectRoot = resolve(projectRootInput);
const crashPoint = crashPointInput as BranchCrashPoint;
const sourceCommit = process.env.REMO_T9_SOURCE_COMMIT;
if (sourceCommit === undefined || !/^[0-9a-f]{40}$/u.test(sourceCommit)) process.exit(65);

const target = deriveBranchPreflightIdentity(SAVE_ID, 1);
const evaluate = async () => {
  const inspection = await inspectBranchPreflightRepository({ repositoryRoot: projectRoot, approvedSourceRoot: "src", sourceCommit, branchRef: target.branchRef, operationWorktreePath: join(projectRoot, target.worktreeRelativePath) });
  const receipt = evaluateBranchPreflight({
    savePointId: SAVE_ID, requestedSavePointId: SAVE_ID, savePointRevision: 1, requestedSavePointRevision: 1,
    lifecycleState: "active", integrityState: "complete", fidelityState: "editable-eligible", privacyPassed: true,
    evidence: ["screenshot", "rrweb", "source", "dependencies", "lineage"].map((componentType) => ({ componentType, state: "available" as const, correlationDigest: DIGEST, evidenceDigest: DIGEST })),
    sourceCommit, sourceCommitExists: inspection.sourceCommitExists,
    repository: { gitAvailable: inspection.gitAvailable, canonicalRootSafe: inspection.canonicalRootSafe, approvedSourceRootSafe: inspection.approvedSourceRootSafe, commonDirectorySafe: inspection.commonDirectorySafe, derivedWorktreeRootSafe: inspection.derivedWorktreeRootSafe, ownershipSafe: inspection.ownershipSafe, linksAbsent: inspection.linksAbsent },
    reproducibility: { route: "/fixture/save-point", expectedRoute: "/fixture/save-point", fixture: "s005-crash-child", expectedFixture: "s005-crash-child", viewport: "1440x900", expectedViewport: "1440x900", dependencyDigest: DIGEST, expectedDependencyDigest: DIGEST, policyDigest: DIGEST, expectedPolicyDigest: DIGEST },
    target: { ...target, refAbsent: inspection.targetRefAbsent, pathAbsent: inspection.targetPathAbsent }, operationActive: false, checkoutSafety: inspection.checkoutSafety,
    originalLineageId: "lineage:original", originalFuture: inspection.originalFuture, inspectorReasonCodes: inspection.reasonCodes,
  }, new Date());
  return { receipt, originalFuture: inspection.originalFuture };
};

const initial = await evaluate();
if (!initial.receipt.ready) process.exit(66);
const repository = new LocalSavePointRepository({ projectRoot });
const service = createBranchOrchestrationService({
  store: repository,
  git: new BranchGitAdapter({ repositoryRoot: projectRoot, approvedSourceRoot: "src" }),
  preflightForMutation: evaluate,
  readIssuedReceipt: (digest) => digest === initial.receipt.digest ? initial.receipt : undefined,
  injectCrash(point) { if (point === crashPoint) process.exit(86); },
});
await service.confirm({ savePointId: SAVE_ID, confirm: true, preflightDigest: initial.receipt.digest, expectedSavePointRevision: 1, displayLabel: "S-005 abrupt child alternate", idempotencyKey: "s005-abrupt-child" });
repository.close();
process.exit(67);
