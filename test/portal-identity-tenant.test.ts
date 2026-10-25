import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CORE_ORG_ID = "tenant-alpha";
process.env.ORG_ID = "tenant-alpha";
const chassis = await import("../plugins/chassis/src/portal-identity.ts");
const core = await import("../src/auth/portal-identity.ts");

const secret = "portal-identity-tenant-secret";
const now = 1_000_000;

test("the portal stamps its configured tenant on every identity it mints", () => {
  const token = chassis.mintPortalIdentity({ p: "alice@example.com", exp: now + 60_000 }, secret);
  assert.deepEqual(chassis.verifyPortalIdentity(token, secret, now), {
    p: "alice@example.com",
    t: "tenant-alpha",
    exp: now + 60_000,
  });
});

test("core accepts a portal identity stamped for the tenant it serves without reporting it", async (t) => {
  const reports = t.mock.method(console, "error", () => {});
  const token = chassis.mintPortalIdentity({ p: "alice@example.com", exp: now + 60_000 }, secret);
  assert.equal((await core.verifyPortalIdentity(token, secret, now))?.p, "alice@example.com");
  assert.equal(reports.mock.callCount(), 0);
});
