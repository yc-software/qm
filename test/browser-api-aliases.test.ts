import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { API_ALIASES, apiAlias } from "../src/api/browser-session.ts";
import { apiRoutes } from "../src/api/routes/index.ts";
import { findRoute } from "../src/api/routes/route.ts";
import { createServer } from "../src/api/server.ts";
import { startQm } from "../src/start.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const SIGNING = "browser-alias-signing-secret-0123456789";
const PORTAL_IDENTITY = "browser-alias-identity-secret-0123456789";
const QUERY: Record<string, string> = {
  "/api/ui-state": "key=sidebar",
  "/api/scope-resources": "scope=personal:alice",
};

const concrete = (pattern: string): string => pattern.replaceAll(/:[a-z]+/g, "1");

const aliases = [...API_ALIASES].map(([key, target]) => {
  const [method, path] = key.split(" ", 2) as [string, string];
  return { method, path, target };
});

async function freePort(): Promise<number> {
  const probe = createNetServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => probe.once("listening", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function core(t: TestContext): Promise<string> {
  const config = testConfig({ signingSecret: SIGNING, publicWebUrl: "https://qm.example.com" });
  const built = stopAtEnd(buildApp(config));
  const server = createServer(built.app, { ...serverDeps(config, built), ...browserSessionDeps });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("each aliased /api path resolves to the browser-enabled /v1 route that serves it", () => {
  for (const { method, path, target } of aliases) {
    const resolved = apiAlias(method, concrete(path));
    assert.equal(resolved, concrete(target), path);
    const route = findRoute(apiRoutes, method, resolved!)?.route;
    assert.equal(route?.browser, true, path);
    assert.equal(route, findRoute(apiRoutes, method, concrete(target))?.route, path);
  }
  assert.equal(apiAlias("GET", "/api/sessions/a%2Fb/children"), "/v1/sessions/a%2Fb/children");
  for (const [method, path] of [
    ["POST", "/api/sessions"],
    ["GET", "/api/inbox"],
    ["GET", "/api/loops/1/items"],
    ["GET", "/api/files/1/content"],
    ["GET", "/v1/sessions"],
  ] as const)
    assert.equal(apiAlias(method, path), null, `${method} ${path}`);
});

test("each aliased path answers a cookie-only browser exactly as its /v1 route does, bound to the signed-in person", async (t) => {
  const base = await core(t);
  const cookie = browserSessionCookie("alice");
  for (const { path, target } of aliases) {
    const query = QUERY[path] ?? "";
    const viaAlias = await fetch(`${base}${concrete(path)}?${query}`, { headers: { cookie } });
    const direct = await fetch(`${base}${concrete(target)}?${query}`, { headers: { cookie } });
    assert.ok(viaAlias.status < 500 && ![401, 403].includes(viaAlias.status), `${path} answered ${viaAlias.status}`);
    assert.equal(viaAlias.status, direct.status, path);
    assert.deepEqual(await viaAlias.json(), await direct.json(), path);
    const other = await fetch(`${base}${concrete(path)}?${query}&principalId=bob&viewer=bob`, { headers: { cookie } });
    assert.equal(other.status, 403, `${path} let alice name bob`);
    const anonymous = await fetch(`${base}${concrete(path)}?${query}`);
    assert.equal(anonymous.status, 401, `${path} answered without a cookie`);
  }
});

test("a web release still calling /api reaches core for migrated reads and the web server for the rest", async (t) => {
  const [port, publicPort] = await Promise.all([freePort(), freePort()]);
  const publicWebUrl = `http://127.0.0.1:${publicPort}`;
  Object.assign(process.env, {
    PUBLIC_WEB_URL: publicWebUrl,
    PORTAL_SESSION_SECRET: browserSessionDeps.portalSession.secret,
    CORE_SIGNING_SECRET: SIGNING,
    PORTAL_IDENTITY_SECRET: PORTAL_IDENTITY,
  });
  const qm = await startQm(
    testConfig({ port, publicPort, publicWebUrl, signingSecret: SIGNING, portalIdentitySecret: PORTAL_IDENTITY }),
    { agent: createMockAgent(), env: process.env },
  );
  t.after(() => qm.stop());
  const cookie = browserSessionCookie("alice");
  const read = (url: string) => fetch(url, { headers: { cookie } });
  const migrated = await read(`${publicWebUrl}/api/sessions`);
  assert.equal(migrated.status, 200);
  assert.ok(Array.isArray(((await migrated.json()) as { sessions?: unknown }).sessions));
  const relayed = await read(`${publicWebUrl}/api/crons`);
  assert.equal(relayed.status, 200);
  assert.deepEqual(Object.keys((await relayed.json()) as object).sort(), ["crons", "visible"]);
  assert.equal((await read(`${publicWebUrl}/v1/sessions`)).status, 404);
  assert.equal((await read(`http://127.0.0.1:${port}/api/sessions`)).status, 200);
});
