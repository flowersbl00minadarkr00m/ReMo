import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";

interface ManifestEntry {
  readonly file?: unknown;
  readonly name?: unknown;
  readonly src?: unknown;
  readonly isEntry?: unknown;
  readonly imports?: unknown;
  readonly css?: unknown;
  readonly assets?: unknown;
}

export interface ReplayRuntimeAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface ReplayRuntimeAssets {
  readonly document: Buffer;
  readonly assets: ReadonlyMap<string, ReplayRuntimeAsset>;
}

const MIME: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

function safeBuiltAsset(webRoot: string, relativePath: string): { readonly route: string; readonly file: string } {
  if (!/^assets\/[A-Za-z0-9._/-]+$/u.test(relativePath) || relativePath.includes("..") || relativePath.includes("\\")) throw new Error("Replay runtime manifest contains an unsafe asset path.");
  const file = resolve(webRoot, relativePath);
  if (relative(webRoot, file).startsWith("..") || !file.startsWith(`${webRoot}${sep}`)) throw new Error("Replay runtime asset escapes the web root.");
  const entry = lstatSync(file);
  if (entry.isSymbolicLink() || !statSync(file).isFile() || realpathSync.native(file) !== file) throw new Error("Replay runtime assets must be canonical regular files.");
  return { route: `/${relativePath.replaceAll("\\", "/")}`, file };
}

export function loadReplayRuntimeAssets(webRootInput: string): ReplayRuntimeAssets {
  const webRoot = realpathSync.native(resolve(webRootInput));
  const manifestPath = resolve(webRoot, ".vite/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestEntry>;
  const runtimeKey = Object.keys(manifest).find((key) => key === "src/replay-runtime/main.ts" || (manifest[key]?.isEntry === true && manifest[key]?.name === "replayRuntime"));
  if (runtimeKey === undefined) throw new Error("Built replay runtime entry is unavailable.");
  const pending = [runtimeKey];
  const visited = new Set<string>();
  const files = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const entry = manifest[key];
    if (entry === undefined || typeof entry.file !== "string") throw new Error("Built replay runtime manifest entry is invalid.");
    files.add(entry.file);
    for (const field of [entry.css, entry.assets]) {
      if (field === undefined) continue;
      if (!Array.isArray(field) || field.some((value) => typeof value !== "string")) throw new Error("Built replay runtime manifest assets are invalid.");
      for (const value of field as string[]) files.add(value);
    }
    if (entry.imports !== undefined) {
      if (!Array.isArray(entry.imports) || entry.imports.some((value) => typeof value !== "string" || manifest[value] === undefined)) throw new Error("Built replay runtime manifest imports are invalid.");
      pending.push(...entry.imports as string[]);
    }
  }
  const entry = manifest[runtimeKey]!;
  const loaded = new Map<string, ReplayRuntimeAsset>();
  for (const relativePath of files) {
    const asset = safeBuiltAsset(webRoot, relativePath);
    const contentType = MIME[extname(asset.file)];
    if (contentType === undefined) throw new Error("Replay runtime asset type is not allowlisted.");
    loaded.set(asset.route, { bytes: readFileSync(asset.file), contentType });
  }
  const styles = Array.isArray(entry.css) ? (entry.css as string[]).map((path) => `<link rel="stylesheet" href="/${path}">`).join("") : "";
  const document = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<title>ReMo isolated replay runtime</title></head><body><main id="replay-root" aria-label="Isolated historical replay"></main><script type="module" src="/${String(entry.file)}"></script></body></html>`);
  return { document, assets: loaded };
}
