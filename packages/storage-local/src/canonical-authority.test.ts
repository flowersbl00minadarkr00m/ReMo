import { canonicalSerialize as domainCanonicalSerialize } from "@remo/domain";
import { describe, expect, it } from "vitest";
import { canonicalSerialize as storageCanonicalSerialize } from "./index.js";

describe("canonical JSON authority", () => {
  it("exposes the domain implementation through storage compatibility without changing canonical bytes", () => {
    expect(storageCanonicalSerialize).toBe(domainCanonicalSerialize);
    const corpus: readonly unknown[] = [
      null,
      true,
      0,
      -0,
      "payload-neutral",
      [3, { z: null, a: "first", omitted: undefined }],
      { z: [false, 2], a: { y: "later", b: "earlier" }, omitted: undefined },
    ];
    expect(corpus.map(storageCanonicalSerialize)).toEqual([
      "null",
      "true",
      "0",
      "0",
      '"payload-neutral"',
      '[3,{"a":"first","z":null}]',
      '{"a":{"b":"earlier","y":"later"},"z":[false,2]}',
    ]);
  });
});
