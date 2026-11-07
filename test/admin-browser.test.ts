import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { apiAlias } from "../src/api/browser-session.ts";
import { apiRoutes } from "../src/api/routes/index.ts";
import { createServer } from "../src/api/server.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const ADMIN_PAGES = [
  "GET /v1/connectors/catalog",
  "GET /v1/admin/ack-emoji-picks",
  "GET /v1/admin/ambient-judgments",
  "GET /v1/admin/audit",
  "GET /v1/admin/crons",
  "PUT /v1/admin/crons/:id/destination",
  "PUT /v1/admin/crons/:id/runtime",
  "GET /v1/admin/custom-providers",
  "PUT /v1/admin/custom-providers/:provider",
  "DELETE /v1/admin/custom-providers/:provider",
  "GET /v1/admin/deployments",
  "GET /v1/admin/directory",
  "GET /v1/admin/egress",
  "GET /v1/admin/errors",
  "POST /v1/admin/external-users",
  "DELETE /v1/admin/external-users/:email",
  "GET /v1/admin/files",
  "GET /v1/admin/files/download",
  "GET /v1/admin/files/read",
  "POST /v1/admin/grants",
  "DELETE /v1/admin/grants/:principalId",
  "GET /v1/admin/keychain",
  "GET /v1/admin/mcp-servers",
  "PUT /v1/admin/mcp-servers/:id",
  "DELETE /v1/admin/mcp-servers/:id",
  "GET /v1/admin/memory",
  "POST /v1/admin/memory",
  "PATCH /v1/admin/memory",
  "DELETE /v1/admin/memory",
  "GET /v1/admin/memory/scopes",
  "GET /v1/admin/model-providers",
  "PUT /v1/admin/model-providers/:provider",
  "DELETE /v1/admin/model-providers/:provider",
  "GET /v1/admin/model-registry",
  "POST /v1/admin/model-registry/lookup",
  "PUT /v1/admin/model-registry/:model",
  "DELETE /v1/admin/model-registry/:model",
  "POST /v1/admin/model-registry/:model/enable",
  "GET /v1/admin/principal-links",
  "POST /v1/admin/principal-links",
  "DELETE /v1/admin/principal-links/:principalId",
  "GET /v1/admin/resources",
  "GET /v1/admin/retention",
  "GET /v1/admin/scopes",
  "GET /v1/admin/scopes/:scope",
  "GET /v1/admin/scopes/:scope/credential-usage",
  "PUT /v1/admin/scopes/:scope/:resource",
  "GET /v1/admin/sessions",
  "GET /v1/admin/sessions/:id",
  "GET /v1/admin/sessions/:id/llm",
  "GET /v1/admin/skill-packs",
  "POST /v1/admin/skill-packs",
  "PATCH /v1/admin/skill-packs/:id",
  "DELETE /v1/admin/skill-packs/:id",
  "GET /v1/admin/skill-packs/:id/catalog",
  "POST /v1/admin/skill-packs/:id/import",
  "POST /v1/admin/skill-packs/:id/sync",
  "GET /v1/admin/skills",
  "GET /v1/admin/skills/:id",
  "DELETE /v1/admin/skills/:id",
  "GET /v1/admin/slack-emoji",
  "GET /v1/admin/slack-installation",
  "PUT /v1/admin/slack-installation",
  "DELETE /v1/admin/slack-installation",
  "POST /v1/admin/slack-installation/start",
  "GET /v1/admin/slack-mirror",
  "GET /v1/admin/slack-mirror/messages",
  "GET /v1/admin/spend",
  "GET /v1/admin/users",
  "POST /v1/admin/users/invite",
  "GET /v1/admin/users/:principalId",
  "POST /v1/admin/users/:principalId/offboard",
  "PUT /v1/admin/users/:principalId/onboarding",
  "POST /v1/admin/users/:principalId/reactivate",
  "POST /v1/admin/users/:principalId/reset",
  "GET /v1/admin/whoami",
];

const NOT_ADMIN_PAGES = [
  "GET /v1/admin/deliveries/shadow",
  "POST /v1/admin/files/upload",
  "POST /v1/admin/impersonate",
  "POST /v1/admin/impersonate/stop",
  "GET /v1/admin/sandboxes/:scopeId",
  "POST /v1/admin/sandboxes/:scopeId",
  "GET /v1/admin/security/flags",
  "GET /v1/admin/unattended-grants",
];

const concrete = (path: string): string => path.replaceAll(/:[a-zA-Z]+/g, "x");
const browserPath = (path: string): string =>
  path === "/v1/connectors/catalog" ? "/api/admin/connector-catalog" : path.replace("/v1/admin/", "/api/admin/");

test("the browser reaches exactly the admin routes the admin pages use, and only while not impersonating", () => {
  const admin = apiRoutes.flatMap((route) =>
    "path" in route && (route.path.startsWith("/v1/admin/") || route.path === "/v1/connectors/catalog")
      ? [{ key: `${route.method} ${route.path}`, browser: route.browser }]
      : [],
  );
  assert.deepEqual(
    admin
      .filter((r) => r.browser)
      .map((r) => r.key)
      .sort(),
    [...ADMIN_PAGES].sort(),
  );
  assert.deepEqual(
    admin
      .filter((r) => !r.browser)
      .map((r) => r.key)
      .sort(),
    [...NOT_ADMIN_PAGES].sort(),
  );
  assert.ok(admin.filter((r) => r.browser).every((r) => r.browser === "self"));
  for (const route of apiRoutes)
    if (route.admin) assert.ok("path" in route && route.path.startsWith("/v1/admin/"), "admin metadata off /v1/admin");
  for (const key of ADMIN_PAGES) {
    const [method, path] = key.split(" ") as [string, string];
    assert.equal(apiAlias(method, concrete(browserPath(path))), concrete(path), key);
  }
  for (const key of NOT_ADMIN_PAGES) {
    const [method, path] = key.split(" ") as [string, string];
    assert.equal(apiAlias(method, concrete(browserPath(path))), null, key);
  }
});

async function serve(t: TestContext) {
  const config = testConfig({ signingSecret: "admin-browser-signing-secret-0123456789" });
  const built = stopAtEnd(buildApp(config));
  const server = createServer(built.app, { ...serverDeps(config, built), ...browserSessionDeps });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (cookie: string, method: string, path: string, body?: unknown, origin = browserSessionDeps.portalUrl) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

test("an admin's cookie works the admin pages, naming other people as the subject", async (t) => {
  const call = await serve(t);
  const admin = browserSessionCookie("admin-alice");
  const whoami = await call(admin, "GET", "/api/admin/whoami");
  assert.equal(whoami.status, 200);
  assert.equal(((await whoami.json()) as { isAdmin?: boolean }).isAdmin, true);
  assert.equal((await call(admin, "GET", "/api/admin/scopes")).status, 200);
  assert.equal((await call(admin, "GET", "/api/admin/connector-catalog")).status, 200);
  const grant = { principalId: "carol", role: "org_admin", scopeId: "org:default-org" };
  const granted = await call(admin, "POST", "/api/admin/grants", grant);
  assert.equal(granted.status, 200, await granted.clone().text());
  const revoked = await call(admin, "DELETE", "/api/admin/grants/carol?scope=org%3Adefault-org&role=org_admin");
  assert.equal(revoked.status, 200, await revoked.clone().text());
  const member = browserSessionCookie("alice");
  assert.equal((await call(member, "GET", "/api/admin/scopes")).status, 403);
  assert.equal((await call(member, "POST", "/api/admin/grants", grant)).status, 403);
  assert.equal((await call("", "GET", "/api/admin/scopes")).status, 401);
});

test("every admin page refuses an impersonating admin, even when the target is an admin, and foreign-origin writes", async (t) => {
  const call = await serve(t);
  const admin = browserSessionCookie("admin-alice");
  const impersonating = `${admin}; ${browserImpersonationCookie("admin-alice", "admin-bob")}`;
  for (const key of ADMIN_PAGES) {
    const [method, path] = key.split(" ") as [string, string];
    const body = method === "GET" ? undefined : {};
    for (const url of [concrete(browserPath(path)), concrete(path)]) {
      const refused = await call(impersonating, method, url, body);
      assert.deepEqual(
        [refused.status, await refused.json()],
        [403, { error: "forbidden", message: "Unavailable while impersonating." }],
        `${method} ${url}`,
      );
    }
    if (method === "GET") continue;
    const foreign = await call(admin, method, concrete(browserPath(path)), body, "https://evil.example");
    assert.deepEqual(
      [foreign.status, ((await foreign.json()) as { message?: string }).message],
      [403, "cross-origin request refused"],
      key,
    );
  }
});

test("admin routes the pages never used stay unreachable from a cookie", async (t) => {
  const call = await serve(t);
  const admin = browserSessionCookie("admin-alice");
  for (const key of NOT_ADMIN_PAGES) {
    const [method, path] = key.split(" ") as [string, string];
    const direct = await call(admin, method, concrete(path), method === "GET" ? undefined : {});
    assert.equal(direct.status, 401, key);
  }
});
