/* global console, process */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runControlledComparisonWarmUpDiagnostic } from "./verify-t6-performance.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const requireService = createRequire(resolve(repositoryRoot, "apps/service/package.json"));
const { chromium } = requireService("playwright");

const result = await runControlledComparisonWarmUpDiagnostic({ chromium, repositoryRoot });
console.log(JSON.stringify(result, null, 2));
if (result.verdict !== "PASS") process.exitCode = 1;
