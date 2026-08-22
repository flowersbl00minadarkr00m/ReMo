import { describe, expect, it } from "vitest";
import { isValidProductSavePointId, matchProductRoute, PRODUCT_ROUTE_TABLE, projectPolicyCategory, projectPolicyRevision } from "./routes.js";

describe("VS-002 shared product route contract", () => {
  it("matches every registered workflow path, including parameterized routes", () => {
    expect(PRODUCT_ROUTE_TABLE.map(({ path }) => path)).toEqual([
      "/boundary/setup",
      "/capture/active",
      "/candidate/review",
      "/save-points",
      "/save-points/:id",
      "/replay",
      "/replay/:id",
      "/compare?left=:id&right=:id",
    ]);
    expect(matchProductRoute("/boundary/setup")?.id).toBe("boundary-setup");
    expect(matchProductRoute("/save-points/01J000000000000000000000S6")?.id).toBe("save-point-detail");
    expect(matchProductRoute("/replay/01J000000000000000000000S6")?.id).toBe("replay-detail");
    expect(matchProductRoute("/compare")?.id).toBe("compare");
    expect(matchProductRoute("/save-points/not%20valid")?.id).toBe("save-point-detail");
    expect(matchProductRoute("/save-points/not%20valid")?.params.id).toBe("not%20valid");
    expect(matchProductRoute("/save-points/not/valid")?.id).toBe("save-point-detail");
    expect(matchProductRoute("/assets/app.js")).toBeUndefined();
    expect(isValidProductSavePointId("01J000000000000000000000S6")).toBe(true);
    expect(isValidProductSavePointId("not%20valid")).toBe(false);
    expect(isValidProductSavePointId("not/valid")).toBe(false);
  });
});

describe("closed policy-category projection", () => {
  it("maps the privacy policy revision to Privacy and never substitutes for unknown values", () => {
    expect(projectPolicyCategory("remo.privacy.v1")).toEqual({ status: "available", category: "Privacy", revision: "remo.privacy.v1" });
    expect(projectPolicyCategory("privacy-v4")).toEqual({ status: "available", category: "Privacy", revision: "privacy-v4" });
    expect(projectPolicyCategory("unknown.policy.v9")).toEqual({ status: "unavailable", category: "Unavailable", revision: "unknown.policy.v9" });
  });

  it("marks a known revision in the wrong top-level slot as unavailable without substituting its category", () => {
    expect(projectPolicyRevision("Integrity", "remo.privacy.v1")).toEqual({ status: "unavailable", expectedCategory: "Integrity", reason: "category-mismatch", observedRevision: "remo.privacy.v1", actualCategory: "Privacy" });
    expect(projectPolicyRevision("Privacy", "remo.privacy.v1")).toEqual({ status: "available", expectedCategory: "Privacy", category: "Privacy", revision: "remo.privacy.v1" });
  });
});
