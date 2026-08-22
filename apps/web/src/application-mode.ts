export type ApplicationMode = "local" | "hosted-demo";

interface ViteImportMeta extends ImportMeta {
  readonly env: { readonly MODE: string };
}

export function selectApplicationMode(viteMode: string): ApplicationMode {
  return viteMode === "hosted-demo" ? "hosted-demo" : "local";
}

export const APPLICATION_MODE = selectApplicationMode((import.meta as ViteImportMeta).env.MODE);
