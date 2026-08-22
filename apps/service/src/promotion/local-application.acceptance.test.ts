import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalApplication } from "./local-application.js";

const SAVE_POINT_ID = "01J000000000000000000000S5";

const roots: string[] = [];
type FixtureChild = ChildProcessByStdio<null, Readable, Readable>;
const children: FixtureChild[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");
  server.close();
  await once(server, "close");
  return address.port;
}

function waitForReady(child: FixtureChild): Promise<{ origin: string }> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`bootstrap timeout\n${output}`)), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split(/\r?\n/u)) {
        try {
          const parsed = JSON.parse(line) as { event?: string; origin?: string };
          if (parsed.event === "remo.fixture.ready" && parsed.origin !== undefined) { clearTimeout(timer); resolveReady({ origin: parsed.origin }); }
        } catch { /* build output is not protocol output */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`bootstrap exited ${code}\n${output}`)); });
  });
}

describe("supported local fixture application", () => {
  it.runIf(process.platform === "win32")("rejects a project-root junction instead of silently canonicalizing it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "remo-local-app-root-link-t5-")); roots.push(parent);
    const realRoot = join(parent, "real");
    const linkedRoot = join(parent, "linked");
    await mkdir(join(realRoot, ".git"), { recursive: true });
    await symlink(realRoot, linkedRoot, "junction");
    await expect(startLocalApplication({ projectRoot: linkedRoot, port: await freePort() })).rejects.toThrow(/symbolic|junction|reparse|canonical/iu);
  });

  it("runs the committed command against the real browser/UI/service/SQLite/CAS path and shuts down cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-local-app-t5-")); roots.push(root);
    await mkdir(join(root, ".git"));
    const port = await freePort();
    const serviceRoot = resolve(import.meta.dirname, "../..");
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "pnpm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", `pnpm run start:fixture -- --project-root ${root} --port ${port}`]
      : ["run", "start:fixture", "--", "--project-root", root, "--port", String(port)];
    const child = spawn(command, args, { cwd: serviceRoot, env: { ...process.env, NODE_ENV: "production", NO_COLOR: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const { origin } = await waitForReady(child);
    expect(origin).toBe(`http://127.0.0.1:${port}`);

    const htmlResponse = await fetch(`${origin}/candidate/review`);
    const csp = htmlResponse.headers.get("content-security-policy");
    const html = await htmlResponse.text();
    expect(htmlResponse.headers.get("x-frame-options")).toBe("DENY");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`'nonce-${nonce}'`);
    const secondHtmlResponse = await fetch(`${origin}/candidate/review`);
    const secondHtml = await secondHtmlResponse.text();
    const secondNonce = /<script nonce="([^"]+)"/u.exec(secondHtml)?.[1];
    expect(secondNonce).toBeTruthy();
    expect(secondNonce).not.toBe(nonce);
    expect(secondHtmlResponse.headers.get("content-security-policy")).toContain(`'nonce-${secondNonce}'`);

    const browser = await chromium.launch({ headless: true });
    try {
      const hostilePort = await freePort();
      const hostile = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<iframe src="${origin}/candidate/review"></iframe>`);
      });
      hostile.listen(hostilePort, "127.0.0.1");
      await once(hostile, "listening");
      try {
        const hostilePage = await browser.newPage();
        await hostilePage.goto(`http://127.0.0.1:${hostilePort}`);
        await hostilePage.waitForTimeout(500);
        expect(hostilePage.frames().some((frame) => frame.url().startsWith(origin))).toBe(false);
        await hostilePage.close();
      } finally {
        hostile.close();
        await once(hostile, "close");
      }

      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${origin}/candidate/review`, { timeout: 15_000 });
      await page.getByText("VS-001 implementation fixture — approved binding fixture").waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Confirm durable save" }).click({ timeout: 10_000 });
      await page.getByRole("heading", { name: "Durable save created" }).waitFor({ timeout: 15_000 });
      const collectionResponse = await fetch(`${origin}/api/save-points`);
      expect(collectionResponse.status).toBe(200);
      expect(await collectionResponse.json()).toMatchObject([{ savePointId: SAVE_POINT_ID, displayId: "SP-005", turnNumber: 5, integrity: "Complete" }]);
      const collectionPage = await browser.newPage();
      await collectionPage.goto(`${origin}/save-points`);
      await collectionPage.getByRole("heading", { name: "Saved results" }).waitFor();
      await collectionPage.getByRole("link", { name: "Open SP-005" }).click();
      await collectionPage.getByRole("heading", { name: /Save point SP-/u }).waitFor();
      await collectionPage.close();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByText("Durable · unpinned").waitFor({ timeout: 10_000 });
      await page.evaluate(async () => {
        const token = (window as unknown as { __REMO_PROMOTION_SESSION__?: { readonly sessionToken: string } }).__REMO_PROMOTION_SESSION__?.sessionToken;
        if (token === undefined) throw new Error("missing runtime session token");
        const response = await fetch("/api/application/shutdown", { method: "POST", headers: { "x-remo-session-token": token } });
        if (!response.ok) throw new Error("clean shutdown request failed");
      });
    } finally {
      await browser.close();
    }

    const code = child.exitCode ?? await Promise.race([
        new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("supported command did not exit after authenticated shutdown")), 10_000)),
      ]);
    expect(code).toBe(0);
  }, 90_000);

  it("keeps the primary workflow rail discoverable, current, focusable, and overflow-safe at every supported width", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-local-app-t1-rail-")); roots.push(root);
    await mkdir(join(root, ".git"));
    const application = await startLocalApplication({ projectRoot: root, port: await freePort(), seedImplementationFixture: false });
    const browser = await chromium.launch({ headless: true });
    const consoleErrors: string[] = [];
    const routes = [
      { path: "/boundary/setup", currentHref: "/boundary/setup" },
      { path: "/capture/active", currentHref: "/capture/active" },
      { path: "/candidate/review", currentHref: "/candidate/review" },
      { path: "/save-points", currentHref: "/save-points" },
      { path: "/replay", currentHref: "/replay" },
      { path: "/replay/01J000000000000000000000S6", currentHref: "/replay" },
      { path: "/compare?left=left&right=right", currentHref: "/compare" },
    ] as const;
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${page.url()}`); });
      page.on("pageerror", (error) => consoleErrors.push(`${error.message} @ ${page.url()}`));
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of routes) {
          await page.goto(`${application.origin}${route.path}`, { waitUntil: "networkidle" });
          const navigation = page.getByRole("navigation", { name: "VS-002 workflow" });
          await navigation.waitFor();
          const links = navigation.getByRole("link");
          expect(await links.count(), `${width}px ${route.path} rail link count`).toBe(6);
          expect(await links.evaluateAll((elements) => elements.map((element) => element.getAttribute("href")))).toEqual([
            "/boundary/setup",
            "/capture/active",
            "/candidate/review",
            "/save-points",
            "/replay",
            "/compare",
          ]);
          for (let index = 0; index < await links.count(); index += 1) {
            const link = links.nth(index);
            await link.scrollIntoViewIfNeeded();
            expect(await link.isVisible(), `${width}px ${route.path} link ${index} visible`).toBe(true);
            expect(await link.evaluate((element) => (element as HTMLAnchorElement).tabIndex), `${width}px ${route.path} link ${index} keyboard focusable`).toBe(0);
            await link.focus();
            expect(await link.evaluate((element) => document.activeElement === element), `${width}px ${route.path} link ${index} receives focus`).toBe(true);
          }
          expect(await links.evaluateAll((elements) => elements.filter((element) => element.getAttribute("aria-current") === "page").map((element) => element.getAttribute("href")))).toEqual([route.currentHref]);
          const documentWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
          expect(documentWidth.scrollWidth, `${width}px ${route.path} document overflow`).toBeLessThanOrEqual(documentWidth.clientWidth);
        }
      }
      expect(consoleErrors).toEqual([]);
    } finally {
      await browser.close();
      await application.close();
    }
  }, 120_000);

  it("derives a quarantined route from the durable repository lifecycle after application restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-local-app-t1-quarantine-restart-")); roots.push(root);
    await mkdir(join(root, ".git"));
    let application = await startLocalApplication({ projectRoot: root, port: await freePort() });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    try {
      await page.goto(`${application.origin}/candidate/review`);
      await page.getByRole("button", { name: "Confirm durable save" }).click();
      await page.getByRole("heading", { name: "Durable save created" }).waitFor();
      await page.goto(`${application.origin}/save-points/${SAVE_POINT_ID}`);
      await page.getByRole("heading", { name: "Retention and lifecycle" }).waitFor();
      await page.getByRole("button", { name: "Quarantine" }).click();
      await page.getByRole("button", { name: "Quarantine save" }).click();
      await page.getByRole("heading", { name: "This save is quarantined" }).waitFor();

      await application.close();
      application = await startLocalApplication({ projectRoot: root, port: await freePort() });
      await page.goto(`${application.origin}/save-points/${SAVE_POINT_ID}`);
      await page.getByRole("heading", { name: "Save point quarantined" }).waitFor();
      expect(consoleErrors).toEqual([]);
    } finally {
      await application.close();
      await browser.close();
    }
  }, 120_000);

  it("maps a running lifecycle sweep to an expired route state", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-local-app-t1-expiry-sweep-")); roots.push(root);
    await mkdir(join(root, ".git"));
    let now = new Date("2026-08-16T13:00:00.000Z");
    const application = await startLocalApplication({ projectRoot: root, port: await freePort(), now: () => now, lifecycleSweepEveryMs: 10 });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${application.origin}/candidate/review`);
      await page.getByRole("button", { name: "Confirm durable save" }).click();
      await page.getByRole("heading", { name: "Durable save created" }).waitFor();
      now = new Date("2026-09-16T13:00:00.000Z");
      let html = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        html = await (await fetch(`${application.origin}/save-points/${SAVE_POINT_ID}`)).text();
        if (html.includes('"state":"expired"')) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(html).toContain('"state":"expired"');
      await page.goto(`${application.origin}/save-points/${SAVE_POINT_ID}`);
      await page.getByRole("heading", { name: "Save point expired" }).waitFor();
    } finally {
      await browser.close();
      await application.close();
    }
  }, 120_000);

  it("maps the immediate-expiry confirmation path to an expired route state", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-local-app-t1-expiry-immediate-")); roots.push(root);
    await mkdir(join(root, ".git"));
    let now = new Date("2026-08-16T13:00:00.000Z");
    const application = await startLocalApplication({ projectRoot: root, port: await freePort(), now: () => now, lifecycleSweepEveryMs: 60 * 60 * 1000 });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${application.origin}/candidate/review`);
      await page.getByRole("button", { name: "Confirm durable save" }).click();
      await page.getByRole("heading", { name: "Durable save created" }).waitFor();
      await page.goto(`${application.origin}/save-points/${SAVE_POINT_ID}`);
      await page.getByRole("heading", { name: "Retention and lifecycle" }).waitFor();
      await page.getByRole("button", { name: "Pin" }).click();
      await page.getByRole("button", { name: "Unpin" }).waitFor();
      now = new Date("2026-09-16T13:00:00.000Z");
      await page.getByRole("button", { name: "Unpin" }).click();
      await page.getByRole("alertdialog", { name: "Unpin and expire immediately?" }).waitFor();
      await page.getByRole("button", { name: "Unpin and expire" }).click();
      await page.getByRole("heading", { name: "This save expired" }).waitFor();
      await page.goto(`${application.origin}/save-points/${SAVE_POINT_ID}`);
      await page.getByRole("heading", { name: "Save point expired" }).waitFor();
    } finally {
      await browser.close();
      await application.close();
    }
  }, 120_000);

  it("runs retention, export, quarantine, regeneration, and verified deletion through the real browser/service/SQLite/CAS path", async () => {
    const root = await mkdtemp(join(tmpdir(), "remo-local-app-t7-lifecycle-")); roots.push(root);
    await mkdir(join(root, ".git"));
    const application = await startLocalApplication({ projectRoot: root, port: await freePort(), now: () => new Date("2026-08-16T13:00:00.000Z"), lifecycleSweepEveryMs: 60 * 60 * 1000 });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
      const consoleErrors: string[] = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      await page.goto(`${application.origin}/candidate/review`);
      await page.getByRole("button", { name: "Confirm durable save" }).click();
      await page.getByRole("heading", { name: "Durable save created" }).waitFor();
      await page.goto(`${application.origin}/save-points/${SAVE_POINT_ID}`);
      await page.getByRole("heading", { name: "Retention and lifecycle" }).waitFor();
      const originalDigest = await page.locator(".digest-card code").textContent();

      await page.getByRole("button", { name: "Pin" }).click();
      await page.getByRole("button", { name: "Unpin" }).waitFor();
      expect(await page.getByText("Pinned — automatic expiry suspended").count()).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Unpin" }).click();
      await page.getByRole("button", { name: "Pin" }).waitFor();

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export ZIP" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.zip$/u);
      await page.getByText(/Bounded ZIP export created with a SHA-256 inventory/u).waitFor();
      expect(await page.locator(".digest-card code").textContent()).toBe(originalDigest);

      await page.getByRole("button", { name: "Quarantine" }).click();
      const quarantineDialog = page.getByRole("alertdialog", { name: "Quarantine this save?" });
      await quarantineDialog.waitFor();
      await page.getByRole("button", { name: "Quarantine save" }).click();
      await page.getByRole("heading", { name: "This save is quarantined" }).waitFor();
      expect(await page.getByRole("img", { name: /Privacy-checked screenshot remains available locally/u }).count()).toBe(0);

      await page.getByRole("button", { name: "Redact and regenerate candidate" }).click();
      await page.getByText(/Redaction succeeded.*new candidate revision/u).waitFor();
      await page.getByRole("button", { name: "Delete local evidence" }).click();
      await page.getByRole("alertdialog", { name: "Delete controlled local evidence?" }).waitFor();
      await page.getByRole("button", { name: "Delete local evidence", exact: true }).last().click();
      await page.getByRole("heading", { name: "Controlled local evidence was deleted" }).waitFor();
      await page.getByText(/External Git and Langfuse records were not deleted/u).waitFor();
      expect((await fetch(`${application.origin}/save-points/${SAVE_POINT_ID}`)).status).toBe(200);
      await page.goto(`${application.origin}/save-points/${SAVE_POINT_ID}`);
      await page.getByRole("heading", { name: "Save point deleted" }).waitFor();
      expect(consoleErrors).toEqual([]);
    } finally {
      await browser.close();
      await application.close();
    }
  }, 90_000);
});
