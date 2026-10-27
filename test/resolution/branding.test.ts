import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBranding, sanitizeBranding } from "../../src/resolution/branding.ts";
import { scopeId } from "../../src/types.ts";
import type { OrgBranding, ScopedConfigStore } from "../../src/resolution/config-store.ts";

const brandingStore = (read: () => Promise<OrgBranding | null>) =>
  ({ settingDurable: read }) as unknown as Pick<ScopedConfigStore, "settingDurable">;

const ORG = scopeId("org", "acme");

test("sanitizeBranding strips template braces and control characters from every field", () => {
  assert.deepEqual(sanitizeBranding({ selfLabel: "{{straylight}}", orgName: "Acme {{Corp}}" }), {
    selfLabel: "straylight",
    orgName: "Acme Corp",
  });
  assert.deepEqual(sanitizeBranding({ selfLabel: "a<b>\u0000c", mark: '"{Q}"' }), { selfLabel: "abc", mark: "Q" });
  assert.equal(sanitizeBranding({ selfLabel: "x".repeat(80) })?.selfLabel?.length, 80);
  assert.equal(sanitizeBranding({ mark: "💚💚💚" })?.mark, "💚💚");
  assert.equal(sanitizeBranding({ mark: "👩‍💻x" })?.mark, "👩‍💻x");
  assert.deepEqual(sanitizeBranding({ accent: "#6366f1" }), { accent: "#6366f1" });
  assert.equal(sanitizeBranding({ accent: "#abcde" }), undefined);
  assert.equal(sanitizeBranding({ accent: "#aabbccddee" }), undefined);
  assert.equal(sanitizeBranding({}), undefined);
  assert.equal(sanitizeBranding({ selfLabel: "  ", orgName: "{{}}" }), undefined);
});

test("sanitizeBranding accepts only https mark image urls that cannot break out of a CSS declaration", () => {
  assert.deepEqual(sanitizeBranding({ markUrl: "https://cdn.example.com/icon.png" }), {
    markUrl: "https://cdn.example.com/icon.png",
  });
  assert.equal(sanitizeBranding({ markUrl: "http://cdn.example.com/icon.png" }), undefined);
  assert.equal(sanitizeBranding({ markUrl: "javascript:alert(1)" }), undefined);
  assert.equal(sanitizeBranding({ markUrl: 'https://a/");background:url("evil' }), undefined);
  assert.equal(sanitizeBranding({ markUrl: "https://a/x;color:red" }), undefined);
  assert.equal(sanitizeBranding({ markUrl: "https://a/</style><script>alert(1)</script>" }), undefined);
  assert.equal(sanitizeBranding({ markUrl: "https://a/ b" }), undefined);
  assert.deepEqual(sanitizeBranding({ markUrl: `https://a/${"x".repeat(500)}` }), {
    markUrl: `https://a/${"x".repeat(500)}`,
  });
});

test("resolveBranding prefers the store per field and fills the rest from the default", async () => {
  const config = brandingStore(async () => ({ selfLabel: "storebot" }));
  assert.deepEqual(await resolveBranding(config, ORG, { selfLabel: "envbot", orgName: "Env Org" }), {
    selfLabel: "storebot",
    orgName: "Env Org",
  });
  assert.deepEqual(await resolveBranding(undefined, ORG, { selfLabel: "envbot" }), { selfLabel: "envbot" });
  assert.deepEqual(
    await resolveBranding(
      brandingStore(async () => null),
      ORG,
    ),
    {},
  );
});

test("resolveBranding degrades to the default identity when the durable read fails", async () => {
  const config = brandingStore(async (): Promise<never> => {
    throw new Error("postgres hiccup");
  });
  assert.deepEqual(await resolveBranding(config, ORG, { selfLabel: "envbot" }), { selfLabel: "envbot" });
  assert.deepEqual(await resolveBranding(config, ORG), {});
});

test("resolveBranding sanitizes stored values that predate write-side sanitization", async () => {
  const config = brandingStore(async () => ({ selfLabel: "{{legacy}}", orgName: "Acme <{Corp}>" }));
  assert.deepEqual(await resolveBranding(config, ORG), { selfLabel: "legacy", orgName: "Acme Corp" });
});
