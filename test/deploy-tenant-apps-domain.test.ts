import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { appsDomainOf, appUrlOf, parseTenantAppHost, webUrlBase } from "../src/deploy/apps-domain.ts";
import { deploySettings } from "../src/deploy/deploy-settings.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { configureTenantSettings, tenantSettings } from "../src/tenants/settings.ts";
import type { Tenancy } from "../src/tenants/tenancy.ts";

const SESSION_SECRET = "tenant-apps-session-secret";
const A = randomUUID();
const B = randomUUID();
const webUrls: Record<string, string> = { [A]: "https://a.example.test", [B]: "https://b.example.test" };
const hostTenants: Record<string, string> = {
  "a.example.test": A,
  "b.example.test": B,
  "b-alias.example.test": B,
};
configureTenantSettings(async (tenant) => (webUrls[tenant] ? { env: { PUBLIC_WEB_URL: webUrls[tenant] } } : {}));

const tenancy = {
  hostTenant: async (host: string) => ({ ...(hostTenants[host] ? { tenant: hostTenants[host] } : {}), multi: true }),
  multi: async () => true,
  rowTenant: async () => undefined,
} as unknown as Tenancy;

function session(sub: string, tenant: string): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 600, t: tenant }),
  ).toString("base64url");
  return `portal_session=${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function get(
  port: number,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "localhost", port, path: "/page?x=1", headers: { Host: host, "x-qm-app-host": "1", ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location as string }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withGateway(fn: (port: number, seen: string[]) => Promise<void>): Promise<void> {
  const seen: string[] = [];
  const app = {
    getDeployment: async (name: string) => {
      seen.push(`get:${boundTenant()}:${name}`);
      return null;
    },
    canManageDeployment: async () => false,
    reachDeployment: async (name: string) => {
      seen.push(`reach:${boundTenant()}:${name}`);
      return { status: "not_found" };
    },
  };
  const server = createInsecureTestServer(app as unknown as Parameters<typeof createInsecureTestServer>[0], {
    tenancy,
    deployAppsTenantSubdomain: "apps",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginPath: "/auth/trusted/login",
  });
  server.listen(0);
  try {
    await fn((server.address() as AddressInfo).port, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("an app host binds the tenant that owns the host and signs in on that tenant's own web host", async () => {
  await withGateway(async (port, seen) => {
    const res = await get(port, "notes.apps.a.example.test", { Accept: "text/html" });
    assert.equal(res.status, 302);
    const signIn = new URL(res.location!);
    assert.equal(signIn.origin, "https://a.example.test");
    assert.equal(signIn.pathname, "/auth/trusted/login");
    assert.equal(signIn.searchParams.get("returnTo"), "https://notes.apps.a.example.test/page?x=1&dpl_signin=1");
    assert.deepEqual(seen, [`get:${A}:notes`]);
  });
});

test("a signed-in viewer reaches only the app of that name inside the host's tenant", async () => {
  await withGateway(async (port, seen) => {
    const res = await get(port, "notes.apps.b.example.test", { cookie: session("bo@example.test", B) });
    assert.equal(res.status, 404);
    assert.deepEqual(seen, [`get:${B}:notes`, `reach:${B}:notes`]);
  });
});

test("another tenant's session is signed out on this tenant's app host", async () => {
  await withGateway(async (port, seen) => {
    const res = await get(port, "notes.apps.a.example.test", {
      Accept: "text/html",
      cookie: session("bo@example.test", B),
    });
    assert.equal(res.status, 302);
    assert.equal(new URL(res.location!).origin, "https://a.example.test");
    assert.ok(!seen.some((s) => s.startsWith("reach:")));
  });
});

test("app hosts under unknown tenants, or a tenant's non-canonical host, are not found", async () => {
  await withGateway(async (port, seen) => {
    assert.equal((await get(port, "notes.apps.unknown.example.test")).status, 404);
    assert.equal((await get(port, "notes.apps.b-alias.example.test")).status, 404);
    assert.equal((await get(port, "notes.other.a.example.test")).status, 404);
    assert.deepEqual(seen, []);
  });
});

test("tenant apps domains and links derive from the tenant's own web address", async () => {
  const deps = { deployAppsTenantSubdomain: "apps" };
  assert.equal(appsDomainOf(deps), undefined, "no tenant bound, no apps domain");
  await withTenant(A, async () => {
    await tenantSettings();
    assert.equal(appsDomainOf(deps), "apps.a.example.test");
    assert.equal(appUrlOf(deps, "notes"), "https://notes.apps.a.example.test/");
    assert.equal(appUrlOf(deps, "Not_A_Label"), undefined);
    assert.equal(webUrlBase("https://mt.example.test/"), "https://a.example.test");
    assert.equal(appsDomainOf({ ...deps, deployAppsDomain: "apps.fixed.test" }), "apps.fixed.test");
  });
  assert.equal(webUrlBase("https://mt.example.test/"), "https://mt.example.test");
  assert.deepEqual(parseTenantAppHost("notes.apps.a.example.test", "apps"), {
    app: "notes",
    tenantHost: "a.example.test",
  });
  assert.equal(parseTenantAppHost("apps.a.example.test", "apps"), undefined);
  assert.equal(parseTenantAppHost("x.y.apps.a.example.test", "apps"), undefined);
});

test("DEPLOY_APPS_TENANT_SUBDOMAIN is one label and excludes a deployment-wide apps domain", () => {
  assert.equal(deploySettings({ DEPLOY_APPS_TENANT_SUBDOMAIN: "Apps" }, undefined).deployAppsTenantSubdomain, "apps");
  assert.throws(() => deploySettings({ DEPLOY_APPS_TENANT_SUBDOMAIN: "apps.x" }, undefined), /one DNS label/);
  assert.throws(
    () => deploySettings({ DEPLOY_APPS_TENANT_SUBDOMAIN: "apps", DEPLOY_APPS_DOMAIN: "apps.example.com" }, undefined),
    /cannot be combined/,
  );
});
