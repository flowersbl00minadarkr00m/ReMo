import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const DEVELOPMENT_RUNTIME_MARKERS = Object.freeze([
  { name: "React jsxDEV transform", token: "jsxDEV" },
  { name: "React JSX development runtime", token: "react-jsx-dev-runtime.development.js" },
  { name: "React development runtime", token: "react.development.js" },
  { name: "React DOM development runtime", token: "react-dom.development.js" },
]);

const javascriptExtension = /\.(?:c|m)?js$/u;
const portable = (path) => path.replaceAll("\\", "/");

async function requireFile(path, description) {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata?.isFile() !== true) throw new Error(`T10 production web build ${description} is missing: ${path}`);
}

async function collectJavaScriptFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectJavaScriptFiles(root, path));
    else if (entry.isFile() && javascriptExtension.test(entry.name)) files.push(path);
  }
  return files;
}

export async function verifyProductionWebBuild(webRoot) {
  const metadata = await stat(webRoot).catch(() => undefined);
  if (metadata?.isDirectory() !== true) throw new Error(`T10 production web build directory is missing: ${webRoot}`);
  await requireFile(resolve(webRoot, "index.html"), "entrypoint");
  const javascriptPaths = await collectJavaScriptFiles(webRoot);
  if (javascriptPaths.length === 0) throw new Error(`T10 production web build emitted no JavaScript files: ${webRoot}`);

  const javascriptFiles = [];
  for (const path of javascriptPaths) {
    const source = await readFile(path, "utf8");
    const relativePath = portable(relative(webRoot, path));
    javascriptFiles.push(relativePath);
    for (const marker of DEVELOPMENT_RUNTIME_MARKERS) {
      if (source.includes(marker.token)) {
        throw new Error(`T10 production web build contains development-runtime marker ${JSON.stringify(marker.token)} (${marker.name}) in ${relativePath}`);
      }
    }
  }
  return { javascriptFiles };
}

export async function prepareJoinedVerification({
  webRoot,
  output,
  createOutput = (path) => mkdir(path, { recursive: true }),
  runSequence,
}) {
  const preflight = await verifyProductionWebBuild(webRoot);
  await createOutput(output);
  const report = await runSequence();
  return { preflight, report };
}
