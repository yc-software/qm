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

const HANDLER_REFUSALS: Record<string, unknown> = {
  "/api/sessions/:id/swarm": { error: "session access denied" },
  ...Object.fromEntries(
    ["/api/composio/callback", "/api/composio/slack", "/api/composio/toolkits", "/api/composio/connections"].map(
      (path) => [
        path,
        {
          error: "composio_unavailable",
          message: "App connections aren’t available for your account yet. Ask your administrator to enable them.",
        },
      ],
    ),
  ),
};

const concrete = (pattern: string): string => pattern.replaceAll(/:[a-z]+/g, "1");

const aliases = [...API_ALIASES]
  .map(([key, target]) => {
    const [method, path] = key.split(" ", 2) as [string, string];
    return { method, path, target };
  })
  .filter(({ path }) => !path.startsWith("/api/admin/"))
  .filter(({ method, target }) => findRoute(apiRoutes, method, concrete(target))?.route.auth !== "public");

async function freePort(): Promise<number> {
  const probe = createNetServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => probe.once("listening", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function core(t: TestContext, onBuilt: (built: ReturnType<typeof buildApp>) => void = () => {}): Promise<string> {
  const config = testConfig({ signingSecret: SIGNING, publicWebUrl: "https://qm.example.com" });
  const built = stopAtEnd(buildApp(config));
  onBuilt(built);
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
    assert.ok(route?.browser, path);
    assert.equal(route, findRoute(apiRoutes, method, concrete(target))?.route, path);
  }
  assert.equal(apiAlias("GET", "/api/sessions/a%2Fb/children"), "/v1/sessions/a%2Fb/children");
  for (const [method, path] of [
    ["GET", "/api/turn"],
    ["POST", "/api/approvals/1/2"],
    ["POST", "/api/crons"],
    ["POST", "/api/webhooks/1/update"],
    ["PUT", "/api/inbox"],
    ["DELETE", "/api/loops/1/grants/2"],
    ["GET", "/v1/sessions"],
  ] as const)
    assert.equal(apiAlias(method, path), null, `${method} ${path}`);
});

test("each aliased path answers a cookie-only browser exactly as its /v1 route does, bound to the signed-in person", async (t) => {
  let flags: ReturnType<typeof buildApp>["featureFlags"] | undefined;
  const base = await core(t, (built) => {
    flags = built.featureFlags;
  });
  await flags!.setEnabled("inbox_loops", "personal:alice", true, "test");
  await flags!.setEnabled("agent_seat", "personal:alice", true, "test");
  const cookie = browserSessionCookie("alice");
  for (const { path, target } of aliases.filter(({ method }) => method === "GET")) {
    const query = QUERY[path] ?? "";
    const viaAlias = await fetch(`${base}${concrete(path)}?${query}`, { headers: { cookie } });
    const direct = await fetch(`${base}${concrete(target)}?${query}`, { headers: { cookie } });
    const answered = await viaAlias.json();
    const expected = HANDLER_REFUSALS[path];
    if (expected) assert.deepEqual([viaAlias.status, answered], [403, expected], path);
    else
      assert.ok(viaAlias.status < 500 && ![401, 403].includes(viaAlias.status), `${path} answered ${viaAlias.status}`);
    assert.equal(viaAlias.status, direct.status, path);
    assert.deepEqual(answered, await direct.json(), path);
    const actor = findRoute(apiRoutes, "GET", concrete(target))?.route.actor ?? "";
    const field = actor.startsWith("query.") ? actor.slice("query.".length) : "principalId";
    const other = await fetch(`${base}${concrete(path)}?${query}&${field}=bob`, { headers: { cookie } });
    assert.equal(other.status, 403, `${path} let alice name bob as ${field}`);
    const anonymous = await fetch(`${base}${concrete(path)}?${query}`);
    assert.equal(anonymous.status, 401, `${path} answered without a cookie`);
  }
});

const GATE_REFUSALS = new Set(["portal identity does not match the requested actor", "cross-origin request refused"]);

async function refusal(response: Response): Promise<string> {
  const text = await response.text();
  try {
    return (JSON.parse(text) as { message?: string }).message ?? "";
  } catch {
    return "";
  }
}

test("each aliased write reaches its handler only for the signed-in person on the app's own origin", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    new URL(input instanceof Request ? input.url : String(input)).hostname === "127.0.0.1"
      ? realFetch(input, init)
      : Promise.reject(new Error("no outbound network in this test"));
  t.after(() => (globalThis.fetch = realFetch));
  const base = await core(t);
  const origin = browserSessionDeps.portalUrl;
  const send = (method: string, path: string, headers: Record<string, string>, body: Record<string, string> = {}) =>
    realFetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const writes = aliases.filter(({ method }) => method !== "GET");
  assert.ok(writes.length > 0);
  for (const { method, path, target } of writes) {
    const url = concrete(path);
    const actor = findRoute(apiRoutes, method, concrete(target))?.route.actor ?? "";
    const [where, field] = actor.includes(".") ? actor.split(".", 2) : ["body", "principalId"];
    const cookie = browserSessionCookie("alice");
    const own = await send(method, url, { cookie, origin });
    assert.ok(
      own.status !== 401 && !(own.status === 403 && GATE_REFUSALS.has(await refusal(own))),
      `${method} ${path} refused alice (${own.status})`,
    );
    const named =
      where === "query" || findRoute(apiRoutes, method, concrete(target))?.route.streamBody
        ? await send(method, `${url}?${where === "query" ? field : "principalId"}=bob`, { cookie, origin })
        : await send(method, url, { cookie, origin }, { [field!]: "bob" });
    assert.equal(named.status, 403, `${method} ${path} let alice name bob as ${actor || "principalId"}`);
    assert.equal(await refusal(named), "portal identity does not match the requested actor");
    const foreign = await send(method, url, { cookie, origin: "https://evil.example" });
    assert.equal(foreign.status, 403, `${method} ${path} accepted a cross-origin write`);
    assert.equal(await refusal(foreign), "cross-origin request refused");
    assert.equal((await send(method, url, { origin })).status, 401, `${method} ${path} answered without a cookie`);
  }
  for (const [method, path] of [
    ["PATCH", "/api/memory"],
    ["DELETE", "/api/memory"],
    ["POST", "/api/sessions/1"],
    ["POST", "/api/connectors/revoke"],
  ] as const) {
    const empty = await realFetch(`${base}${path}`, {
      method,
      headers: { cookie: browserSessionCookie("alice"), origin },
    });
    assert.equal(empty.status, 400, `${method} ${path} read an empty body as a change`);
  }
});

test("browser writes act as the signed-in person under their canonical id", async (t) => {
  let built!: ReturnType<typeof buildApp>;
  const base = await core(t, (b) => (built = b));
  const sub = "alice@example.com";
  const spelled = " ALICE@EXAMPLE.COM ";
  const cookie = browserSessionCookie(sub);
  const write = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: browserSessionDeps.portalUrl, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const created = await write("POST", "/api/projects", { name: "Launch", principalId: spelled });
  assert.equal(created.status, 201, sub);
  assert.equal(((await created.json()) as { project: { ownerId: string } }).project.ownerId, sub);
  const saved = await write("PUT", "/api/ui-state", { principalId: spelled, key: "sidebar", value: 1 });
  assert.equal(saved.status, 200, sub);
  const read = await fetch(`${base}/api/ui-state?key=sidebar`, { headers: { cookie } });
  assert.equal(((await read.json()) as { value?: unknown }).value, 1, sub);
  const pinned = await write("PUT", "/api/channel-header-pin", { on: false });
  assert.deepEqual(await pinned.json(), { scopeId: `personal:${sub}`, on: false, configured: false }, sub);
  const pin = await fetch(`${base}/api/channel-header-pin`, { headers: { cookie } });
  assert.equal(((await pin.json()) as { scopeId?: string }).scopeId, `personal:${sub}`, sub);
  assert.equal((await fetch(`${base}/api/runtime-config`, { headers: { cookie } })).status, 200, sub);
  const session = await built.sessions.getOrCreateByThread("web:alice:fork-me", "dm", "personal:alice@example.com");
  await built.sessions.addParticipant(session.id, "alice@example.com", "Fork me");
  const forked = await write("POST", `/api/sessions/${session.id}/fork`);
  assert.equal(forked.status, 200);
});

test("the public front door hands every browser request to core in-process", async (t) => {
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
  const crons = await read(`${publicWebUrl}/api/crons`);
  assert.equal(crons.status, 200);
  assert.deepEqual(Object.keys((await crons.json()) as object).sort(), ["crons", "visible"]);
  const unknown = await read(`${publicWebUrl}/api/not-a-route`);
  assert.deepEqual([unknown.status, await unknown.json()], [404, { error: "not found" }]);
  const sharePath = "/share/external/33333333-3333-4333-8333-333333333333";
  const [share, direct] = await Promise.all([
    fetch(`${publicWebUrl}${sharePath}`),
    fetch(`http://127.0.0.1:${port}${sharePath}`),
  ]);
  assert.deepEqual([share.status, await share.text()], [direct.status, await direct.text()]);
  const asset = await fetch(`${publicWebUrl}/assets/app.js`);
  assert.deepEqual([asset.status, await asset.json()], [404, { error: "not_found" }]);
  const internalShare = await fetch(`${publicWebUrl}/share/internal/33333333-3333-4333-8333-333333333333`);
  assert.equal(internalShare.status, 401);
  assert.equal((await read(`${publicWebUrl}/v1/sessions`)).status, 404);
  const stream = await read(`${publicWebUrl}/api/runs/missing/events`);
  assert.deepEqual([stream.status, await stream.json()], [404, { error: "not_found" }]);
  const write = (method: string, path: string, body = "{}") =>
    fetch(`${publicWebUrl}${path}`, {
      method,
      headers: { cookie, origin: publicWebUrl, "content-type": "application/json" },
      body,
    });
  const migratedWrite = await write("POST", "/api/projects");
  assert.equal(migratedWrite.status, 400);
  assert.equal(((await migratedWrite.json()) as { message?: string }).message, "principalId and name required");
  const webhook = await write("POST", "/api/webhooks", '{"verification":{}}');
  assert.equal(((await webhook.json()) as { message?: string }).message, "verification requires a scheme");
  assert.equal((await read(`http://127.0.0.1:${port}/api/sessions`)).status, 200);
});
