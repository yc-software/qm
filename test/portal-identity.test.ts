import { test } from "node:test";
import assert from "node:assert/strict";
import { mintPortalIdentity, verifyPortalIdentity } from "../plugins/chassis/src/portal-identity.ts";

const SECRET = "portal-identity-test-secret";
const now = 1_000_000;

test("mint → verify roundtrip returns the claims", () => {
  const token = mintPortalIdentity(
    { p: "alice@default-org", n: "Alice", imp: "admin@default-org", exp: now + 60_000 },
    SECRET,
  );
  const claims = verifyPortalIdentity(token, SECRET, now);
  assert.deepEqual(claims, { p: "alice@default-org", n: "Alice", imp: "admin@default-org", exp: now + 60_000 });
});

test("a tampered payload fails verification", () => {
  const token = mintPortalIdentity({ p: "alice@default-org", exp: now + 60_000 }, SECRET);
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ p: "bob@default-org", exp: now + 60_000 }), "utf8").toString("base64url");
  assert.equal(verifyPortalIdentity(`${forged}.${sig}`, SECRET, now), null);
  assert.equal(verifyPortalIdentity(`${payload}.deadbeef`, SECRET, now), null);
});

test("the wrong secret fails verification", () => {
  const token = mintPortalIdentity({ p: "alice@default-org", exp: now + 60_000 }, SECRET);
  assert.equal(verifyPortalIdentity(token, "other-secret", now), null);
});

test("an expired token fails verification", () => {
  const token = mintPortalIdentity({ p: "alice@default-org", exp: now + 60_000 }, SECRET);
  assert.ok(verifyPortalIdentity(token, SECRET, now + 59_999));
  assert.equal(verifyPortalIdentity(token, SECRET, now + 60_001), null);
});

test("malformed tokens and missing claims are rejected", () => {
  assert.equal(verifyPortalIdentity("", SECRET, now), null);
  assert.equal(verifyPortalIdentity("no-dot", SECRET, now), null);
  assert.equal(verifyPortalIdentity(".sig", SECRET, now), null);
  const token = mintPortalIdentity({ exp: now + 60_000 } as never, SECRET);
  assert.equal(verifyPortalIdentity(token, SECRET, now), null);
});
