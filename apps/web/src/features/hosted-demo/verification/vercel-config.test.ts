import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../../../../..");
const vercelConfigPath = resolve(repositoryRoot, "vercel.json");

type Header = { key: string; value: string };
type VercelConfig = {
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  rewrites?: Array<{ source: string; destination: string }>;
  headers?: Array<{ source: string; headers: Header[] }>;
  functions?: unknown;
  env?: unknown;
};

function readConfig(): VercelConfig {
  expect(existsSync(vercelConfigPath), "repository-owned vercel.json must exist").toBe(true);
  return JSON.parse(readFileSync(vercelConfigPath, "utf8")) as VercelConfig;
}

describe("REL-001 T5 Vercel delivery contract", () => {
  it("pins the frozen monorepo install, hosted build, and static output", () => {
    const config = readConfig();

    expect(config.installCommand).toBe("pnpm install --frozen-lockfile");
    expect(config.buildCommand).toBe("pnpm --dir apps/web run build:demo");
    expect(config.outputDirectory).toBe("apps/web/dist");
    expect(config.functions).toBeUndefined();
    expect(config.env).toBeUndefined();
  });

  it("uses the filesystem-aware Vercel SPA fallback for direct product routes", () => {
    const config = readConfig();

    expect(config.rewrites).toEqual([{ source: "/(.*)", destination: "/index.html" }]);
  });

  it("applies explicit restrictive security headers to every response", () => {
    const config = readConfig();
    const allResponses = config.headers?.find(({ source }) => source === "/(.*)");
    const headers = new Map(allResponses?.headers.map(({ key, value }) => [key.toLowerCase(), value]));

    expect(headers.get("content-security-policy")).toBe([
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
      "frame-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'none'",
    ].join("; "));
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("keeps the hosted data favicon compatible with the CSP without external assets", () => {
    const viteConfig = readFileSync(resolve(repositoryRoot, "apps/web/vite.config.ts"), "utf8");
    const document = readFileSync(resolve(repositoryRoot, "apps/web/index.html"), "utf8");
    const csp = readConfig().headers
      ?.flatMap(({ headers }) => headers)
      .find(({ key }) => key.toLowerCase() === "content-security-policy")?.value;

    expect(viteConfig).toContain("data:image/svg+xml");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(`${viteConfig}\n${document}`).not.toMatch(/https?:\/\//u);
  });
});
