import { describe, expect, it } from "vitest";
import { hostedDemoSessionUrl, parseHostedDemoSession } from "./hosted-demo-session.js";

describe("hosted demo closed session URL state", () => {
  it("accepts only the original state or the single created lineage", () => {
    expect(parseHostedDemoSession("")).toEqual({ branch: "not-created", lineage: "lineage:original" });
    expect(parseHostedDemoSession("?demoBranch=simulated-created&lineage=lineage%3Asimulated-alternate")).toEqual({
      branch: "simulated-created",
      lineage: "lineage:simulated-alternate",
    });
    expect(parseHostedDemoSession("?demoBranch=simulated-created&lineage=lineage%3Aoriginal")).toEqual({
      branch: "simulated-created",
      lineage: "lineage:original",
    });
  });

  it.each([
    "?demoBranch=created&lineage=lineage%3Asimulated-alternate",
    "?demoBranch=simulated-created&lineage=lineage%3Aunsupported",
    "?lineage=lineage%3Asimulated-alternate",
    "?demoBranch=simulated-created&demoBranch=simulated-created&lineage=lineage%3Asimulated-alternate",
    "?demoBranch=simulated-created&lineage=lineage%3Asimulated-alternate&lineage=lineage%3Aoriginal",
  ])("fails malformed or repeated state closed to the original future: %s", (search) => {
    expect(parseHostedDemoSession(search)).toEqual({
      branch: "not-created",
      lineage: "lineage:original",
      recovery: "Invalid simulated branch state was removed. The unchanged original future is shown.",
    });
  });

  it("serializes only the closed state and preserves no unrelated persistence", () => {
    expect(hostedDemoSessionUrl("/replay/demo-save-04", { branch: "not-created", lineage: "lineage:original" })).toBe("/replay/demo-save-04");
    expect(hostedDemoSessionUrl("/replay/demo-save-04", { branch: "simulated-created", lineage: "lineage:simulated-alternate" })).toBe("/replay/demo-save-04?demoBranch=simulated-created&lineage=lineage%3Asimulated-alternate");
  });
});
