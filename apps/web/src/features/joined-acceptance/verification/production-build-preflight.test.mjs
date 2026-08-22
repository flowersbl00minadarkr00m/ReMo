import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVELOPMENT_RUNTIME_MARKERS,
  prepareJoinedVerification,
} from "./production-build-preflight.mjs";

const roots = [];

async function temporaryRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "remo-t10-production-preflight-"));
  roots.push(root);
  return root;
}

async function writeBuild(root, javascript) {
  const webRoot = resolve(root, "dist");
  await mkdir(resolve(webRoot, "assets"), { recursive: true });
  await writeFile(resolve(webRoot, "index.html"), "<div id=\"root\"></div>");
  await writeFile(resolve(webRoot, "assets/application.js"), javascript);
  return webRoot;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("T10 production-build preflight", () => {
  it("keeps the development-runtime vocabulary exact and reviewable", () => {
    expect(DEVELOPMENT_RUNTIME_MARKERS).toEqual([
      { name: "React jsxDEV transform", token: "jsxDEV" },
      { name: "React JSX development runtime", token: "react-jsx-dev-runtime.development.js" },
      { name: "React development runtime", token: "react.development.js" },
      { name: "React DOM development runtime", token: "react-dom.development.js" },
    ]);
  });

  it("rejects missing output before evidence output or fixture creation", async () => {
    const root = await temporaryRoot();
    const output = resolve(root, "evidence");
    const createOutput = vi.fn(() => mkdir(output, { recursive: true }));
    const runSequence = vi.fn();

    await expect(prepareJoinedVerification({
      webRoot: resolve(root, "missing-dist"),
      output,
      createOutput,
      runSequence,
    })).rejects.toThrow(/production web build directory is missing/u);

    expect(createOutput).not.toHaveBeenCalled();
    expect(runSequence).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toThrow();
  });

  it.each(DEVELOPMENT_RUNTIME_MARKERS)(
    "rejects $name before evidence output or fixture creation",
    async ({ token }) => {
      const root = await temporaryRoot();
      const webRoot = await writeBuild(root, `const marker = ${JSON.stringify(token)};`);
      const output = resolve(root, "evidence");
      const createOutput = vi.fn(() => mkdir(output, { recursive: true }));
      const runSequence = vi.fn();

      await expect(prepareJoinedVerification({
        webRoot,
        output,
        createOutput,
        runSequence,
      })).rejects.toThrow(/development-runtime marker/u);

      expect(createOutput).not.toHaveBeenCalled();
      expect(runSequence).not.toHaveBeenCalled();
      await expect(access(output)).rejects.toThrow();
    },
  );

  it("accepts production-shaped output before creating evidence and the fixture", async () => {
    const root = await temporaryRoot();
    const webRoot = await writeBuild(root, "const render=()=>42;");
    const output = resolve(root, "evidence");
    const order = [];
    const report = { projectRoot: resolve(root, "fixture") };

    const prepared = await prepareJoinedVerification({
      webRoot,
      output,
      createOutput: async (path) => {
        order.push("output");
        await mkdir(path, { recursive: true });
      },
      runSequence: async () => {
        order.push("fixture");
        return report;
      },
    });

    expect(prepared.report).toBe(report);
    expect(prepared.preflight.javascriptFiles).toEqual(["assets/application.js"]);
    expect(order).toEqual(["output", "fixture"]);
    await expect(access(output)).resolves.toBeUndefined();
  });
});
