import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalSerialize, sha256Canonical } from "./canonical.js";

describe("platform-neutral canonical digest", () => {
  it.each([{}, { z: "Unicode café 👋", a: [true, 42, null] }, { long: "x".repeat(257) }])("matches Node SHA-256 for %j", (value) => {
    const expected = createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
    expect(sha256Canonical(value)).toBe(`sha256:${expected}`);
  });

  it.each([55, 56, 63, 64])("matches Node SHA-256 at the %i-byte padding boundary", (byteLength) => {
    const value = "x".repeat(byteLength - 2);
    const canonical = canonicalSerialize(value);
    expect(Buffer.byteLength(canonical, "utf8")).toBe(byteLength);
    expect(sha256Canonical(value)).toBe(`sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`);
  });

  it.each(["é", "漢字", "👋🏽", "café 漢字 👋🏽"])('matches Node SHA-256 for multi-byte Unicode "%s"', (value) => {
    const canonical = canonicalSerialize(value);
    expect(Buffer.byteLength(canonical, "utf8")).toBeGreaterThan(canonical.length);
    expect(sha256Canonical(value)).toBe(`sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`);
  });
});
