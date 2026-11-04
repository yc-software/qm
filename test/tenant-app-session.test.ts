import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deriveKey, seal } from "../plugins/portal/src/session.ts";
import { hostRequest } from "./support/host-request.ts";
import { type Instance, skip, startTenantInstance, stopTenantInstance } from "./support/tenant-instance.ts";

const SESSION_SECRET = "tenant-app-session-secret";
const a = randomUUID();
const b = randomUUID();
let multi: Instance;

function cookie(tenant?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { k: "session", sub: "viewer@example.test", org: "acme", iat: now, exp: now + 600 };
  return `portal_session=${seal(tenant ? { ...claims, t: tenant } : claims, deriveKey(SESSION_SECRET, "portal.session.v1"))}`;
}

describe("org-visible app on a shared apps domain", { skip }, () => {
  before(async () => {
    multi = await startTenantInstance([a, b], {
      deployAppsSessionSecret: SESSION_SECRET,
      deployAppsLoginUrl: "https://portal.example.test",
    });
    await multi.owner.query(`INSERT INTO deployments(tenant_id, id, json) VALUES ($1, 'shop-b', '{}')`, [b]);
  });

  after(() => stopTenantInstance(multi));

  const visit = (session: string, accept = "application/json") =>
    hostRequest(`${multi.base}/`, "shop-b.apps.example.test", { headers: { cookie: session, accept } });

  it("sends another tenant's cookie to sign-in", async () => {
    const json = await visit(cookie(a));
    assert.equal(json.status, 401);
    assert.match(json.text, /sign-in required/);
    assert.equal((await visit(cookie(a), "text/html")).status, 302);
    assert.equal((await visit(cookie())).status, 401);
  });

  it("lets the app's own tenant through", async () => {
    const own = await visit(cookie(b));
    assert.notEqual(own.status, 401);
    assert.doesNotMatch(own.text, /sign-in required/);
  });
});
