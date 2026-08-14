import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBranding, sanitizeBranding } from "../src/resolution/branding.ts";
import { scopeId } from "../src/types.ts";

const ORG = scopeId("org", "acme");

test("sanitizeBranding strips template braces and control characters from every field", () => {
  assert.deepEqual(sanitizeBranding({ selfLabel: "{{straylight}}", orgName: "Acme {{Corp}}" }), {
    selfLabel: "straylight",
    orgName: "Acme Corp",
  });
  assert.deepEqual(sanitizeBranding({ selfLabel: "a<b>\u0000c", mark: '"{Q}"' }), { selfLabel: "abc", mark: "Q" });
  assert.equal(sanitizeBranding({ selfLabel: "x".repeat(80) })?.selfLabel?.length, 40);
  assert.equal(sanitizeBranding({ selfLabel: "x".repeat(39) + "💚💚" })?.selfLabel, "x".repeat(39) + "💚");
  assert.doesNotMatch(
    sanitizeBranding({ selfLabel: "💚".repeat(50) })?.selfLabel ?? "",
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
  );
  assert.deepEqual(sanitizeBranding({ accent: "#6366f1" }), { accent: "#6366f1" });
  assert.equal(sanitizeBranding({ accent: "#abcde" }), undefined);
  assert.equal(sanitizeBranding({ accent: "#aabbccddee" }), undefined);
  assert.equal(sanitizeBranding({}), undefined);
  assert.equal(sanitizeBranding({ selfLabel: "  ", orgName: "{{}}" }), undefined);
});

test("resolveBranding prefers the store per field and fills the rest from the default", async () => {
  const config = { getBrandingDurable: async () => ({ selfLabel: "storebot" }) };
  assert.deepEqual(await resolveBranding(config, ORG, { selfLabel: "envbot", orgName: "Env Org" }), {
    selfLabel: "storebot",
    orgName: "Env Org",
  });
  assert.deepEqual(await resolveBranding(undefined, ORG, { selfLabel: "envbot" }), { selfLabel: "envbot" });
  assert.deepEqual(await resolveBranding({ getBrandingDurable: async () => null }, ORG), {});
});

test("resolveBranding degrades to the default identity when the durable read fails", async () => {
  const config = {
    getBrandingDurable: async (): Promise<never> => {
      throw new Error("postgres hiccup");
    },
  };
  assert.deepEqual(await resolveBranding(config, ORG, { selfLabel: "envbot" }), { selfLabel: "envbot" });
  assert.deepEqual(await resolveBranding(config, ORG), {});
});

test("resolveBranding sanitizes stored values that predate write-side sanitization", async () => {
  const config = { getBrandingDurable: async () => ({ selfLabel: "{{legacy}}", orgName: "Acme <{Corp}>" }) };
  assert.deepEqual(await resolveBranding(config, ORG), { selfLabel: "legacy", orgName: "Acme Corp" });
});
