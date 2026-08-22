import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { BundleManifest, ComparisonContext, ComparisonSideInput, ComponentType, CorrelationTuple, EvidenceDescriptor, FinalizationInput } from "@remo/domain";
import { isValidProductSavePointId, matchProductRoute, sha256Canonical, type ProductRouteBootstrap, type RouteRecoveryState } from "@remo/domain";
import { BranchGitAdapter } from "@remo/branch-git";
import { createContractLangfuseFake, type LangfuseLookup } from "@remo/evidence-langfuse";
import type { CurrentDurableSavePoint } from "@remo/storage-local";
import { createCandidateReview, type CandidateReviewRecord } from "../candidates/candidate-service.js";
import { createBranchPreflightApi } from "../branch-preflight/branch-preflight-api.js";
import { createBranchPreflightService, type BranchPreflightServiceOptions } from "../branch-preflight/branch-preflight-service.js";
import { createBranchOrchestrationApi } from "../branch-orchestration/branch-orchestration-api.js";
import { createBranchOrchestrationService, type BranchCrashPoint, type BranchOrchestrationServiceOptions } from "../branch-orchestration/branch-orchestration-service.js";
import { createComparisonApi } from "../comparisons/comparison-api.js";
import { createDecisionApi } from "../decisions/decision-api.js";
import { createDecisionService } from "../decisions/decision-service.js";
import { createEvidenceMediaHandler, safelyAvailableEvidenceMedia, validateRrwebBytes } from "../evidence-media/handler.js";
import { createEvidenceMediaMount, matchEvidenceMediaRoute } from "../evidence-media/mount.js";
import { createHistoryApi } from "../history/history-api.js";
import { createLifecycleApi } from "../lifecycle/lifecycle-api.js";
import { createLifecycleService, startLifecycleSweep } from "../lifecycle/lifecycle-service.js";
import { createReconciliationService } from "../reconcile/reconciliation-service.js";
import { REPLAY_PARENT_ORIGIN, REPLAY_RUNTIME_ORIGIN, startReplayRuntime, type ReplayRuntimeAvailability } from "../replay-runtime/runtime-server.js";
import { createSavePointApi, safeProjection, type ExternalAuthorityRoots } from "../save-points/save-point-api.js";
import { createDurableSavePointStore } from "../save-points/save-point-service.js";
import { createLocalPromotionRuntime } from "./promotion-runtime.js";

const FIXTURE_LABEL = "VS-001 implementation fixture — approved binding fixture";
const TURN_ID = "01J000000000000000000000T5";
const SAVE_POINT_ID = "01J000000000000000000000S5";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SOURCE_COMMIT = "54474fd8d763cb9acaaa2e83b6df44df36fe7d92";
const CAPTURE_FIXTURE_URL = "http://127.0.0.1:4173/fixture/save-point";
const DEFAULT_AUTHORITY_ROOTS: ExternalAuthorityRoots = {
  source: { baseUrl: "https://github.com/example/remo", approvedHosts: ["github.com"] },
  trace: { baseUrl: "https://traces.example.test", approvedHosts: ["traces.example.test"], projectId: "remo" },
};

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pngViewport(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width < 1 || height < 1 || width > 16_384 || height > 16_384 ? undefined : { width, height };
}

function implementationFixture(decisionTurn4 = false): CandidateReviewRecord {
  const createdAt = "2026-08-16T07:30:00.000Z";
  const turnId = decisionTurn4 ? "01J00000000000000000000T04" : TURN_ID;
  const savePointId = decisionTurn4 ? "01J00000000000000000000S04" : SAVE_POINT_ID;
  const correlation: CorrelationTuple = { projectId: "remo", turnId, captureWindowId: decisionTurn4 ? "window-t4-decision-fixture" : "window-t5-fixture", boundaryRevision: "boundary-v1" };
  const types: readonly ComponentType[] = ["source", "rrweb", "screenshot", "trace", "decision", "verification", "dependencies", "lineage"];
  const fixtureRoot = resolve(import.meta.dirname, "../evidence-media/fixtures/s-001");
  const rrwebBytes = readFileSync(resolve(fixtureRoot, "privacy-cleared.rrweb.json"));
  const screenshotBytes = readFileSync(resolve(fixtureRoot, "privacy-cleared.png"));
  const evidence: EvidenceDescriptor[] = types.map((componentType) => ({
    componentId: `${turnId}:${componentType}`,
    componentType,
    authority: componentType === "source" ? "git" : componentType === "rrweb" ? "rrweb" : componentType === "trace" ? "langfuse" : "remo",
    correlation,
    capturedAt: createdAt,
    digest: `sha256:${componentType}`,
    ...(componentType === "trace" ? { externalId: TRACE_ID, externalUrl: "javascript:raw-descriptor-must-never-cross-projection" } : {}),
    availability: "available",
    provenance: componentType === "decision" ? "user-supplied" : "observed",
    policyRevision: "remo.privacy.v1",
    claims: { sourceState: SOURCE_COMMIT, fixtureId: decisionTurn4 ? "vs001-sequence:4:consequential-low-uncertainty" : "vs001-sequence:5:approved-binding-fixture" },
  }));
  return createCandidateReview({
    finalization: { schemaVersion: "remo.bundle.v1", identityVersion: "ulid-v1", policyRevision: "remo.privacy.v1", savePointId, correlation, evidence },
    nomination: { status: "candidate", categories: ["responsive", "accessibility"], boundaries: [{ kind: decisionTurn4 ? "decision" : "verification", boundaryId: decisionTurn4 ? "fixture-low-uncertainty-decision" : "fixture-verification", occurredAt: createdAt }], reasonCodes: ["nomination.meaningful-change-with-boundary"] },
    privacyCapture: { status: "passed", evidence: { rrwebBytes, screenshotBytes, receipt: { status: "passed", policyRevision: "remo.privacy.v1", rrwebDigest: digest(rrwebBytes), rrwebSize: rrwebBytes.byteLength, screenshotDigest: digest(screenshotBytes), screenshotSize: screenshotBytes.byteLength, checkedAt: createdAt } } },
    createdAt,
  });
}

function canonicalProjectRoot(path: string): string {
  const unresolved = resolve(path);
  const unresolvedEntry = lstatSync(unresolved);
  if (unresolvedEntry.isSymbolicLink()) throw new Error("Configured project root cannot be a symbolic link, junction, or reparse point");
  const root = realpathSync.native(unresolved);
  const comparable = (value: string): string => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  if (comparable(root) !== comparable(unresolved)) throw new Error("Configured project root must already be its canonical native path and cannot traverse a reparse point");
  if (!statSync(root).isDirectory() || !existsSync(join(root, ".git"))) throw new Error("Configured project root must be an existing canonical Git project root");
  return root;
}

export function safeWebPath(webRoot: string, requestPath: string): string | undefined {
  const pathname = new URL(requestPath, "http://127.0.0.1").pathname;
  const requested = pathname === "/" || matchProductRoute(pathname) !== undefined || /^\/replay\/.*$/u.test(pathname) ? "index.html" : pathname.slice(1);
  const path = resolve(webRoot, requested);
  return relative(webRoot, path).startsWith("..") || !path.startsWith(`${webRoot}${sep}`) ? undefined : path;
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function staticSecurityHeaders(nonce: string): Readonly<Record<string, string>> {
  return {
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      `frame-src ${REPLAY_RUNTIME_ORIGIN}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

type LocalApplicationCleanup = () => void | Promise<void>;

export async function settleLocalApplicationResources(
  cleanups: readonly LocalApplicationCleanup[],
  primary?: { readonly error: unknown },
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primary !== undefined) throw primary.error;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Local application cleanup failed");
}

export async function startLocalApplication(options: { readonly projectRoot: string; readonly port: number; readonly traceLookup?: LangfuseLookup; readonly authorityRoots?: ExternalAuthorityRoots; readonly webRoot?: string; readonly now?: () => Date; readonly lifecycleSweepEveryMs?: number; readonly seedImplementationFixture?: boolean; readonly seedDecisionFixtureTurn4?: boolean; readonly branchPreflightInspect?: BranchPreflightServiceOptions["inspect"]; readonly branchPreflightNow?: () => Date; readonly branchGitAdapter?: BranchOrchestrationServiceOptions["git"]; readonly branchCrashInjector?: (point: BranchCrashPoint) => void | Promise<void> }): Promise<{ readonly origin: string; readonly replayRuntime: ReplayRuntimeAvailability; readonly close: () => Promise<void> }> {
  const projectRoot = canonicalProjectRoot(options.projectRoot);
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) throw new TypeError("Port must be an integer from 1 to 65535");
  const origin = `http://127.0.0.1:${options.port}`;
  const candidate = options.seedImplementationFixture === false ? undefined : implementationFixture(options.seedDecisionFixtureTurn4 === true);
  if (candidate !== undefined && candidate.status !== "reviewable") throw new Error("The supported implementation fixture must be privacy-cleared and reviewable.");
  const candidates = new Map(candidate === undefined ? [] : [[candidate.projection.turnId, candidate]]);
  const runtime = createLocalPromotionRuntime({ projectRoot, allowedOrigin: origin, findCandidate: (turnId) => candidates.get(turnId), ...(options.now === undefined ? {} : { now: options.now }) });
  const startupCleanups: LocalApplicationCleanup[] = [() => runtime.close()];
  try {
  if (candidate !== undefined && runtime.repository.getDurable(candidate.projection.turnId) === undefined) {
    const captureStartedAt = Date.now();
    runtime.repository.registerCandidate({
      operationId: `candidate-${candidate.projection.turnId}`,
      turnId: candidate.projection.turnId,
      savePointId: candidate.finalization.savePointId,
      revision: candidate.projection.confirmationBinding?.candidateRevision ?? 1,
      manifestDigest: candidate.manifestDigest,
      createdAt: candidate.createdAt,
      policyRevision: candidate.finalization.policyRevision,
      manifest: candidate.evaluated.manifest,
      blobs: [
        { role: "rrweb", bytes: candidate.safeEvidence.rrwebBytes, expectedDigest: candidate.safeEvidence.receipt.rrwebDigest },
        { role: "screenshot", bytes: candidate.safeEvidence.screenshotBytes, expectedDigest: candidate.safeEvidence.receipt.screenshotDigest },
      ],
    });
    runtime.diagnostics.report({ operationId: "capture.register-candidate", operationInstanceId: `candidate-${candidate.projection.turnId}`, turnIds: [candidate.projection.turnId], savePointIds: [candidate.finalization.savePointId], reasonCodes: [...candidate.evaluated.integrity.reasonCodes], durationMs: Date.now() - captureStartedAt, perTurnLatencyMs: Date.now() - captureStartedAt, retryCount: 0, sizes: { eventBytes: candidate.safeEvidence.rrwebBytes.byteLength, blobBytes: candidate.safeEvidence.rrwebBytes.byteLength + candidate.safeEvidence.screenshotBytes.byteLength }, digests: { manifest: [candidate.manifestDigest], rrweb: [candidate.safeEvidence.receipt.rrwebDigest], screenshot: [candidate.safeEvidence.receipt.screenshotDigest] }, policyVersions: { privacy: candidate.finalization.policyRevision, integrity: candidate.finalization.policyRevision }, outcomes: { privacy: "passed", integrity: candidate.evaluated.integrity.state }, result: candidate.evaluated.promotionAllowed ? "pass" : "degraded" });
  }
  const currentDurable = (): readonly CurrentDurableSavePoint[] => runtime.repository.listCurrentDurable();
  const finalizationFrom = (current: CurrentDurableSavePoint): FinalizationInput => {
    const manifest = current.bundle as BundleManifest;
    if (manifest.savePointId !== current.receipt.savePointId || manifest.correlation.turnId !== current.receipt.turnId) throw new Error("Current durable enumeration returned a mismatched manifest identity.");
    return { schemaVersion: manifest.schemaVersion, identityVersion: manifest.identityVersion, policyRevision: manifest.policyRevision, savePointId: manifest.savePointId, correlation: manifest.correlation, privacy: manifest.privacy, evidence: manifest.evidence };
  };
  const seedFrom = (current: CurrentDurableSavePoint) => {
    const finalization = finalizationFrom(current);
    const source = finalization.evidence.find(({ componentType }) => componentType === "source");
    const fixtureId = source?.claims?.fixtureId ?? "";
    const scenario = /^vs001-sequence:\d+:(.+)$/u.exec(fixtureId)?.[1];
    if (current.lifecycle.state !== "active" && current.lifecycle.state !== "quarantined") throw new Error("Current durable enumeration returned a non-current lifecycle state.");
    return {
      finalization,
      nominationReason: scenario === undefined ? "A meaningful UI change passed its explicit verification boundary." : `Versioned scenario ${scenario} passed its explicit verification boundary.`,
      retention: { createdAt: current.lifecycle.createdAt, promotedAt: current.receipt.promotedAt, expiresAt: current.lifecycle.expiresAt, originalExpiresAt: current.lifecycle.originalExpiresAt, pinned: current.lifecycle.pinned, ...(current.lifecycle.pinnedAt === undefined ? {} : { pinnedAt: current.lifecycle.pinnedAt }), state: current.lifecycle.state },
      policyRevisions: { capture: "capture-v2", privacy: finalization.policyRevision, integrity: finalization.policyRevision, fidelity: "fidelity-v2", retention: "retention-v1" },
    } as const;
  };
  const seeds = currentDurable().filter(({ lifecycle }) => lifecycle.state === "active").map(seedFrom);
  if (candidate?.status === "reviewable" && !seeds.some(({ finalization }) => finalization.savePointId === candidate.finalization.savePointId)) {
    seeds.push({
      finalization: candidate.finalization,
      nominationReason: options.seedDecisionFixtureTurn4 === true ? "A consequential navigation change crossed the decision boundary despite low expressed uncertainty." : "Responsive and accessibility verification passed after a meaningful UI change.",
      retention: { createdAt: candidate.createdAt, promotedAt: candidate.createdAt, expiresAt: candidate.createdAt, originalExpiresAt: candidate.createdAt, pinned: false, state: "active" },
      policyRevisions: { capture: "capture-v2", privacy: candidate.finalization.policyRevision, integrity: candidate.finalization.policyRevision, fidelity: "fidelity-v2", retention: "retention-v1" },
    });
  }
  const store = createDurableSavePointStore(runtime.repository, seeds);
  const lookup = options.traceLookup ?? createContractLangfuseFake({ [TRACE_ID]: { status: "matching", metadataTurnId: candidate?.projection.turnId ?? TURN_ID, validatedAt: new Date().toISOString() } });
  const reconciliation = createReconciliationService(store, lookup, runtime.diagnostics);
  const authorityRoots = options.authorityRoots ?? DEFAULT_AUTHORITY_ROOTS;
  const savePointApi = createSavePointApi({ allowedOrigin: origin, store, reconcile: (savePointId, idempotencyKey) => reconciliation.reconcile(savePointId, idempotencyKey), authorityRoots, sessionToken: runtime.api.sessionToken });
  const lifecycleService = createLifecycleService(runtime.repository, runtime.diagnostics);
  const lifecycleApi = createLifecycleApi({ allowedOrigin: origin, sessionToken: runtime.api.sessionToken, service: lifecycleService });
  const decisionService = createDecisionService({
    repository: runtime.repository,
    findCandidate: (turnId) => {
      const record = candidates.get(turnId);
      const binding = record?.projection.confirmationBinding;
      const lifecycle = runtime.repository.getCandidateLifecycle(turnId);
      return record === undefined || binding === undefined || lifecycle === undefined ? undefined : { savePointId: binding.savePointId, turnId, evidenceComponentIds: record.finalization.evidence.map(({ componentId }) => componentId), candidateRevision: binding.candidateRevision, candidateManifestDigest: binding.candidateManifestDigest };
    },
    findDurable: (savePointId) => {
      const current = currentDurable().find(({ receipt }) => receipt.savePointId === savePointId);
      if (current === undefined || current.lifecycle.state !== "active") return undefined;
      const finalization = finalizationFrom(current);
      return { savePointId, turnId: finalization.correlation.turnId, evidenceComponentIds: finalization.evidence.map(({ componentId }) => componentId) };
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const decisionApi = createDecisionApi({ allowedOrigin: origin, sessionToken: runtime.api.sessionToken, service: decisionService });
  const historyApi = createHistoryApi(runtime.repository);
  const supportedSeed = seeds[0];
  const supportedDependencyDigest = supportedSeed?.finalization.evidence.find(({ componentType }) => componentType === "dependencies")?.digest ?? "unavailable";
  const supportedPolicyDigest = supportedSeed === undefined ? "unavailable" : sha256Canonical(supportedSeed.policyRevisions);
  const branchPreflightService = createBranchPreflightService({
    repositoryRoot: projectRoot,
    approvedSourceRoot: "packages/test-fixtures/vs001-ui/src",
    pendingBranchOperation: () => runtime.repository.listPendingBranchOperations().length > 0,
    ...(options.branchPreflightInspect === undefined ? {} : { inspect: options.branchPreflightInspect }),
    ...(options.branchPreflightNow === undefined ? {} : { now: options.branchPreflightNow }),
    expected: { route: "/fixture/save-point", fixture: "vs001-ui-sequence-v1", viewport: "1440x900", dependencyDigest: supportedDependencyDigest, policyDigest: supportedPolicyDigest },
    findSavePoint: (savePointId) => {
      const stored = store.get(savePointId);
      if (stored === undefined) return undefined;
      const lifecycle = runtime.repository.getLifecycle(savePointId);
      const anchor = runtime.repository.listHistory(10).anchors.find((value) => value.savePointId === savePointId);
      const screenshot = stored.finalization.evidence.find(({ componentType }) => componentType === "screenshot");
      const replay = stored.finalization.evidence.find(({ componentType }) => componentType === "rrweb");
      const source = stored.finalization.evidence.find(({ componentType }) => componentType === "source");
      const dependency = stored.finalization.evidence.find(({ componentType }) => componentType === "dependencies");
      const screenshotRead = screenshot?.availability === "available" && screenshot.digest !== undefined
        ? runtime.repository.readEvidenceMedia({ savePointId, componentId: screenshot.componentId, role: "screenshot", expectedRevision: stored.revision, expectedManifestDigest: stored.manifestDigest, expectedDigest: screenshot.digest })
        : undefined;
      const replayRead = replay?.availability === "available" && replay.digest !== undefined
        ? runtime.repository.readEvidenceMedia({ savePointId, componentId: replay.componentId, role: "rrweb", expectedRevision: stored.revision, expectedManifestDigest: stored.manifestDigest, expectedDigest: replay.digest })
        : undefined;
      const viewport = screenshotRead?.status === "available" ? pngViewport(screenshotRead.bytes) : undefined;
      let capture: ReturnType<typeof validateRrwebBytes> | undefined;
      if (replayRead?.status === "available") { try { capture = validateRrwebBytes(replayRead.bytes, CAPTURE_FIXTURE_URL); } catch { capture = undefined; } }
      const fixtureClaim = source?.claims?.fixtureId;
      const fixture = fixtureClaim?.startsWith("vs001-sequence:") === true ? "vs001-ui-sequence-v1" : fixtureClaim ?? "unavailable";
      const required = ["screenshot", "rrweb", "source", "dependencies", "lineage"] as const;
      return {
        savePointId,
        revision: stored.revision,
        lifecycleState: lifecycle?.state === "quarantined" ? "quarantined" : lifecycle?.state === "active" ? "active" : "expired",
        integrityState: stored.integrity.state,
        fidelityState: stored.fidelity.state,
        privacyPassed: stored.finalization.privacy.status === "passed",
        evidence: required.map((componentType) => {
          const descriptor = stored.finalization.evidence.find((value) => value.componentType === componentType);
          return descriptor === undefined
            ? { componentType, state: "not-evaluated" as const, correlationDigest: sha256Canonical({ missing: componentType }), evidenceDigest: sha256Canonical({ missing: componentType }) }
            : { componentType, state: descriptor.availability === "available" ? "available" as const : "blocked" as const, correlationDigest: sha256Canonical(descriptor.correlation), evidenceDigest: descriptor.digest !== undefined && /^sha256:[0-9a-f]{64}$/u.test(descriptor.digest) ? descriptor.digest : sha256Canonical(descriptor) };
        }),
        sourceCommit: source?.claims?.sourceState ?? "0".repeat(40),
        originalLineageId: anchor?.lineageId ?? "lineage:unknown",
        route: capture?.path ?? "unavailable",
        fixture,
        viewport: viewport === undefined || capture === undefined || capture.viewport.width !== viewport.width || capture.viewport.height !== viewport.height ? "unavailable" : `${viewport.width}x${viewport.height}`,
        dependencyDigest: dependency?.digest ?? "unavailable",
        policyDigest: sha256Canonical(stored.policyRevisions),
      };
    },
  });
  const branchPreflightApi = createBranchPreflightApi({ allowedOrigin: origin, sessionToken: runtime.api.sessionToken, evaluate: branchPreflightService.preflight });
  const branchGitAdapter = options.branchGitAdapter ?? new BranchGitAdapter({ repositoryRoot: projectRoot, approvedSourceRoot: "packages/test-fixtures/vs001-ui/src" });
  const branchOrchestrationService = createBranchOrchestrationService({
    store: runtime.repository,
    git: branchGitAdapter,
    preflightForMutation: branchPreflightService.preflightForMutation,
    readIssuedReceipt: branchPreflightService.readIssuedReceipt,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.branchCrashInjector === undefined ? {} : { injectCrash: options.branchCrashInjector }),
    diagnostics: runtime.diagnostics,
  });
  await branchOrchestrationService.reconcileStartup();
  const branchOrchestrationApi = createBranchOrchestrationApi({ allowedOrigin: origin, sessionToken: runtime.api.sessionToken, service: branchOrchestrationService });
  const comparisonApi = createComparisonApi({ resolveSide: (savePointId): ComparisonSideInput => {
    const historyAnchor = runtime.repository.listHistory(10).anchors.find((anchor) => anchor.savePointId === savePointId);
    const stored = store.get(savePointId);
    if (stored === undefined) {
      const deleted = historyAnchor?.state === "tombstone";
      return { savePointId, ...(historyAnchor?.turnId === undefined ? {} : { turnId: historyAnchor.turnId }), state: deleted ? "deleted" : "missing", screenshot: { availability: deleted ? "unavailable" : "missing" }, source: { state: deleted ? "unavailable" : "unknown", summary: deleted ? "Source summary was removed with the deleted local evidence." : "No surviving safe source projection exists for this identity." }, decision: { state: deleted ? "unavailable" : "unknown" }, verification: { state: deleted ? "unavailable" : "unknown", summary: deleted ? "Verification payload was deleted." : "No surviving verification projection exists for this identity." }, integrity: { state: "unavailable", explanation: deleted ? "Only a lifecycle-safe tombstone survives." : "No trustworthy identity or receipt was found." }, fidelity: { state: "unavailable", explanation: "Reproducibility is not claimed for an unavailable side." } };
    }
    const detail = safeProjection(stored, authorityRoots);
    const media = safelyAvailableEvidenceMedia({ reader: runtime.repository, savePointId, allowedCaptureUrl: CAPTURE_FIXTURE_URL });
    const dependencyDescriptor = stored.finalization.evidence.find(({ componentType }) => componentType === "dependencies");
    const verificationDescriptor = stored.finalization.evidence.find(({ componentType }) => componentType === "verification");
    const screenshotEvidence = stored.finalization.evidence.find(({ componentType }) => componentType === "screenshot");
    const replayEvidence = stored.finalization.evidence.find(({ componentType }) => componentType === "rrweb");
    const sourceEvidence = stored.finalization.evidence.find(({ componentType }) => componentType === "source");
    const screenshotDescriptor = detail.components.find(({ type }) => type === "screenshot");
    const sourceProjection = detail.components.find(({ type }) => type === "source");
    const decision = decisionService.read(savePointId)?.current;
    const selectedOption = decision?.selectedOptionId.value === undefined ? undefined : decision.options.value?.find(({ id }) => id === decision.selectedOptionId.value)?.label ?? decision.selectedOptionId.value;
    const screenshotRead = screenshotEvidence?.availability === "available" && screenshotEvidence.digest !== undefined
      ? runtime.repository.readEvidenceMedia({ savePointId, componentId: screenshotEvidence.componentId, role: "screenshot", expectedRevision: stored.revision, expectedManifestDigest: stored.manifestDigest, expectedDigest: screenshotEvidence.digest })
      : undefined;
    const screenshotViewport = screenshotRead?.status === "available" ? pngViewport(screenshotRead.bytes) : undefined;
    const replayRead = replayEvidence?.availability === "available" && replayEvidence.digest !== undefined
      ? runtime.repository.readEvidenceMedia({ savePointId, componentId: replayEvidence.componentId, role: "rrweb", expectedRevision: stored.revision, expectedManifestDigest: stored.manifestDigest, expectedDigest: replayEvidence.digest })
      : undefined;
    let replayCapture: ReturnType<typeof validateRrwebBytes> | undefined;
    if (replayRead?.status === "available") {
      try { replayCapture = validateRrwebBytes(replayRead.bytes, CAPTURE_FIXTURE_URL); } catch { replayCapture = undefined; }
    }
    const screenshot = media.has("screenshot") && screenshotRead?.status === "available" && screenshotViewport !== undefined
      ? { availability: "available" as const, reference: `/api/save-points/${encodeURIComponent(savePointId)}/media/screenshot`, componentId: screenshotRead.componentId, digest: screenshotRead.digest, ...screenshotViewport }
      : { availability: screenshotDescriptor?.availability === "Missing" ? "missing" as const : "unavailable" as const };
    const fixtureClaim = sourceEvidence?.claims?.fixtureId;
    const fixture = fixtureClaim?.startsWith("vs001-sequence:") === true ? "vs001-ui-sequence-v1" : fixtureClaim;
    const context: ComparisonContext | undefined = screenshotViewport !== undefined && replayCapture !== undefined && fixture !== undefined
      && replayCapture.viewport.width === screenshotViewport.width && replayCapture.viewport.height === screenshotViewport.height ? {
      route: replayCapture.path,
      viewport: screenshotViewport,
      fixture,
      dependencyDigest: dependencyDescriptor?.digest !== undefined && /^sha256:[0-9a-f]{64}$/u.test(dependencyDescriptor.digest) ? dependencyDescriptor.digest : "unavailable",
      policyRevisions: { capture: stored.policyRevisions.capture, privacy: stored.policyRevisions.privacy, integrity: stored.policyRevisions.integrity, fidelity: stored.policyRevisions.fidelity },
      lineageId: historyAnchor?.lineageId ?? "lineage:unknown",
      provenance: "observed",
    } : undefined;
    const turnNumber = historyAnchor?.sequenceNo;
    return {
      savePointId, turnId: stored.turnId, displayId: turnNumber === undefined ? detail.displayId : `SP-${String(turnNumber).padStart(3, "0")}`, state: "available", revision: stored.revision, manifestDigest: stored.manifestDigest,
      screenshot,
      source: { state: sourceProjection?.availability === "Available" ? "available" : sourceProjection === undefined ? "unknown" : "unavailable", summary: sourceProjection?.description ?? "Source evidence is unknown.", ...(sourceProjection?.authorityMode === undefined ? {} : { authorityMode: sourceProjection.authorityMode }) },
      decision: decision === undefined ? { state: "unknown" } : { state: "available", ...(decision.question.value === undefined ? {} : { question: decision.question.value }), ...(selectedOption === undefined ? {} : { selectedOption }), provenance: decision.question.provenance, revision: decision.revision },
      verification: { state: verificationDescriptor?.availability === "available" ? "available" : verificationDescriptor === undefined ? "unknown" : "unavailable", summary: verificationDescriptor?.availability === "available" ? `Preserved verification evidence is ${verificationDescriptor.provenance} under ${verificationDescriptor.policyRevision}.` : "Verification evidence is unavailable.", ...(verificationDescriptor === undefined ? {} : { provenance: verificationDescriptor.provenance }) },
      integrity: { state: stored.integrity.state === "complete" ? "complete" : stored.integrity.state === "inconsistent" ? "inconsistent" : "incomplete", explanation: detail.integrity.explanation },
      fidelity: { state: stored.fidelity.state === "editable-eligible" ? "editable-eligible" : stored.fidelity.state === "historical-only" ? "historical-only" : "degraded", explanation: detail.fidelity.explanation },
      ...(context === undefined ? {} : { context }), replayPath: `/replay/${encodeURIComponent(savePointId)}`,
    };
  } });
  const evidenceMediaMount = createEvidenceMediaMount(createEvidenceMediaHandler({ allowedOrigin: origin, allowedCaptureUrl: CAPTURE_FIXTURE_URL, sessionToken: runtime.api.sessionToken, reader: runtime.repository }));
  const retiredSavePointRoutes = new Map<string, Exclude<RouteRecoveryState, "ready" | "bootstrap-absent" | "missing" | "unsupported-policy" | "malformed">>();
  const sweepAndRememberExpiredRoutes = () => {
    const receipt = lifecycleService.sweep();
    for (const savePointId of receipt.durableSavePoints) retiredSavePointRoutes.set(savePointId, "expired");
    return receipt;
  };
  const lifecycleSweep = startLifecycleSweep({ sweep: sweepAndRememberExpiredRoutes, ...(options.lifecycleSweepEveryMs === undefined ? {} : { everyMs: options.lifecycleSweepEveryMs }) });
  startupCleanups.unshift(() => lifecycleSweep.close());
  const webRoot = realpathSync.native(resolve(options.webRoot ?? resolve(import.meta.dirname, "../../../web/dist")));
  const replayRuntime = origin === REPLAY_PARENT_ORIGIN
    ? await startReplayRuntime({ webRoot })
    : { availability: { state: "listener-unavailable", origin: REPLAY_RUNTIME_ORIGIN, reasonCode: "replay.parent-origin-unavailable" } as const, close: () => Promise.resolve() };
  startupCleanups.unshift(() => replayRuntime.close());
  const routeBootstrap = (pathname: string, savePointId?: string): ProductRouteBootstrap | undefined => {
    const route = matchProductRoute(pathname);
    if (route === undefined) return /^\/replay\/.*$/u.test(pathname) ? { route: pathname, state: "malformed" } : undefined;
    if ((route.id === "save-point-detail" || route.id === "replay-detail") && savePointId !== undefined) {
      if (!isValidProductSavePointId(savePointId)) return { route: pathname, state: "malformed" };
      const lifecycle = runtime.repository.getLifecycle(savePointId);
      if (lifecycle?.state === "quarantined") return { route: pathname, state: "quarantined" };
      const savePoint = store.get(savePointId);
      const historyState = savePoint === undefined && route.id === "replay-detail" ? runtime.repository.listHistory(10).anchors.find((anchor) => anchor.savePointId === savePointId)?.state : undefined;
      const state = savePoint === undefined ? retiredSavePointRoutes.get(savePointId) ?? (historyState === "tombstone" ? "deleted" : "missing") : "ready";
      return { route: pathname, state, ...(savePoint === undefined ? {} : { savePointId }) };
    }
    if (route.id === "candidate-review") {
      const candidateLifecycle = candidate === undefined ? undefined : runtime.repository.getCandidateLifecycle(candidate.projection.turnId);
      const durable = candidate === undefined ? undefined : runtime.repository.getDurable(candidate.projection.turnId);
      const state: RouteRecoveryState = candidate === undefined ? "bootstrap-absent" : candidateLifecycle?.state === "quarantined" ? "quarantined" : candidateLifecycle === undefined && durable === undefined ? "expired" : "ready";
      return { route: pathname, state };
    }
    return { route: pathname, state: "ready" };
  };
  const server: Server = createServer();
  const closeServer = (): Promise<void> => new Promise((resolveClose, reject) => {
    if (!server.listening) { resolveClose(); return; }
    server.close((error) => { if (error !== undefined) reject(error); else resolveClose(); });
    server.closeAllConnections();
  });
  startupCleanups.unshift(closeServer);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= settleLocalApplicationResources(startupCleanups);
  server.on("request", (request, response) => {
    if (historyApi.handle(request, response)) return;
    if (comparisonApi.handle(request, response)) return;
    if (branchOrchestrationApi.matches(request.url)) { void branchOrchestrationApi.handle(request, response); return; }
    if (branchPreflightApi.matches(request.url)) { void branchPreflightApi.handle(request, response); return; }
    if (decisionApi.matches(request.url)) { void decisionApi.handle(request, response); return; }
    if (matchEvidenceMediaRoute(request.url) !== undefined) { void evidenceMediaMount(request, response); return; }
    if (request.method === "GET" && request.url === "/api/save-points") {
      const summaries = currentDurable().map((current) => {
        const finalization = finalizationFrom(current);
        const fixtureId = finalization.evidence.find(({ componentType }) => componentType === "source")?.claims?.fixtureId;
        const turnNumber = Number(/^vs001-sequence:(\d+):/u.exec(fixtureId ?? "")?.[1]);
        if (!Number.isSafeInteger(turnNumber) || turnNumber < 1) throw new Error("Current durable manifest is missing its authoritative turn sequence.");
        return {
          savePointId: current.receipt.savePointId,
          displayId: `SP-${String(turnNumber).padStart(3, "0")}`,
          turnId: current.receipt.turnId,
          turnNumber,
          stablePath: `/save-points/${encodeURIComponent(current.receipt.savePointId)}`,
          savedAt: current.receipt.promotedAt,
          integrity: current.lifecycle.state === "quarantined" ? "Quarantined" : current.receipt.health === "complete" ? "Complete" : "Incomplete",
          fidelity: current.receipt.fidelity === "editable-eligible" ? "Editable eligible" : "Degraded",
          pinned: current.lifecycle.pinned,
          expiresAt: current.lifecycle.expiresAt,
        };
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(summaries));
      return;
    }
    if (request.url?.startsWith("/api/candidates/") === true) {
      const candidateId = /^\/api\/candidates\/([A-Za-z0-9_-]{1,128})/u.exec(request.url)?.[1];
      const candidateLifecycle = candidateId === undefined ? undefined : runtime.repository.getCandidateLifecycle(candidateId);
      if (candidateId !== undefined && candidateLifecycle === undefined && runtime.repository.getDurable(candidateId) === undefined) {
        response.writeHead(410, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end('{"error":"candidate.expired"}');
        return;
      }
      if (candidateLifecycle?.state === "quarantined") {
        response.writeHead(423, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end('{"error":"candidate.quarantined"}');
        return;
      }
      void runtime.api.handle(request, response);
      return;
    }
    if (request.url?.startsWith("/api/save-points/") === true) {
      const lifecycleMatch = /^\/api\/save-points\/([A-Za-z0-9_-]{1,128})(?:\/(lifecycle|pin|unpin|export|quarantine|redact))?$/u.exec(request.url);
      void lifecycleApi.handle(request, response).then((handled) => {
        if (handled) {
          const savePointId = lifecycleMatch?.[1];
          const action = lifecycleMatch?.[2];
          if (savePointId !== undefined && response.statusCode === 200) {
            if (request.method === "DELETE" && action === undefined) retiredSavePointRoutes.set(savePointId, "deleted");
            else if (action === "quarantine") retiredSavePointRoutes.set(savePointId, "quarantined");
            else if (action === "unpin" && runtime.repository.getLifecycle(savePointId) === undefined) retiredSavePointRoutes.set(savePointId, "expired");
          }
          return;
        }
        void savePointApi.handle(request, response);
      });
      return;
    }
    if (request.url === "/api/application/shutdown" && request.method === "POST") {
      if (request.headers.origin !== origin || !sameToken(request.headers["x-remo-session-token"] as string | undefined, runtime.api.sessionToken)) {
        response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" }).end('{"status":"failed"}');
        return;
      }
      response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" }).end('{"status":"stopping"}');
      setTimeout(() => void close(), 100);
      return;
    }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    const requestUrl = request.url ?? "/";
    const requestPathname = new URL(requestUrl, origin).pathname;
    const matchedRoute = matchProductRoute(requestPathname);
    const savePointId = matchedRoute?.id === "save-point-detail" || matchedRoute?.id === "replay-detail" ? matchedRoute.params.id : undefined;
    const savePoint = savePointId === undefined || !isValidProductSavePointId(savePointId) ? undefined : store.get(savePointId);
    const path = safeWebPath(webRoot, requestUrl);
    if (path === undefined || !existsSync(path) || !statSync(path).isFile()) { response.writeHead(404).end(); return; }
    const nonce = randomBytes(18).toString("base64url");
    let bytes = readFileSync(path);
    if (path.endsWith("index.html")) {
      const detailProjection = savePoint === undefined ? undefined : safeProjection(savePoint, authorityRoots);
      const safeMedia = savePoint === undefined ? undefined : safelyAvailableEvidenceMedia({ reader: runtime.repository, savePointId: savePoint.savePointId, allowedCaptureUrl: CAPTURE_FIXTURE_URL });
      const mediaAdjustedDetailProjection = detailProjection === undefined || safeMedia === undefined ? detailProjection : (() => {
        const unavailableMedia = detailProjection.components.filter(({ type, availability }) => (type === "rrweb" || type === "screenshot") && availability === "Available" && !safeMedia.has(type));
        if (unavailableMedia.length === 0) return detailProjection;
        return {
          ...detailProjection,
          integrity: { state: "Incomplete" as const, explanation: "Stored media that cannot pass current safe reconstruction checks is not displayed.", reasonCodes: [...detailProjection.integrity.reasonCodes, "media.safe-reconstruction-unavailable"] },
          fidelity: { state: "Degraded" as const, explanation: "Historical evidence remains inspectable, but unsafe or malformed stored media is excluded." },
          components: detailProjection.components.map((component) => unavailableMedia.some(({ type }) => type === component.type)
            ? { ...component, availability: "Unreachable" as const, description: "Stored media did not pass current safe reconstruction checks and is not displayed." }
            : component),
        };
      })();
      const detailFixtureId = savePoint?.finalization.evidence.find(({ componentType }) => componentType === "source")?.claims?.fixtureId;
      const detailTurnNumber = Number(/^vs001-sequence:(\d+):/u.exec(detailFixtureId ?? "")?.[1]);
      const normalizedDetailProjection = mediaAdjustedDetailProjection === undefined || !Number.isSafeInteger(detailTurnNumber) ? mediaAdjustedDetailProjection : { ...mediaAdjustedDetailProjection, displayId: `SP-${String(detailTurnNumber).padStart(3, "0")}` };
      const routeState = routeBootstrap(requestPathname, savePointId);
      const routeBootstrapValue = routeState === undefined ? "" : `window.__REMO_ROUTE_BOOTSTRAP__=${JSON.stringify(routeState).replaceAll("<", "\\u003c")};`;
      const replayRuntimeBootstrapValue = `window.__REMO_REPLAY_RUNTIME__=${JSON.stringify(replayRuntime.availability).replaceAll("<", "\\u003c")};`;
      const recoveryBootstrap = routeState !== undefined && routeState.state !== "ready";
      const comparisonSessionValue = matchedRoute?.id === "compare" || matchedRoute?.id === "replay" || matchedRoute?.id === "replay-detail" ? `window.__REMO_SAVE_POINT_SESSION__=${JSON.stringify({ sessionToken: savePointApi.sessionToken })};` : "";
      const bootstrap = recoveryBootstrap
        ? `<script nonce="${nonce}">${routeBootstrapValue}${replayRuntimeBootstrapValue}</script>`
        : matchedRoute?.id === "candidate-review" && savePoint === undefined && candidate !== undefined
        ? `<script nonce="${nonce}">${replayRuntimeBootstrapValue}window.__REMO_CANDIDATE__=${JSON.stringify(candidate.projection).replaceAll("<", "\\u003c")};window.__REMO_PROMOTION_SESSION__=${JSON.stringify({ sessionToken: runtime.api.sessionToken })};window.__REMO_CANDIDATE_FIXTURE_LABEL__=${JSON.stringify(FIXTURE_LABEL)};window.__REMO_DECISION_ENTRY_REQUIRED__=${JSON.stringify(options.seedDecisionFixtureTurn4 === true)};</script>`
        : normalizedDetailProjection === undefined ? `<script nonce="${nonce}">${routeBootstrapValue}${replayRuntimeBootstrapValue}${comparisonSessionValue}</script>` : `<script nonce="${nonce}">${routeBootstrapValue}${replayRuntimeBootstrapValue}window.__REMO_SAVE_POINT__=${JSON.stringify(normalizedDetailProjection).replaceAll("<", "\\u003c")};window.__REMO_SAVE_POINT_SESSION__=${JSON.stringify({ sessionToken: savePointApi.sessionToken })};</script>`;
      bytes = Buffer.from(bytes.toString("utf8").replace("<head>", `<head>${bootstrap}`));
    }
    const mime = ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": mime, "cache-control": "no-store", ...staticSecurityHeaders(nonce) }).end(bytes);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  return { origin, replayRuntime: replayRuntime.availability, close };
  } catch (error) {
    await settleLocalApplicationResources(startupCleanups, { error });
    throw error;
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const projectRoot = argument("--project-root");
  const port = Number(argument("--port") ?? "4175");
  if (projectRoot === undefined) throw new Error("--project-root is required");
  const application = await startLocalApplication({ projectRoot, port });
  process.stdout.write(`${JSON.stringify({ event: "remo.fixture.ready", origin: application.origin, fixture: "vs001-approved-binding-fixture" })}\n`);
  const shutdown = (): void => { void application.close().then(() => { process.stdout.write(`${JSON.stringify({ event: "remo.fixture.stopped" })}\n`); process.exitCode = 0; }); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
