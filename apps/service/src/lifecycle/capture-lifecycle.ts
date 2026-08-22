import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import { startLocalApplication } from "../promotion/local-application.js";

const savePointId = "01J000000000000000000000S5";
const root = await mkdtemp(join(tmpdir(), "remo-t7-visual-capture-"));
const outputRoot = resolve(import.meta.dirname, "../../../web/src/features/lifecycle/verification");

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback port");
  server.close();
  await once(server, "close");
  return address.port;
}

await mkdir(join(root, ".git"));
await mkdir(outputRoot, { recursive: true });

const application = await startLocalApplication({
  projectRoot: root,
  port: await freePort(),
  now: () => new Date("2026-08-16T13:00:00.000Z"),
  lifecycleSweepEveryMs: 60 * 60 * 1000,
});
const browser = await chromium.launch({ headless: true });

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await desktop.goto(`${application.origin}/candidate/review`);
  await desktop.getByRole("button", { name: "Confirm durable save" }).click();
  await desktop.getByRole("heading", { name: "Durable save created" }).waitFor();
  await desktop.goto(`${application.origin}/save-points/${savePointId}`);
  await desktop.getByRole("heading", { name: "Retention and lifecycle" }).waitFor();
  await desktop.screenshot({ path: join(outputRoot, "t7-lifecycle-desktop.png"), fullPage: true });
  await desktop.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${application.origin}/save-points/${savePointId}`);
  await mobile.getByRole("heading", { name: "Retention and lifecycle" }).waitFor();
  await mobile.getByRole("button", { name: "Pin" }).click();
  await mobile.getByRole("button", { name: "Unpin" }).waitFor();
  await mobile.screenshot({ path: join(outputRoot, "t7-lifecycle-mobile.png"), fullPage: true });
  await mobile.close();
} finally {
  await browser.close();
  await application.close();
  await rm(root, { recursive: true, force: true });
}
