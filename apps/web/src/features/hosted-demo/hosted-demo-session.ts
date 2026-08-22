export const HOSTED_DEMO_ORIGINAL_LINEAGE_ID = "lineage:original" as const;
export const HOSTED_DEMO_ALTERNATE_LINEAGE_ID = "lineage:simulated-alternate" as const;

export type HostedDemoSessionState =
  | { readonly branch: "not-created"; readonly lineage: typeof HOSTED_DEMO_ORIGINAL_LINEAGE_ID; readonly recovery?: string }
  | { readonly branch: "simulated-created"; readonly lineage: typeof HOSTED_DEMO_ORIGINAL_LINEAGE_ID | typeof HOSTED_DEMO_ALTERNATE_LINEAGE_ID; readonly recovery?: string };

const RECOVERY = "Invalid simulated branch state was removed. The unchanged original future is shown.";

export function parseHostedDemoSession(search: string): HostedDemoSessionState {
  const params = new URLSearchParams(search);
  const branches = params.getAll("demoBranch");
  const lineages = params.getAll("lineage");
  if (branches.length === 0 && lineages.length === 0) return { branch: "not-created", lineage: HOSTED_DEMO_ORIGINAL_LINEAGE_ID };
  if (branches.length !== 1 || lineages.length !== 1 || branches[0] !== "simulated-created" || (lineages[0] !== HOSTED_DEMO_ORIGINAL_LINEAGE_ID && lineages[0] !== HOSTED_DEMO_ALTERNATE_LINEAGE_ID)) {
    return { branch: "not-created", lineage: HOSTED_DEMO_ORIGINAL_LINEAGE_ID, recovery: RECOVERY };
  }
  return { branch: "simulated-created", lineage: lineages[0] };
}

export function hostedDemoSessionUrl(path: string, state: HostedDemoSessionState): string {
  if (state.branch === "not-created") return path;
  const params = new URLSearchParams({ demoBranch: state.branch, lineage: state.lineage });
  return `${path}?${params.toString()}`;
}
