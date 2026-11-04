import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deriveKey, seal } from "../plugins/portal/src/session.ts";
import { appViewerTenant, portalSession } from "../src/deploy/viewer-session.ts";
import { registerTenants, withTenant } from "../src/tenants/context.ts";

const SESSION_SECRET = "tenant-app-viewer-secret";
const a = randomUUID();
const b = randomUUID();

function cookie(tenant?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { k: "session", sub: "viewer@example.test", org: "acme", iat: now, exp: now + 600 };
  return `portal_session=${seal(tenant ? { ...claims, t: tenant } : claims, deriveKey(SESSION_SECRET, "portal.session.v1"))}`;
}

function viewer(header: string, tenant: string): string | undefined {
  return withTenant(tenant, () => portalSession(header, SESSION_SECRET, appViewerTenant())?.sub);
}

describe("app viewer sessions are bound to a tenant", () => {
  it("accept a cookie only on its own tenant", () => {
    registerTenants(a, undefined);
    assert.equal(viewer(cookie(a), a), "viewer@example.test");
    assert.equal(viewer(cookie(a), b), undefined);
    assert.equal(viewer(cookie(b), a), undefined);
  });

  it("accept a cookie without a tenant only while exactly one tenant exists", () => {
    registerTenants(a, a);
    assert.equal(viewer(cookie(), a), "viewer@example.test");
    registerTenants(a, undefined);
    assert.equal(viewer(cookie(), a), undefined);
    assert.equal(viewer(cookie(), b), undefined);
  });
});
