import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const command = process.platform === "win32" ? process.execPath : pnpm;
const commandPrefix = process.platform === "win32"
  ? [resolve(dirname(process.execPath), "node_modules/corepack/dist/pnpm.js")]
  : [];
const serial = ["--maxWorkers=1", "--no-file-parallelism"];

const checks = [
  {
    evidenceId: "fixture-preflight",
    profiles: ["full"],
    evidenceKind: "fixture-contract",
    covers: ["fixture preflight", "boundary identity", "selectors", "canary", "viewports", "allowlists"],
    args: ["--dir", "apps/service", "exec", "vitest", "run", "src/boundaries/preflight.test.ts", ...serial],
  },
  {
    evidenceId: "privacy-canary",
    profiles: ["full"],
    evidenceKind: "live-local-browser",
    covers: ["canary inventory", "quarantine", "redaction gate", "derived visual masking"],
    args: ["verify:privacy-fixture"],
  },
  {
    evidenceId: "three-and-ten-turn-sequence",
    profiles: ["full"],
    evidenceKind: "live-local-with-approved-contract-fake-trace",
    covers: ["distinct 3-turn smoke", "full 10-turn sequence", "duplicate retry", "failure isolation", "quarantine isolation", "delete isolation", "reverse digest"],
    args: ["--dir", "apps/service", "exec", "vitest", "run", "src/acceptance-sequence/ten-save-sequence.test.ts", ...serial],
  },
  {
    evidenceId: "trace-mismatch-and-outage",
    profiles: ["full"],
    evidenceKind: "live-local-with-approved-contract-fake-trace",
    covers: ["mismatched trace", "unavailable trace", "same-identity reconciliation", "safe local evidence"],
    args: ["--dir", "apps/service", "exec", "vitest", "run", "src/save-points/durable-local-application.test.ts", ...serial],
  },
  {
    evidenceId: "lifecycle-export-delete",
    profiles: ["full"],
    evidenceKind: "live-local-with-approved-contract-fake-trace",
    covers: ["export", "quarantine", "redaction", "verified deletion", "shutdown"],
    args: ["--dir", "apps/service", "exec", "vitest", "run", "src/promotion/local-application.acceptance.test.ts", ...serial],
  },
  {
    evidenceId: "support-diagnostics",
    profiles: ["full"],
    evidenceKind: "live-local",
    covers: ["database", "manifests", "blobs", "staging", "permissions", "adapter reachability", "payload-neutral JSONL", "read-only target"],
    args: ["--dir", "apps/service", "exec", "vitest", "run", "src/support/support-command.test.ts", ...serial],
  },
  {
    evidenceId: "web-accessibility-components",
    profiles: ["full"],
    evidenceKind: "component",
    covers: ["keyboard", "focus", "live regions", "honest failure states", "dead control regression"],
    args: ["--filter", "@remo/web", "exec", "vitest", "run", ...serial],
  },
  {
    evidenceId: "ten-save-browser",
    profiles: ["e2e", "full"],
    evidenceKind: "live-local-with-approved-contract-fake-trace",
    covers: ["saved-results collection", "stable detail route", "desktop", "360px responsive", "prohibited scope"],
    args: ["--dir", "apps/service", "exec", "vitest", "run", "src/acceptance-sequence/ten-save.e2e.test.ts", ...serial],
  },
  {
    evidenceId: "t9-actual-ui",
    profiles: ["e2e", "full"],
    evidenceKind: "live-local-with-approved-contract-fake-trace",
    covers: ["boundary", "candidate", "durable detail", "lifecycle", "saved results", "keyboard", "focus", "live regions", "360px", "390px", "canary inventory", "scope routes", "shutdown"],
    env: { REMO_T9_ACTUAL_UI: "1" },
    args: ["--dir", "apps/service", "exec", "vitest", "run", "src/support/actual-ui.e2e.test.ts", ...serial],
  },
];

const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex < 0 ? "full" : process.argv[profileIndex + 1];
if (profile !== "e2e" && profile !== "full") throw new TypeError("--profile must be e2e or full");

const selected = checks.filter(({ profiles }) => profiles.includes(profile));
const evidence = [];
let failed = false;
for (const check of selected) {
  const started = performance.now();
  process.stdout.write(`${JSON.stringify({ eventId: `vs001.acceptance.${check.evidenceId}.started`, evidenceId: check.evidenceId, evidenceKind: check.evidenceKind, covers: check.covers, result: "started" })}\n`);
  const outcome = spawnSync(command, [...commandPrefix, ...check.args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...check.env },
    stdio: "pipe",
    windowsHide: true,
    timeout: 900_000,
  });
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  if (outcome.error) process.stderr.write(`${outcome.error.message}\n`);
  const exitCode = outcome.status ?? 1;
  const observationMs = Math.round(performance.now() - started);
  const result = exitCode === 0 ? "pass" : "fail";
  evidence.push({ evidenceId: check.evidenceId, evidenceKind: check.evidenceKind, command: [pnpm, ...check.args].join(" "), exitCode, observationMs, result });
  process.stdout.write(`${JSON.stringify({ eventId: `vs001.acceptance.${check.evidenceId}.finished`, evidenceId: check.evidenceId, exitCode, observationMs, result })}\n`);
  if (exitCode !== 0) { failed = true; break; }
}
process.stdout.write(`${JSON.stringify({ eventId: "vs001.acceptance.finished", profile, evidence, result: failed ? "fail" : "pass", productionGuarantee: false })}\n`);
process.exitCode = failed ? 1 : 0;
