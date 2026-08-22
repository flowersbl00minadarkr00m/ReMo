import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const promotionTarget = process.env.REMO_PROMOTION_TARGET;
  const proxy = promotionTarget === undefined ? undefined : { "/api": { target: promotionTarget } };
  const applicationRoot = mode === "hosted-demo"
    ? resolve(import.meta.dirname, "src/features/hosted-demo/HostedDemoApp.tsx")
    : resolve(import.meta.dirname, "src/App.tsx");
  return {
    plugins: mode === "hosted-demo" ? [{
      name: "remo-hosted-demo-index",
      transformIndexHtml: {
        order: "pre",
        handler: () => [{
          tag: "link",
          attrs: {
            rel: "icon",
            href: "data:image/svg+xml,%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b315e'/%3E%3Cpath d='M8 20a9 9 0 1 0 1-11M5 9h7v7' fill='none' stroke='%23fff' stroke-width='3'/%3E%3C/svg%3E",
          },
          injectTo: "head-prepend",
        }],
      },
    }] : [],
    resolve: { alias: { "#remo-application-root": applicationRoot } },
    server: { host: "127.0.0.1", ...(proxy === undefined ? {} : { proxy }) },
    preview: { host: "127.0.0.1", port: 4174, strictPort: true, ...(proxy === undefined ? {} : { proxy }) },
    build: {
      manifest: true,
      rollupOptions: {
        input: mode === "hosted-demo"
          ? {
              application: resolve(import.meta.dirname, "index.html"),
              demoReplay: resolve(import.meta.dirname, "demo-replay.html"),
            }
          : {
              application: resolve(import.meta.dirname, "index.html"),
              replayRuntime: resolve(import.meta.dirname, "src/replay-runtime/main.ts"),
            },
      },
    },
  };
});
