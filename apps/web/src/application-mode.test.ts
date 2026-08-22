import { describe, expect, it } from "vitest";
import { selectApplicationMode } from "./application-mode.js";

describe("compile-time application mode", () => {
  it("selects hosted demo only for the Vite hosted-demo mode", () => {
    expect(selectApplicationMode("hosted-demo")).toBe("hosted-demo");
    expect(selectApplicationMode("production")).toBe("local");
    expect(selectApplicationMode("development")).toBe("local");
    expect(selectApplicationMode("hosted-demo?local=true")).toBe("local");
  });
});
