export const PRODUCT_ROUTE_TABLE = [
  { id: "boundary-setup", path: "/boundary/setup", kind: "workflow" },
  { id: "capture-active", path: "/capture/active", kind: "workflow" },
  { id: "candidate-review", path: "/candidate/review", kind: "workflow" },
  { id: "save-points", path: "/save-points", kind: "collection" },
  { id: "save-point-detail", path: "/save-points/:id", kind: "identity" },
  { id: "replay", path: "/replay", kind: "workspace" },
  { id: "replay-detail", path: "/replay/:id", kind: "identity" },
  { id: "compare", path: "/compare?left=:id&right=:id", kind: "workspace" },
] as const;

export type ProductRouteDefinition = (typeof PRODUCT_ROUTE_TABLE)[number];
export type ProductRouteId = ProductRouteDefinition["id"];

export type RouteRecoveryState = "ready" | "bootstrap-absent" | "missing" | "deleted" | "expired" | "quarantined" | "unsupported-policy" | "malformed";

export interface ProductRouteBootstrap {
  readonly route: string;
  readonly state: RouteRecoveryState;
  readonly savePointId?: string;
}

export type ProductRouteMatch = ProductRouteDefinition & { readonly params: Readonly<Record<string, string>> };

const ID_PATTERN = "[A-Za-z0-9_-]{1,128}";
const SAVE_POINT_ID_PATTERN = new RegExp(`^${ID_PATTERN}$`, "u");
const SAVE_POINT_DETAIL_PATTERN = /^\/save-points\/(.*)$/u;
const REPLAY_DETAIL_PATTERN = new RegExp(`^/replay/(${ID_PATTERN})$`, "u");

function withParams(route: ProductRouteDefinition, params: Readonly<Record<string, string>> = {}): ProductRouteMatch {
  return { ...route, params };
}

export function isValidProductSavePointId(value: string): boolean {
  return SAVE_POINT_ID_PATTERN.test(value);
}

export function matchProductRoute(pathname: string): ProductRouteMatch | undefined {
  const staticRoute = PRODUCT_ROUTE_TABLE.find((route) => route.path === pathname);
  if (staticRoute !== undefined) return withParams(staticRoute);

  const savePoint = SAVE_POINT_DETAIL_PATTERN.exec(pathname);
  if (savePoint !== null) {
    const route = PRODUCT_ROUTE_TABLE.find(({ id }) => id === "save-point-detail");
    if (route !== undefined) return withParams(route, { id: savePoint[1]! });
  }

  const replay = REPLAY_DETAIL_PATTERN.exec(pathname);
  if (replay !== null) {
    const route = PRODUCT_ROUTE_TABLE.find(({ id }) => id === "replay-detail");
    if (route !== undefined) return withParams(route, { id: replay[1]! });
  }

  if (pathname === "/compare") {
    const route = PRODUCT_ROUTE_TABLE.find(({ id }) => id === "compare");
    if (route !== undefined) return withParams(route);
  }

  return undefined;
}

export type PolicyCategory = "Capture" | "Privacy" | "Integrity" | "Fidelity" | "Retention" | "Source" | "Trace" | "Decision" | "Verification" | "Fixture" | "Lineage";

export type PolicyRevisionSlot = "Capture" | "Privacy" | "Integrity" | "Fidelity" | "Retention";

export type PolicyCategoryProjection =
  | { readonly status: "available"; readonly category: PolicyCategory; readonly revision: string }
  | { readonly status: "unavailable"; readonly category: "Unavailable"; readonly revision: string };

export type PolicyRevisionProjection =
  | { readonly status: "available"; readonly expectedCategory: PolicyRevisionSlot; readonly category: PolicyRevisionSlot; readonly revision: string }
  | { readonly status: "unavailable"; readonly expectedCategory: PolicyRevisionSlot; readonly reason: "unknown-revision" | "category-mismatch"; readonly observedRevision: string; readonly actualCategory?: PolicyCategory };

const POLICY_CATEGORY_BY_REVISION: Readonly<Record<string, PolicyCategory>> = {
  "capture-v2": "Capture",
  "privacy-v4": "Privacy",
  "remo.privacy.v1": "Privacy",
  "integrity-v3": "Integrity",
  "fidelity-v2": "Fidelity",
  "retention-v1": "Retention",
  "source-v2": "Source",
  "trace-v1": "Trace",
  "decision-v1": "Decision",
  "verification-v2": "Verification",
  "fixture-v1": "Fixture",
  "lineage-v1": "Lineage",
};

export function projectPolicyCategory(revision: string): PolicyCategoryProjection {
  const category = POLICY_CATEGORY_BY_REVISION[revision];
  return category === undefined
    ? { status: "unavailable", category: "Unavailable", revision }
    : { status: "available", category, revision };
}

export function projectPolicyRevision(expectedCategory: PolicyRevisionSlot, revision: string): PolicyRevisionProjection {
  const projection = projectPolicyCategory(revision);
  if (projection.status === "available" && projection.category === expectedCategory) {
    return { status: "available", expectedCategory, category: expectedCategory, revision };
  }
  return {
    status: "unavailable",
    expectedCategory,
    reason: projection.status === "unavailable" ? "unknown-revision" : "category-mismatch",
    observedRevision: revision,
    ...(projection.status === "available" ? { actualCategory: projection.category } : {}),
  };
}
