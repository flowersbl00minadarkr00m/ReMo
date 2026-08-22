import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalSerialize, sha256Canonical } from "@remo/domain";
import { describe, expect, it, vi } from "vitest";
import { HOSTED_DEMO_FIXTURE_PATH, HOSTED_DEMO_MANIFEST_PATH, loadHostedDemoFixture, validateHostedDemoFixture } from "./hosted-demo-fixture.js";

const publicRoot = resolve(import.meta.dirname, "../../../public/hosted-demo");
const readJson = (name: string): unknown => JSON.parse(readFileSync(resolve(publicRoot, name), "utf8"));

interface MutableManifest {
  schemaVersion: string;
  entries: { byteLength: number; digest: string }[];
}

interface MutableFixture {
  [key: string]: unknown;
  history: { anchors: { nominationReason?: string }[] };
  detailsBySavePointId: Record<string, { turnId: string; nominationReason: string }>;
  sessionToken?: string;
}

const source = () => ({
  manifest: readJson("fixture-manifest.json") as MutableManifest,
  fixtureText: readFileSync(resolve(publicRoot, "fixture.json"), "utf8"),
  fixture: readJson("fixture.json") as MutableFixture,
});

function bind(manifest: MutableManifest, fixture: MutableFixture): string {
  const serialized = canonicalSerialize(fixture);
  const entry = manifest.entries[0]!;
  entry.byteLength = new TextEncoder().encode(serialized).byteLength;
  entry.digest = sha256Canonical(fixture);
  return serialized;
}

describe("hosted demo fixture boundary", () => {
  it("binds the committed fixture's exact UTF-8 bytes", () => {
    const manifest = readJson("fixture-manifest.json") as MutableManifest;
    const fixtureBytes = readFileSync(resolve(publicRoot, "fixture.json"));
    const entry = manifest.entries[0]!;
    expect(entry.byteLength).toBe(fixtureBytes.byteLength);
    expect(entry.digest).toBe(`sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`);
  });

  it("validates and deeply freezes the committed ten-anchor fixture", () => {
    const { manifest, fixtureText } = source();
    const validated = validateHostedDemoFixture(manifest, fixtureText);
    expect(validated.history.anchors).toHaveLength(10);
    expect(validated.history.anchors.filter(({ state }) => state === "tombstone")).toHaveLength(1);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.history.anchors)).toBe(true);
    expect(Object.isFrozen(validated.detailsBySavePointId["demo-save-04"])).toBe(true);
    expect(validated.media.map(({ componentId }) => componentId)).toEqual([
      "demo-turn-04:screenshot",
      "demo-turn-04:rrweb",
      "demo-turn-05:screenshot",
    ]);
    expect(validated.decisionsBySavePointId["demo-save-04"]?.current.turnId).toBe("demo-turn-04");
    expect(validated.comparisonsByPair["demo-save-04::demo-save-05"]).toMatchObject({
      left: { savePointId: "demo-save-04", turnId: "demo-turn-04" },
      right: { savePointId: "demo-save-05", turnId: "demo-turn-05" },
      parityClaimAllowed: false,
    });
    expect(validated.preflight).toMatchObject({ savePointId: "demo-save-04", savePointRevision: 1, ready: true });
    expect(validated.simulatedBranch).toMatchObject({ savePointId: "demo-save-04", savePointRevision: 1, lineageId: "lineage:simulated-alternate" });
    expect(Object.isFrozen(validated.media)).toBe(true);
    expect(Object.isFrozen(validated.decisionsBySavePointId["demo-save-04"])).toBe(true);
    expect(Object.isFrozen(validated.comparisonsByPair["demo-save-04::demo-save-05"])).toBe(true);
    expect(Object.isFrozen(validated.preflight)).toBe(true);
    expect(Object.isFrozen(validated.simulatedBranch)).toBe(true);
  });

  const manifestCases: readonly [string, (manifest: MutableManifest) => void, RegExp][] = [
    ["schema", (manifest) => { manifest.schemaVersion = "unknown"; }, /schema/u],
    ["digest", (manifest) => { manifest.entries[0]!.digest = `sha256:${"0".repeat(64)}`; }, /digest/u],
  ];

  it.each(manifestCases)("rejects invalid %s authority", (_label, mutate, pattern) => {
    const { manifest, fixtureText } = source();
    mutate(manifest);
    expect(() => validateHostedDemoFixture(manifest, fixtureText)).toThrow(pattern);
  });

  const fixtureCases: readonly [string, (fixture: MutableFixture) => void, RegExp][] = [
    ["identity", (fixture) => { fixture.detailsBySavePointId["demo-save-04"]!.turnId = "demo-turn-05"; }, /identity/u],
    ["URL", (fixture) => { fixture.detailsBySavePointId["demo-save-04"]!.nominationReason = "https://outside.example/evidence"; fixture.history.anchors[3]!.nominationReason = "https://outside.example/evidence"; }, /URL|host/u],
    ["credential shape", (fixture) => { fixture.sessionToken = "not-a-real-value"; }, /credential-shaped field/u],
    ["Windows path", (fixture) => { fixture.detailsBySavePointId["demo-save-04"]!.nominationReason = "C:\\private\\fixture"; fixture.history.anchors[3]!.nominationReason = "C:\\private\\fixture"; }, /absolute local path/u],
    ["POSIX path", (fixture) => { fixture.detailsBySavePointId["demo-save-04"]!.nominationReason = "/private/fixture"; fixture.history.anchors[3]!.nominationReason = "/private/fixture"; }, /absolute local path/u],
  ];

  it.each(fixtureCases)("rejects forbidden %s fixture content even when the manifest is rebound", (_label, mutate, pattern) => {
    const { manifest, fixture } = source();
    mutate(fixture);
    const fixtureText = bind(manifest, fixture);
    expect(() => validateHostedDemoFixture(manifest, fixtureText)).toThrow(pattern);
  });

  const credentialFieldCases = [
    "token",
    "accessToken",
    "access_token",
    "access-token",
    "authToken",
    "auth_token",
    "auth-token",
    "privateKey",
    "private_key",
    "private-key",
  ] as const;

  it.each(credentialFieldCases)("rejects a %s credential field when the manifest is rebound", (field) => {
    const { manifest, fixture } = source();
    fixture[field] = "not-a-real-value";
    const fixtureText = bind(manifest, fixture);
    expect(() => validateHostedDemoFixture(manifest, fixtureText)).toThrow(/credential-shaped field/u);
  });

  const rawCredentialCases = [
    ["OpenAI project key", ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"].join("-")],
    ["Slack bot token", ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-")],
    ["JWT", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJkZW1vIn0", "signature0123456789"].join(".")],
  ] as const;

  it.each(rawCredentialCases)("rejects a raw %s signature when the manifest is rebound", (_label, credential) => {
    const { manifest, fixture } = source();
    fixture.detailsBySavePointId["demo-save-04"]!.nominationReason = credential;
    fixture.history.anchors[3]!.nominationReason = credential;
    const fixtureText = bind(manifest, fixture);
    expect(() => validateHostedDemoFixture(manifest, fixtureText)).toThrow(/credential-shaped value/u);
  });

  it("does not mistake credential-related prose or non-credential field names for secrets", () => {
    const { manifest, fixture } = source();
    fixture.tokenCount = 0;
    fixture.privateKeyboardShortcut = "disabled";
    fixture.detailsBySavePointId["demo-save-04"]!.nominationReason = "Token-based access is unavailable; sk-proj-* and JWT-shaped values are rejected.";
    fixture.history.anchors[3]!.nominationReason = "Token-based access is unavailable; sk-proj-* and JWT-shaped values are rejected.";
    const fixtureText = bind(manifest, fixture);
    expect(() => validateHostedDemoFixture(manifest, fixtureText)).not.toThrow();
  });

  it("loads only the two closed same-origin JSON paths without credentials", async () => {
    const { manifest, fixtureText } = source();
    const fetcher = vi.fn((input: string | URL | Request, request?: RequestInit) => {
      void request;
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      const body = path === HOSTED_DEMO_MANIFEST_PATH ? JSON.stringify(manifest) : path === HOSTED_DEMO_FIXTURE_PATH ? fixtureText : undefined;
      return Promise.resolve(body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    });
    const loaded = await loadHostedDemoFixture(undefined, fetcher as typeof fetch);
    expect(loaded.fixtureRevision).toBe("rel001-fixture-2026-08-20");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([HOSTED_DEMO_MANIFEST_PATH, HOSTED_DEMO_FIXTURE_PATH]);
    expect(fetcher).toHaveBeenNthCalledWith(1, HOSTED_DEMO_MANIFEST_PATH, expect.objectContaining({ method: "GET", credentials: "omit", mode: "same-origin", redirect: "error" }));
    expect(fetcher).toHaveBeenNthCalledWith(2, HOSTED_DEMO_FIXTURE_PATH, expect.objectContaining({ method: "GET", credentials: "omit", mode: "same-origin", redirect: "error" }));
  });
});
