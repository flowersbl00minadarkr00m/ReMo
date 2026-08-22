import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";
import { chromium } from "playwright";
import type { CorrelationTuple, EvidenceDescriptor, MeaningfulChangeCategory, NominationResult, SourceChange } from "@remo/domain";
import { createContractLangfuseFake, type TraceLookupResult } from "@remo/evidence-langfuse";
import { createVerificationRunner, type VerificationEvidence } from "@remo/evidence-verification";
import { LocalSavePointRepository, type CurrentDurableSavePoint } from "@remo/storage-local";
import { createCandidateReview, confirmCandidateIntent, discardCandidateReview, type CandidateReviewRecord } from "../candidates/candidate-service.js";
import { createCaptureFinalizationService, createInMemoryCaptureRepository } from "../capture-finalization/index.js";
import { createPromotionHandler } from "../promotion/promotion-handler.js";
import { startLocalApplication } from "../promotion/local-application.js";
import { createPromotionService } from "../promotion/promotion-service.js";
import { collectVerificationEvidence } from "../save-points/verification-evidence.js";

const execFileAsync = promisify(execFile);
const POLICY_REVISION = "remo.privacy.v1";
const SOURCE_ROOT = "packages/test-fixtures/vs001-ui/src";
const POPULATED_FIXTURE_SELECTOR = '[data-remo-fixture-root="vs002-replay-fixture-v1"]';
type PrivacyCaptureResult = Parameters<typeof createCandidateReview>[0]["privacyCapture"];

interface PrivacyCapturePolicy {
  readonly allowedOrigin: string;
  readonly allowedPath: string;
  readonly captureRoot: string;
  readonly maskSelectors: readonly string[];
  readonly blockSelectors: readonly string[];
  readonly forbiddenFields: readonly string[];
  readonly canary: string;
  readonly maskColor: `#${string}`;
}

interface VersionedScenario {
  readonly turn: number;
  readonly name: string;
  readonly requiredCategories: readonly MeaningfulChangeCategory[];
  readonly forward: readonly SourceChange[];
  readonly inverse: readonly SourceChange[];
}

interface ScenarioReport {
  readonly version: string;
  readonly baseDigest: string;
  readonly finalDigest: string;
  readonly reverseDigest: string;
  readonly scenarios: readonly { readonly turn: number; readonly name: string; readonly categories: readonly string[]; readonly forwardDigest: string }[];
}

interface ObservedTurnEvidence {
  readonly turnId: string;
  readonly sourceCommit: string;
  readonly evidence: readonly EvidenceDescriptor[];
}

interface SmokeReport {
  readonly turnsAttempted: number;
  readonly candidatesRegistered: number;
  readonly confirmationBindingsObserved: number;
  readonly missingConfirmationRejections: number;
  readonly falseConfirmationRejections: number;
  readonly validPromotionsObserved: number;
  readonly durableRowsObserved: number;
  readonly evidence: readonly ObservedTurnEvidence[];
}

export interface SavedResultSummary {
  readonly savePointId: string;
  readonly displayId: string;
  readonly turnId: string;
  readonly turnNumber: number;
  readonly stablePath: string;
  readonly savedAt: string;
  readonly integrity: "Complete" | "Incomplete" | "Quarantined";
  readonly fidelity: "Editable eligible" | "Degraded";
  readonly pinned: boolean;
  readonly expiresAt: string;
}

export interface TenSaveReport {
  readonly scenario: ScenarioReport;
  readonly projectRoot: string;
  readonly smokeTurns: number;
  readonly durableCount: number;
  readonly distinctSavePointIds: number;
  readonly distinctTurnIds: number;
  readonly retryCountAfter: number;
  readonly retryIdentityStable: boolean;
  readonly missingConfirmationRejected: boolean;
  readonly falseConfirmationRejected: boolean;
  readonly validConfirmationSucceededOnce: boolean;
  readonly failedTurnIsolated: boolean;
  readonly discardedTurnIsolated: boolean;
  readonly conflictingRetryRejected: boolean;
  readonly quarantineIsolated: boolean;
  readonly quarantineEnumerated: boolean;
  readonly deletionIsolated: boolean;
  readonly remainingAfterDeletion: number;
  readonly removedDetailAbsent: boolean;
  readonly unaffectedUnrenumbered: boolean;
  readonly firstAndTenthPolicyEqual: boolean;
  readonly sqliteRowsObserved: number;
  readonly casBlobsObserved: boolean;
  readonly apiRowsObserved: number;
  readonly apiStateObserved: boolean;
  readonly smoke: SmokeReport;
  readonly promotionEvidence: readonly ObservedTurnEvidence[];
  readonly summaries: readonly SavedResultSummary[];
  dispose(): Promise<void>;
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function descriptor(input: Omit<EvidenceDescriptor, "policyRevision">): EvidenceDescriptor {
  return { ...input, policyRevision: POLICY_REVISION };
}

function identities(turn: number, kind: "normal" | "discard" = "normal"): { readonly turnId: string; readonly savePointId: string } {
  const suffix = kind === "discard" ? "D1" : String(turn).padStart(2, "0");
  return { turnId: `01J00000000000000000000T${suffix}`, savePointId: `01J00000000000000000000S${suffix}` };
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

async function createFixtureRepository(projectRoot: string, prefix: string): Promise<{ readonly root: string; readonly baseCommit: string; readonly fixtureRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const sourceFixture = resolve(projectRoot, "packages/test-fixtures/vs001-ui");
  const fixtureRoot = resolve(root, "packages/test-fixtures/vs001-ui");
  await mkdir(dirname(fixtureRoot), { recursive: true });
  await cp(resolve(projectRoot, "tsconfig.base.json"), resolve(root, "tsconfig.base.json"));
  await cp(sourceFixture, fixtureRoot, { recursive: true, filter: (path) => !/[\\/](?:node_modules|dist)(?:[\\/]|$)/u.test(path) });
  const sourceModules = resolve(sourceFixture, "node_modules");
  await access(sourceModules);
  await symlink(resolve(projectRoot, "node_modules"), resolve(root, "node_modules"), "junction");
  await symlink(sourceModules, resolve(fixtureRoot, "node_modules"), "junction");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "remo-fixture@example.invalid"]);
  await git(root, ["config", "user.name", "ReMo fixture"]);
  await writeFile(resolve(root, ".git/info/exclude"), [
    ".remo/",
    "acceptance-api-web/",
    "node_modules/",
    "packages/test-fixtures/vs001-ui/dist/",
    "packages/test-fixtures/vs001-ui/node_modules/",
    "",
  ].join("\n"), "utf8");
  await git(root, ["add", "--", "packages/test-fixtures/vs001-ui"]);
  await git(root, ["commit", "-m", "fixture: establish acceptance baseline"]);
  return { root, fixtureRoot, baseCommit: await git(root, ["rev-parse", "HEAD"]) };
}

async function startFixtureServer(fixtureRoot: string): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const port = 4173;
  const origin = `http://127.0.0.1:${port}`;
  const executable = process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "pnpm";
  const buildArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm exec vite build"]
    : ["exec", "vite", "build"];
  await execFileAsync(executable, buildArgs, { cwd: fixtureRoot, env: { ...process.env, NO_COLOR: "1" }, windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`]
    : ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
  const child: ChildProcess = spawn(executable, args, { cwd: fixtureRoot, env: { ...process.env, NO_COLOR: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited ${child.exitCode}.\n${output}`);
    try {
      const response = await fetch(`${origin}/fixture/save-point`);
      if (response.ok) break;
    } catch { /* retry until bounded deadline */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (Date.now() >= deadline) throw new Error(`Fixture server did not become ready.\n${output}`);
  const warmupBrowser = await chromium.launch({ headless: true });
  try {
    const warmupPage = await warmupBrowser.newPage();
    await warmupPage.goto(`${origin}/fixture/save-point`, { waitUntil: "domcontentloaded" });
    await warmupPage.locator(POPULATED_FIXTURE_SELECTOR).waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await warmupBrowser.close();
  }
  return {
    origin,
    async close() {
      if (child.exitCode === null && process.platform === "win32" && child.pid !== undefined) {
        await execFileAsync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
      } else if (child.exitCode === null) child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
    },
  };
}

async function applyChanges(root: string, changes: readonly SourceChange[]): Promise<void> {
  for (const change of changes) {
    const path = resolve(root, change.path);
    let actual = "";
    try { actual = await readFile(path, "utf8"); } catch { /* absent is the declared empty preimage */ }
    if (actual !== change.before) throw new Error(`Actual fixture patch preimage mismatch for ${change.path}.`);
    if (change.after === "") await rm(path, { force: true });
    else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, change.after, "utf8"); }
    await git(root, ["add", "--", change.path]);
  }
}

function privacyPolicy(origin: string, quarantined = false): PrivacyCapturePolicy {
  return {
    allowedOrigin: origin,
    allowedPath: "/fixture/save-point",
    captureRoot: "[data-remo-fixture-root]",
    maskSelectors: quarantined ? ["input", "textarea"] : ["[data-remo-sensitive]", "input", "textarea"],
    blockSelectors: ["[data-remo-block]"],
    forbiddenFields: ["clipboardData", "dataTransfer", "files", "rawKey"],
    canary: "REMO_SECRET_CANARY_V1",
    maskColor: "#7138d8",
  };
}

async function waitForStablePopulatedFixture(page: import("playwright").Page): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.locator(POPULATED_FIXTURE_SELECTOR).waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
    try {
      const stable = await page.evaluate(async (selector) => {
        const fixtureWindow = window as Window & { __REMO_FIXTURE_DOCUMENT_ID__?: string };
        fixtureWindow.__REMO_FIXTURE_DOCUMENT_ID__ ??= crypto.randomUUID();
        const documentId = fixtureWindow.__REMO_FIXTURE_DOCUMENT_ID__;
        const root = document.querySelector(selector);
        if (!(root instanceof HTMLElement)) return false;
        const initialText = root.textContent;
        let mutated = false;
        const observer = new MutationObserver(() => { mutated = true; });
        observer.observe(root, { attributes: true, childList: true, characterData: true, subtree: true });
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        observer.disconnect();
        const current = document.querySelector(selector);
        const heading = current?.querySelector("h1");
        return !mutated
          && current === root
          && root.isConnected
          && root.textContent === initialText
          && heading?.textContent === "Save point evidence"
          && document.styleSheets.length > 0
          && getComputedStyle(root).display !== "none"
          && fixtureWindow.__REMO_FIXTURE_DOCUMENT_ID__ === documentId;
      }, POPULATED_FIXTURE_SELECTOR);
      if (stable) {
        const stillStable = await page.evaluate((selector) => {
          const root = document.querySelector(selector);
          return root instanceof HTMLElement
            && root.isConnected
            && root.querySelector("h1")?.textContent === "Save point evidence"
            && document.styleSheets.length > 0;
        }, POPULATED_FIXTURE_SELECTOR);
        if (stillStable) return;
      }
    } catch { /* a replaced document retries against its new identity */ }
  }
  throw new Error("The populated fixture did not hold one styled document identity for the capture stability window.");
}

async function capturePrivacy(origin: string, checkedAt: string, quarantined = false, viewport: { readonly width: number; readonly height: number } = { width: 1440, height: 900 }): Promise<{ readonly result: PrivacyCaptureResult; readonly browserVersion: string }> {
  const modulePath = resolve(import.meta.dirname, "../../../../packages/capture-playwright/src/privacy/privacy-capture.ts");
  const capture = await import(pathToFileURL(modulePath).href) as {
    preparePrivacyRecorder(context: import("playwright").BrowserContext, policy: PrivacyCapturePolicy): Promise<void>;
    startPrivacyRecording(page: import("playwright").Page, policy: PrivacyCapturePolicy): Promise<void>;
    collectPrivacyClearedEvidence(input: { readonly page: import("playwright").Page; readonly policy: PrivacyCapturePolicy; readonly checkedAt: string }): Promise<PrivacyCaptureResult>;
  };
  const policy = privacyPolicy(origin, quarantined);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  try {
    await capture.preparePrivacyRecorder(context, policy);
    // tsx preserves its function-name helper when Playwright serializes the
    // recorder callbacks; provide the inert browser-side equivalent.
    await context.addInitScript({ content: "globalThis.__name = (target) => target;" });
    const page = await context.newPage();
    await page.goto(`${origin}/fixture/save-point`, { waitUntil: "networkidle" });
    await waitForStablePopulatedFixture(page);
    await capture.startPrivacyRecording(page, policy);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(80);
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(80);
    return { result: await capture.collectPrivacyClearedEvidence({ page, policy, checkedAt }), browserVersion: browser.version() };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function verificationEvidence(input: { readonly fixtureRoot: string; readonly fixtureId: string; readonly correlation: CorrelationTuple; readonly capturedAt: string }): Promise<{ readonly descriptor: EvidenceDescriptor; readonly result: VerificationEvidence }> {
  const commandId = "fixture.typecheck";
  const runner = createVerificationRunner([{
    id: commandId,
    executable: process.execPath,
    args: [resolve(input.fixtureRoot, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", resolve(input.fixtureRoot, "tsconfig.json")],
    cwd: input.fixtureRoot,
    timeoutMs: 60_000,
    maxOutputBytes: 1024 * 1024,
  }]);
  let result: VerificationEvidence | undefined;
  const descriptor = await collectVerificationEvidence({
    async run(id) {
      result = await runner.run(id);
      return result;
    },
  }, { commandId, fixtureId: input.fixtureId, correlation: input.correlation, capturedAt: input.capturedAt, policyRevision: POLICY_REVISION });
  if (result === undefined) throw new Error("Fixture verification returned no authority result.");
  return { descriptor, result };
}

export function traceEvidenceFromAuthority(input: {
  readonly correlation: CorrelationTuple;
  readonly capturedAt: string;
  readonly traceId?: string;
  readonly result?: TraceLookupResult;
  readonly requests?: readonly { readonly traceId: string; readonly expectedTurnId: string }[];
}): EvidenceDescriptor {
  const base = { componentId: `${input.correlation.turnId}:trace`, componentType: "trace" as const, authority: "langfuse" as const, correlation: input.correlation, capturedAt: input.capturedAt, provenance: "unknown" as const };
  if (input.traceId === undefined || input.result === undefined) return descriptor({ ...base, availability: "missing" });
  const authorityReceipt = { mode: "approved-contract-fake", traceId: input.traceId, result: input.result, requests: input.requests ?? [] };
  if (input.result.status !== "matching" || input.result.metadataTurnId !== input.correlation.turnId) {
    return descriptor({ ...base, digest: digestJson(authorityReceipt), externalId: input.traceId, availability: input.result.status === "unreachable" ? "unreachable" : "rejected" });
  }
  return descriptor({ ...base, digest: digestJson(authorityReceipt), externalId: input.traceId, availability: "available" });
}

async function contractTraceEvidence(correlation: CorrelationTuple, capturedAt: string): Promise<EvidenceDescriptor> {
  const traceId = randomBytes(16).toString("hex");
  const lookup = createContractLangfuseFake({
    [traceId]: { status: "matching", metadataTurnId: correlation.turnId, validatedAt: capturedAt },
  });
  const result = await lookup.lookup({ traceId, expectedTurnId: correlation.turnId });
  const requests = lookup.requests();
  if (requests.length !== 1 || requests[0]?.traceId !== traceId) return traceEvidenceFromAuthority({ correlation, capturedAt });
  return traceEvidenceFromAuthority({ correlation, capturedAt, traceId, result, requests });
}

async function candidateFor(input: {
  readonly turn: number;
  readonly scenario: VersionedScenario;
  readonly fixtureRoot: string;
  readonly projectRoot: string;
  readonly parentCommit: string;
  readonly sourceCommit: string;
  readonly sourceSnapshot: { readonly head: string; readonly status: string; readonly diff: string; readonly fileHashes: Readonly<Record<string, string>>; readonly snapshotDigest: string };
  readonly createdAt: string;
  readonly nomination: NominationResult;
  readonly privacy: PrivacyCaptureResult;
  readonly browserVersion: string;
  readonly kind?: "normal" | "discard";
}): Promise<CandidateReviewRecord> {
  const { turnId, savePointId } = identities(input.turn, input.kind);
  const correlation: CorrelationTuple = { projectId: "remo", turnId, captureWindowId: `window-${String(input.turn).padStart(2, "0")}`, boundaryRevision: "boundary-v1" };
  const fixtureId = `vs001-sequence:${input.turn}:${input.scenario.name}`;
  const verification = await verificationEvidence({ fixtureRoot: input.fixtureRoot, fixtureId, correlation, capturedAt: input.createdAt });
  const packageBytes = await readFile(resolve(input.projectRoot, "packages/test-fixtures/vs001-ui/package.json"));
  const lockfileBytes = await readFile(resolve(input.projectRoot, "pnpm-lock.yaml"));
  const boundaries = input.nomination.status === "candidate" ? input.nomination.boundaries : [];
  const evidence: EvidenceDescriptor[] = [
    descriptor({ componentId: `${turnId}:source`, componentType: "source", authority: "git", correlation, capturedAt: input.createdAt, digest: digestJson({ sourceSnapshot: input.sourceSnapshot, sourceCommit: input.sourceCommit }), externalId: input.sourceCommit, availability: "available", provenance: "observed", claims: { sourceState: input.sourceCommit, fixtureId } }),
    descriptor({ componentId: `${turnId}:rrweb`, componentType: "rrweb", authority: "rrweb", correlation, capturedAt: input.createdAt, ...(input.privacy.status === "passed" ? { digest: input.privacy.evidence.receipt.rrwebDigest, availability: "available" as const, provenance: "observed" as const } : { availability: "rejected" as const, provenance: "unknown" as const }) }),
    descriptor({ componentId: `${turnId}:screenshot`, componentType: "screenshot", authority: "remo", correlation, capturedAt: input.createdAt, ...(input.privacy.status === "passed" ? { digest: input.privacy.evidence.receipt.screenshotDigest, availability: "available" as const, provenance: "observed" as const } : { availability: "rejected" as const, provenance: "unknown" as const }) }),
    await contractTraceEvidence(correlation, input.createdAt),
    descriptor({ componentId: `${turnId}:decision`, componentType: "decision", authority: "fixture", correlation, capturedAt: input.createdAt, ...(boundaries.length > 0 ? { digest: digestJson({ fixtureId, boundaries }), availability: "available" as const, provenance: "user-supplied" as const, claims: { fixtureId } } : { availability: "missing" as const, provenance: "unknown" as const }) }),
    verification.descriptor,
    descriptor({ componentId: `${turnId}:dependencies`, componentType: "dependencies", authority: "fixture", correlation, capturedAt: input.createdAt, digest: digestJson({ fixturePackageDigest: sha256(packageBytes), lockfileDigest: sha256(lockfileBytes), browserVersion: input.browserVersion }), availability: "available", provenance: "observed", claims: { fixtureId } }),
    descriptor({ componentId: `${turnId}:lineage`, componentType: "lineage", authority: "git", correlation, capturedAt: input.createdAt, digest: digestJson({ parentCommit: input.parentCommit, sourceCommit: input.sourceCommit }), availability: "available", provenance: "observed", claims: { sourceState: input.sourceCommit } }),
  ];
  return createCandidateReview({
    finalization: { schemaVersion: "remo.bundle.v1", identityVersion: "ulid-v1", policyRevision: POLICY_REVISION, savePointId, correlation, evidence },
    nomination: input.nomination,
    privacyCapture: input.privacy,
    createdAt: input.createdAt,
  });
}

async function scenarioSources(projectRoot: string): Promise<{ readonly scenarios: readonly VersionedScenario[]; readonly report: ScenarioReport }> {
  const scenarioPath = resolve(projectRoot, "packages/test-fixtures/vs001-ui/scenarios/v1/scenarios.mjs");
  const harnessPath = resolve(projectRoot, "packages/test-fixtures/vs001-ui/scenarios/v1/scenario-harness.mjs");
  const scenarioModule = await import(pathToFileURL(scenarioPath).href) as { readonly VS001_SCENARIOS: readonly VersionedScenario[] };
  const harness = await import(pathToFileURL(harnessPath).href) as { verifyScenarioSequence(root: string): Promise<ScenarioReport> };
  return { scenarios: scenarioModule.VS001_SCENARIOS, report: await harness.verifyScenarioSequence(projectRoot) };
}

async function controlledTurn(config: {
  readonly turnId: string;
  readonly repositoryRoot: string;
  readonly allowedSourceRoot: string;
  readonly startedAt: string;
  readonly capture: { readonly origin: string; readonly path: string; readonly captureRoot: string; readonly launchOptions: { readonly headless: boolean } };
}): Promise<{ stop(boundaries: readonly { readonly kind: "decision" | "human-intervention" | "verification"; readonly boundaryId: string; readonly occurredAt: string }[]): Promise<NominationResult> }> {
  const modulePath = resolve(import.meta.dirname, "../../../../packages/capture-playwright/src/controlled-turn.ts");
  const capture = await import(pathToFileURL(modulePath).href) as { startControlledTurn(value: typeof config): Promise<{ stop(boundaries: readonly { readonly kind: "decision" | "human-intervention" | "verification"; readonly boundaryId: string; readonly occurredAt: string }[]): Promise<NominationResult> }> };
  return capture.startControlledTurn(config);
}

async function captureSourceSnapshot(root: string): Promise<{ readonly head: string; readonly status: string; readonly diff: string; readonly fileHashes: Readonly<Record<string, string>>; readonly snapshotDigest: string }> {
  const modulePath = resolve(import.meta.dirname, "../../../../packages/evidence-git/src/index.ts");
  const evidenceGit = await import(pathToFileURL(modulePath).href) as {
    captureGitSnapshot(input: { readonly repositoryRoot: string; readonly allowedSourceRoot: string }): Promise<{ readonly head: string; readonly status: string; readonly diff: string; readonly fileHashes: Readonly<Record<string, string>>; readonly snapshotDigest: string }>;
  };
  return evidenceGit.captureGitSnapshot({ repositoryRoot: root, allowedSourceRoot: SOURCE_ROOT });
}

function registerCandidate(repository: LocalSavePointRepository, record: Extract<CandidateReviewRecord, { status: "reviewable" }>, operationId: string): void {
  repository.registerCandidate({
    operationId,
    turnId: record.finalization.correlation.turnId,
    savePointId: record.finalization.savePointId,
    revision: 1,
    manifestDigest: record.manifestDigest,
    createdAt: record.createdAt,
    policyRevision: POLICY_REVISION,
    manifest: record.evaluated.manifest,
    blobs: [
      { role: "rrweb", bytes: record.safeEvidence.rrwebBytes, expectedDigest: record.safeEvidence.receipt.rrwebDigest },
      { role: "screenshot", bytes: record.safeEvidence.screenshotBytes, expectedDigest: record.safeEvidence.receipt.screenshotDigest },
    ],
  });
}

function confirmationBody(intent: Extract<ReturnType<typeof confirmCandidateIntent>, { status: "ready-for-durable-promotion" }>): { readonly confirm: true; readonly savePointId: string; readonly candidateRevision: number; readonly candidateManifestDigest: string } {
  return { confirm: true, savePointId: intent.savePointId, candidateRevision: intent.candidateRevision, candidateManifestDigest: intent.candidateManifestDigest };
}

async function runSmoke(projectRoot: string, scenarios: readonly VersionedScenario[]): Promise<SmokeReport> {
  const fixture = await createFixtureRepository(projectRoot, "remo-t8-smoke-");
  const server = await startFixtureServer(fixture.fixtureRoot);
  const repository = new LocalSavePointRepository({ projectRoot: fixture.root });
  const candidates = new Map<string, CandidateReviewRecord>();
  const promotion = createPromotionService(repository);
  const handler = createPromotionHandler({ findCandidate: (turnId) => candidates.get(turnId), promote: (record, intent) => promotion.promote(record, intent) });
  const finalization = createCaptureFinalizationService(createInMemoryCaptureRepository());
  const evidence: ObservedTurnEvidence[] = [];
  let candidatesRegistered = 0;
  let confirmationBindingsObserved = 0;
  let missingConfirmationRejections = 0;
  let falseConfirmationRejections = 0;
  let validPromotionsObserved = 0;
  try {
    for (const scenario of scenarios.slice(0, 3)) {
      const createdAt = new Date(Date.parse("2026-08-16T07:00:00.000Z") + scenario.turn * 60_000).toISOString();
      const parentCommit = await git(fixture.root, ["rev-parse", "HEAD"]);
      const controlled = await controlledTurn({ turnId: identities(scenario.turn).turnId, repositoryRoot: fixture.root, allowedSourceRoot: SOURCE_ROOT, startedAt: createdAt, capture: { origin: server.origin, path: "/fixture/save-point", captureRoot: "[data-remo-fixture-root]", launchOptions: { headless: true } } });
      await applyChanges(fixture.root, scenario.forward);
      const privacyCapture = await capturePrivacy(server.origin, createdAt);
      const nomination = await controlled.stop([{ kind: "verification", boundaryId: `smoke-${scenario.turn}`, occurredAt: createdAt }]);
      if (nomination.status !== "candidate" || privacyCapture.result.status !== "passed") throw new Error(`Three-turn smoke failed at turn ${scenario.turn}.`);
      const sourceSnapshot = await captureSourceSnapshot(fixture.root);
      await git(fixture.root, ["commit", "-m", `smoke: apply scenario ${scenario.turn}`]);
      const sourceCommit = await git(fixture.root, ["rev-parse", "HEAD"]);
      const record = await candidateFor({ turn: scenario.turn, scenario, fixtureRoot: fixture.fixtureRoot, projectRoot, parentCommit, sourceCommit, sourceSnapshot, createdAt, nomination, privacy: privacyCapture.result, browserVersion: privacyCapture.browserVersion });
      if (record.status !== "reviewable" || !finalization.finalize(record.finalization).promotionAllowed) throw new Error(`Three-turn smoke finalization failed at turn ${scenario.turn}.`);
      const ids = identities(scenario.turn);
      candidates.set(ids.turnId, record);
      registerCandidate(repository, record, `smoke-candidate-${scenario.turn}`);
      if (repository.getCandidateLifecycle(ids.turnId) !== undefined) candidatesRegistered += 1;
      const intent = confirmCandidateIntent(record);
      if (intent.status !== "ready-for-durable-promotion") throw new Error(`Smoke turn ${scenario.turn} did not expose an explicit confirmation binding.`);
      confirmationBindingsObserved += 1;
      const body = confirmationBody(intent);
      const missing = await handler(ids.turnId, {});
      const falsy = await handler(ids.turnId, { ...body, confirm: false });
      if (missing.status === 400 && "code" in missing.body && missing.body.code === "promotion.confirmation-required") missingConfirmationRejections += 1;
      if (falsy.status === 400 && "code" in falsy.body && falsy.body.code === "promotion.confirmation-required") falseConfirmationRejections += 1;
      const promoted = await handler(ids.turnId, body);
      if (promoted.status !== 200 || promoted.body.status !== "durable" || promoted.body.savePointId !== ids.savePointId) throw new Error(`Smoke turn ${scenario.turn} failed explicit-confirmation promotion.`);
      validPromotionsObserved += 1;
      evidence.push({ turnId: ids.turnId, sourceCommit, evidence: record.finalization.evidence });
    }
    for (const scenario of [...scenarios.slice(0, 3)].reverse()) await applyChanges(fixture.root, scenario.inverse);
    await git(fixture.root, ["diff", "--quiet", fixture.baseCommit, "--", SOURCE_ROOT]);
    const report = { turnsAttempted: 3, candidatesRegistered, confirmationBindingsObserved, missingConfirmationRejections, falseConfirmationRejections, validPromotionsObserved, durableRowsObserved: repository.listCurrentDurable().length, evidence };
    if (Object.values(report).some((value) => typeof value === "number" && value !== 3)) throw new Error("Every smoke turn must register, bind, reject missing/false confirmation, and promote through the supported handler.");
    return report;
  } finally {
    repository.close();
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function summary(current: CurrentDurableSavePoint): SavedResultSummary {
  const bundle = current.bundle as { readonly evidence?: readonly EvidenceDescriptor[] };
  const fixtureId = bundle.evidence?.find(({ componentType }) => componentType === "source")?.claims?.fixtureId;
  const sequenceNo = Number(/^vs001-sequence:(\d+):/u.exec(fixtureId ?? "")?.[1]);
  if (!Number.isSafeInteger(sequenceNo) || sequenceNo < 1) throw new Error("Live durable row has no authoritative sequence number.");
  return {
    savePointId: current.receipt.savePointId,
    displayId: `SP-${String(sequenceNo).padStart(3, "0")}`,
    turnId: current.receipt.turnId,
    turnNumber: sequenceNo,
    stablePath: `/save-points/${encodeURIComponent(current.receipt.savePointId)}`,
    savedAt: current.receipt.promotedAt,
    integrity: current.lifecycle.state === "quarantined" ? "Quarantined" : current.receipt.health === "complete" ? "Complete" : "Incomplete",
    fidelity: current.receipt.fidelity === "editable-eligible" ? "Editable eligible" : "Degraded",
    pinned: current.lifecycle.pinned,
    expiresAt: current.lifecycle.expiresAt,
  };
}

function unchangedOthers(repository: LocalSavePointRepository, baseline: ReadonlyMap<string, string>, excluded: string): boolean {
  return [...baseline].every(([savePointId, digest]) => savePointId === excluded || repository.getCurrentRevision(savePointId)?.manifestDigest === digest);
}

async function inspectCas(repository: LocalSavePointRepository, rows: readonly CurrentDurableSavePoint[]): Promise<boolean> {
  for (const current of rows) {
    const bundle = current.bundle as { readonly evidence?: readonly EvidenceDescriptor[] };
    const blobs = bundle.evidence?.filter(({ componentType }) => componentType === "rrweb" || componentType === "screenshot") ?? [];
    if (blobs.length !== 2) return false;
    for (const component of blobs) {
      if (component.digest === undefined) return false;
      const bytes = await readFile(repository.blobPath(component.digest)).catch(() => undefined);
      if (bytes === undefined || sha256(bytes) !== component.digest) return false;
    }
  }
  return rows.length > 0;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("A free loopback port was not assigned.");
  server.close();
  await once(server, "close");
  return address.port;
}

async function inspectSupportedApi(input: { readonly projectRoot: string; readonly expected: readonly SavedResultSummary[]; readonly removedSavePointId: string; readonly now: Date }): Promise<{ readonly rows: number; readonly stateObserved: boolean; readonly removedDetailAbsent: boolean }> {
  const webRoot = resolve(input.projectRoot, "acceptance-api-web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(resolve(webRoot, "index.html"), "<!doctype html><title>ReMo acceptance API</title>", "utf8");
  const application = await startLocalApplication({ projectRoot: input.projectRoot, webRoot, port: await freePort(), now: () => input.now, seedImplementationFixture: false });
  try {
    const collection = await fetch(`${application.origin}/api/save-points`);
    const rows = collection.ok ? await collection.json() as unknown : undefined;
    const first = input.expected[0];
    const firstStatus = first === undefined ? 404 : (await fetch(`${application.origin}/api/save-points/${encodeURIComponent(first.savePointId)}`)).status;
    const removedStatus = (await fetch(`${application.origin}/api/save-points/${encodeURIComponent(input.removedSavePointId)}`)).status;
    const exactRows = Array.isArray(rows)
      && rows.length === input.expected.length
      && JSON.stringify(rows) === JSON.stringify(input.expected);
    return { rows: Array.isArray(rows) ? rows.length : 0, stateObserved: collection.status === 200 && firstStatus === 200 && exactRows, removedDetailAbsent: removedStatus === 404 };
  } finally {
    await application.close();
  }
}

export async function runTenSaveSequence(projectRoot = resolve(import.meta.dirname, "../../../.."), options: { readonly captureViewportByTurn?: Readonly<Record<number, { readonly width: number; readonly height: number }>> } = {}): Promise<TenSaveReport> {
  const source = await scenarioSources(projectRoot);
  if (source.scenarios.length !== 10 || source.report.reverseDigest !== source.report.baseDigest) throw new Error("Scenario contract is not an exact reversible ten-turn sequence.");
  const smoke = await runSmoke(projectRoot, source.scenarios);

  const fixture = await createFixtureRepository(projectRoot, "remo-t8-ten-save-");
  const server = await startFixtureServer(fixture.fixtureRoot);
  let clock = new Date("2026-08-16T08:00:00.000Z");
  const repository = new LocalSavePointRepository({ projectRoot: fixture.root, now: () => clock });
  const candidates = new Map<string, CandidateReviewRecord>();
  const promotion = createPromotionService(repository);
  const handler = createPromotionHandler({ findCandidate: (turnId) => candidates.get(turnId), promote: (record, intent) => promotion.promote(record, intent) });
  const finalization = createCaptureFinalizationService(createInMemoryCaptureRepository());
  const records: CandidateReviewRecord[] = [];
  const missingConfirmationRejected = smoke.missingConfirmationRejections === smoke.turnsAttempted;
  const falseConfirmationRejected = smoke.falseConfirmationRejections === smoke.turnsAttempted;
  let validConfirmationSucceededOnce = false;
  let retryIdentityStable = false;
  let retryCountAfter = 0;
  let conflictingRetryRejected = false;
  try {
    for (const scenario of source.scenarios) {
      clock = new Date(Date.parse("2026-08-16T08:00:00.000Z") + scenario.turn * 60_000);
      const createdAt = clock.toISOString();
      const ids = identities(scenario.turn);
      const parentCommit = await git(fixture.root, ["rev-parse", "HEAD"]);
      const controlled = await controlledTurn({ turnId: ids.turnId, repositoryRoot: fixture.root, allowedSourceRoot: SOURCE_ROOT, startedAt: createdAt, capture: { origin: server.origin, path: "/fixture/save-point", captureRoot: "[data-remo-fixture-root]", launchOptions: { headless: true }, ...(options.captureViewportByTurn?.[scenario.turn] === undefined ? {} : { viewport: options.captureViewportByTurn[scenario.turn] }) } });
      await applyChanges(fixture.root, scenario.forward);
      const privacyCapture = await capturePrivacy(server.origin, createdAt, false, options.captureViewportByTurn?.[scenario.turn]);
      const nomination = await controlled.stop([{ kind: "verification", boundaryId: `scenario-${String(scenario.turn).padStart(2, "0")}`, occurredAt: createdAt }]);
      if (nomination.status !== "candidate" || !scenario.requiredCategories.every((category) => nomination.categories.includes(category)) || privacyCapture.result.status !== "passed") throw new Error(`Turn ${scenario.turn} did not qualify through the real fixture/Git/browser capture path.`);
      const sourceSnapshot = await captureSourceSnapshot(fixture.root);
      await git(fixture.root, ["commit", "-m", `fixture: apply scenario ${scenario.turn}`]);
      const sourceCommit = await git(fixture.root, ["rev-parse", "HEAD"]);
      const record = await candidateFor({ turn: scenario.turn, scenario, fixtureRoot: fixture.fixtureRoot, projectRoot, parentCommit, sourceCommit, sourceSnapshot, createdAt, nomination, privacy: privacyCapture.result, browserVersion: privacyCapture.browserVersion });
      if (record.status !== "reviewable") throw new Error(`Turn ${scenario.turn} did not produce a reviewable privacy-cleared candidate.`);
      const finalized = finalization.finalize(record.finalization);
      if (!finalized.promotionAllowed || finalized.savePointId !== ids.savePointId) throw new Error(`Turn ${scenario.turn} failed current capture finalization.`);
      candidates.set(ids.turnId, record);
      records.push(record);
      registerCandidate(repository, record, `candidate-${scenario.turn}`);
      const intent = confirmCandidateIntent(record);
      if (intent.status !== "ready-for-durable-promotion") throw new Error(`Turn ${scenario.turn} did not expose an explicit confirmation binding.`);
      const body = confirmationBody(intent);
      const promoted = await handler(ids.turnId, body);
      if (promoted.status !== 200 || promoted.body.status !== "durable" || promoted.body.savePointId !== ids.savePointId) throw new Error(`Turn ${scenario.turn} failed explicit-confirmation promotion.`);
      if (scenario.turn === 5) {
        const retriedFinalization = finalization.finalize(record.finalization);
        const retriedPromotion = await handler(ids.turnId, body);
        const conflictingPromotion = await handler(ids.turnId, { ...body, savePointId: `${ids.savePointId}-conflict` });
        const countAfterRetryAtTurnFive = repository.countDurable();
        retryIdentityStable = retriedFinalization.savePointId === ids.savePointId && retriedPromotion.status === 200 && retriedPromotion.body.status === "durable" && retriedPromotion.body.savePointId === ids.savePointId && countAfterRetryAtTurnFive === 5;
        conflictingRetryRejected = conflictingPromotion.status === 409 && "code" in conflictingPromotion.body && conflictingPromotion.body.code === "promotion.candidate-binding-stale" && countAfterRetryAtTurnFive === 5;
      }
    }

    const baselineRows = repository.listCurrentDurable();
    const baseline = new Map(baselineRows.map(({ revision }) => [revision.savePointId, revision.manifestDigest]));
    retryCountAfter = repository.countDurable();
    const distinctSavePointIds = new Set(baselineRows.map(({ receipt }) => receipt.savePointId)).size;
    const distinctTurnIds = new Set(baselineRows.map(({ receipt }) => receipt.turnId)).size;
    validConfirmationSucceededOnce = baselineRows.length === 10 && distinctSavePointIds === 10 && baselineRows.every(({ receipt }) => repository.getDurable(receipt.turnId)?.savePointId === receipt.savePointId);
    const sqliteRowsObserved = baselineRows.length === repository.countDurable() ? baselineRows.length : 0;
    const casBlobsObserved = await inspectCas(repository, baselineRows);

    const failedControlled = await controlledTurn({ turnId: "01J00000000000000000000TF1", repositoryRoot: fixture.root, allowedSourceRoot: SOURCE_ROOT, startedAt: clock.toISOString(), capture: { origin: server.origin, path: "/fixture/save-point", captureRoot: "[data-remo-fixture-root]", launchOptions: { headless: true } } });
    const failedNomination = await failedControlled.stop([{ kind: "verification", boundaryId: "failed-no-change", occurredAt: clock.toISOString() }]);
    const failedTurnIsolated = failedNomination.status === "no-candidate" && unchangedOthers(repository, baseline, "") && repository.countDurable() === 10;

    const discardScenario = source.scenarios[9]!;
    const discardControlled = await controlledTurn({ turnId: identities(11, "discard").turnId, repositoryRoot: fixture.root, allowedSourceRoot: SOURCE_ROOT, startedAt: clock.toISOString(), capture: { origin: server.origin, path: "/fixture/save-point", captureRoot: "[data-remo-fixture-root]", launchOptions: { headless: true } } });
    await applyChanges(fixture.root, discardScenario.inverse);
    const discardPrivacyCapture = await capturePrivacy(server.origin, clock.toISOString());
    const discardNomination = await discardControlled.stop([{ kind: "human-intervention", boundaryId: "discard-candidate", occurredAt: clock.toISOString() }]);
    const discardSnapshot = await captureSourceSnapshot(fixture.root);
    const discardHead = await git(fixture.root, ["rev-parse", "HEAD"]);
    const discardRecord = await candidateFor({ turn: 11, scenario: discardScenario, fixtureRoot: fixture.fixtureRoot, projectRoot, parentCommit: discardHead, sourceCommit: discardHead, sourceSnapshot: discardSnapshot, createdAt: clock.toISOString(), nomination: discardNomination, privacy: discardPrivacyCapture.result, browserVersion: discardPrivacyCapture.browserVersion, kind: "discard" });
    const discarded = discardCandidateReview(discardRecord);
    await applyChanges(fixture.root, discardScenario.forward);
    await git(fixture.root, ["diff", "--quiet", "HEAD", "--", SOURCE_ROOT]);
    const discardedTurnIsolated = discarded.state === "discarded" && unchangedOthers(repository, baseline, "") && repository.countDurable() === 10;

    const lifecycleTarget = baselineRows[5]!;
    repository.quarantineDurable(lifecycleTarget.receipt.savePointId, "quarantine-turn-06");
    const quarantinedRows = repository.listCurrentDurable();
    const quarantineEnumerated = quarantinedRows.some(({ receipt, lifecycle }) => receipt.savePointId === lifecycleTarget.receipt.savePointId && lifecycle.state === "quarantined");
    const quarantineIsolated = unchangedOthers(repository, baseline, lifecycleTarget.receipt.savePointId) && repository.countDurable() === 10;
    repository.deleteDurable(lifecycleTarget.receipt.savePointId, "delete-turn-06");
    const remainingRows = repository.listCurrentDurable();
    const deletionIsolated = unchangedOthers(repository, baseline, lifecycleTarget.receipt.savePointId) && repository.countDurable() === 9;
    const summaries = remainingRows.map(summary);
    const unaffectedUnrenumbered = summaries.every((item) => item.turnNumber !== 6 && item.displayId === `SP-${String(item.turnNumber).padStart(3, "0")}` && identities(item.turnNumber).savePointId === item.savePointId && baseline.get(item.savePointId) === repository.getCurrentRevision(item.savePointId)?.manifestDigest);

    for (const scenario of [...source.scenarios].reverse()) await applyChanges(fixture.root, scenario.inverse);
    await git(fixture.root, ["diff", "--quiet", fixture.baseCommit, "--", SOURCE_ROOT]);
    const first = baselineRows[0]!.receipt;
    const tenth = baselineRows[9]!.receipt;
    const firstAndTenthPolicyEqual = records[0]!.status === "reviewable" && records[9]!.status === "reviewable" && records[0]!.finalization.policyRevision === records[9]!.finalization.policyRevision && first.health === tenth.health && first.fidelity === tenth.fidelity;
    const api = await inspectSupportedApi({ projectRoot: fixture.root, expected: summaries, removedSavePointId: lifecycleTarget.receipt.savePointId, now: clock });
    const promotionEvidence = records.flatMap((record) => record.status === "reviewable" ? [{ turnId: record.finalization.correlation.turnId, sourceCommit: record.finalization.evidence.find(({ componentType }) => componentType === "source")?.claims?.sourceState ?? "", evidence: record.finalization.evidence }] : []);
    const invariants = { missingConfirmationRejected, falseConfirmationRejected, validConfirmationSucceededOnce, retryIdentityStable, conflictingRetryRejected, failedTurnIsolated, discardedTurnIsolated, quarantineEnumerated, quarantineIsolated, deletionIsolated, unaffectedUnrenumbered, firstAndTenthPolicyEqual, casBlobsObserved, apiStateObserved: api.stateObserved, removedDetailAbsent: api.removedDetailAbsent };
    if (Object.values(invariants).some((passed) => !passed)) throw new Error(`Corrected ten-save acceptance invariants failed: ${JSON.stringify(invariants)}`);
    repository.close();
    await server.close();
    return {
      scenario: source.report,
      projectRoot: fixture.root,
      smokeTurns: smoke.turnsAttempted,
      durableCount: baselineRows.length,
      distinctSavePointIds,
      distinctTurnIds,
      retryCountAfter,
      retryIdentityStable,
      missingConfirmationRejected,
      falseConfirmationRejected,
      validConfirmationSucceededOnce,
      failedTurnIsolated,
      discardedTurnIsolated,
      conflictingRetryRejected,
      quarantineIsolated,
      quarantineEnumerated,
      deletionIsolated,
      remainingAfterDeletion: remainingRows.length,
      removedDetailAbsent: api.removedDetailAbsent,
      unaffectedUnrenumbered,
      firstAndTenthPolicyEqual,
      sqliteRowsObserved,
      casBlobsObserved,
      apiRowsObserved: api.rows,
      apiStateObserved: api.stateObserved,
      smoke,
      promotionEvidence,
      summaries,
      dispose: () => rm(fixture.root, { recursive: true, force: true }),
    };
  } catch (error) {
    repository.close();
    await server.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
    throw error;
  }
}
