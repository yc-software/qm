import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { buildApp } from "../src/wiring.ts";
import { fetchCoreText, signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { sessionNavigationRoutes } from "../src/api/routes/session-navigation.ts";
import { testConfig } from "./support/test-config.ts";

const SOURCE = "navigation-source-auth-secret-00000000000001";
const PORTAL = "navigation-portal-identity-secret-0000000001";
const CAPABILITY = "navigation-core-capability-secret-000000001";

test("navigation POSTs bind their body principal to the signed portal identity before App work", async (t) => {
  const built = buildApp(testConfig());
  const server = createServer(built.app, {
    signingSecret: SOURCE,
    portalIdentitySecret: PORTAL,
    capabilitySecret: CAPABILITY,
    requireSignedPortalIdentity: true,
    identity: built.identity,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  let calls = 0;
  for (const method of ["sessionNavigation", "sessionPage", "resolveSessions"] as const) {
    const original = built.app[method].bind(built.app);
    t.mock.method(built.app, method, async (...args: never[]) => {
      calls++;
      return (original as (...args: never[]) => Promise<unknown>)(...args);
    });
  }
  const token = await mintPortalIdentity({ p: "U1", exp: Date.now() + 60_000 }, PORTAL);
  const read = (path: string, body: unknown, identity?: string) =>
    fetchCoreText({
      origin,
      secret: SOURCE,
      method: "POST",
      path,
      body: JSON.stringify(body),
      headers: identity ? { "x-portal-identity": identity } : {},
    });
  try {
    for (const route of sessionNavigationRoutes) {
      assert.equal(route.auth, "source");
      assert.ok("path" in route);
      const path = route.path;
      const body = { principalId: "U1", ...(path.endsWith("/resolve") ? { references: [] } : {}) };
      const previous = calls;
      assert.equal((await read(path, body)).status, 401);
      assert.equal((await read(path, { ...body, principalId: "U2" }, token)).status, 403);
      assert.equal(
        (await read(path, body, await mintPortalIdentity({ p: "U1", exp: Date.now() + 60_000 }, SOURCE))).status,
        401,
      );
      const unsigned = await fetch(origin + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-portal-identity": token },
        body: JSON.stringify(body),
      });
      assert.equal(unsigned.status, 401);
      assert.equal(calls, previous);
      const accepted = await read(path, body, token);
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(calls, previous + 1);
    }
    const missing = await read(
      "/v1/session-navigation/resolve",
      { principalId: "U1", references: [{ kind: "thread", value: "unknown" }] },
      token,
    );
    assert.equal(missing.status, 200);
    assert.equal(JSON.parse(missing.text).references[0].session, null);
    const unknownPath = "/v1/session-navigation/unsupported";
    const unknown = await read(unknownPath, { principalId: "U1" }, token);
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.text), { error: "not_found", message: `POST ${unknownPath}` });
    const originalPath = "/v1/sessions?principalId=U1";
    const legacy = await fetch(origin + originalPath, {
      headers: { ...signedHeaders(SOURCE, "GET", originalPath), "x-portal-identity": token },
    });
    assert.equal(legacy.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("navigation validates bounded inputs and filter cursors before enumeration", async (t) => {
  const built = buildApp(testConfig());
  const server = createServer(built.app, { signingSecret: SOURCE });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  let calls = 0;
  t.mock.method(built.sessions, "listByParticipant", async () => {
    calls++;
    return [];
  });
  t.mock.method(built.sessions, "sessionsByThreadRefs", async () => {
    calls++;
    return [];
  });
  try {
    const invalid: [string, unknown][] = [
      ["", null],
      ["", []],
      ["", {}],
      ["", { principalId: "" }],
      ["", { principalId: "x".repeat(513) }],
      ["", { principalId: "U1", surface: "slack" }],
      ["", { principalId: "U1", limit: 5000 }],
      ["", { principalId: "U1", cursor: "bad" }],
      ["", { principalId: "U1", section: "groups", cursor: "bad" }],
      ["", { principalId: "U1", references: Array(13).fill({ kind: "id", value: "same" }) }],
      ["/resolve", { principalId: "U1", references: [{ kind: "scope", value: "personal:U1" }] }],
      ["/resolve", { principalId: "U1", references: [{ kind: "id", value: "x".repeat(513) }] }],
      ["/resolve", { principalId: "U1", references: [{ kind: "thread", value: "x".repeat(2049) }] }],
      ["/resolve", { principalId: "U1", references: [{ kind: "id", value: "a", scopeId: "personal:U1" }] }],
      ["/page", { principalId: "U1", children: "true" }],
      ...[null, true, "", "x".repeat(513)].map(
        (parentSessionId) => ["/page", { principalId: "U1", children: true, parentSessionId }] as [string, unknown],
      ),
      ["/page", { principalId: "U1", parentSessionId: "root" }],
      ["/page", { principalId: "U1", parentSessionId: "root", children: false }],
      ["/page", { principalId: "U1", actionable: true }],
      ["/page", { principalId: "U1", actionable: true, children: true }],
      ["/page", { principalId: "U1", actionable: true, parentSessionId: "root", children: false }],
      ["/page", { principalId: "U1", actionable: "true", parentSessionId: "root", children: true }],
      ["/page", { principalId: "U1", actionable: true, cursor: "bad" }],
      ["/page", { principalId: "U1", pinned: 1 }],
      ["/page", { principalId: "U1", archived: "false" }],
      ["/page", { principalId: "U1", query: "x".repeat(513) }],
      ["/page", { principalId: "U1", title: "x".repeat(513) }],
      ["/page", { principalId: "U1", title: "" }],
      ["/page", { principalId: "U1", title: 1 }],
      ["/page", { principalId: "U1", status: "running" }],
      ["/page", { principalId: "U1", scopeId: "" }],
      ["/page", { principalId: "U1", cursor: "x".repeat(4097) }],
    ];
    for (const [suffix, body] of invalid) {
      const response = await fetchCoreText({
        origin,
        secret: SOURCE,
        method: "POST",
        path: `/v1/session-navigation${suffix}`,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, `${suffix} ${JSON.stringify(body).slice(0, 100)}: ${response.text}`);
    }
    assert.equal(calls, 0);
    for (const suffix of ["", "/page"]) {
      const response = await fetchCoreText({
        origin,
        secret: SOURCE,
        method: "POST",
        path: `/v1/session-navigation${suffix}`,
        body: JSON.stringify({ principalId: "U1" }),
      });
      assert.equal(response.status, 200, response.text);
    }
    assert.equal(calls, 2);
    const descendants = await fetchCoreText({
      origin,
      secret: SOURCE,
      method: "POST",
      path: "/v1/session-navigation/page",
      body: JSON.stringify({ principalId: "U1", parentSessionId: "missing", children: true }),
    });
    assert.equal(descendants.status, 200, descendants.text);
    assert.equal(JSON.parse(descendants.text).total, 0);
    assert.equal(calls, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("closing a finite navigation request aborts its App signal without changing mutation routes", async (t) => {
  const built = buildApp(testConfig());
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  t.mock.method(built.app, "sessionPage", async (_principal: string, _request: unknown, signal?: AbortSignal) => {
    assert.ok(signal);
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
          resolve();
        },
        { once: true },
      ),
    );
    return {
      items: [],
      total: 0,
      nextCursor: null,
      contexts: [],
      statusTotals: { active: 0, waiting: 0, archived: 0 },
    };
  });
  const server = createServer(built.app, { signingSecret: SOURCE });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  try {
    const pending = fetchCoreText({
      origin,
      secret: SOURCE,
      method: "POST",
      path: "/v1/session-navigation/page",
      body: JSON.stringify({ principalId: "U1" }),
      signal: controller.signal,
    });
    const refused = assert.rejects(pending, { name: "AbortError" });
    await entered.promise;
    controller.abort();
    await refused;
    await cancelled.promise;
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("all finite navigation handlers refuse already closed responses without App work or listeners", async () => {
  for (const closed of [
    { destroyed: true, writableEnded: false },
    { destroyed: false, writableEnded: true },
  ]) {
    for (const route of sessionNavigationRoutes) {
      let appCalls = 0;
      const fail = async () => {
        appCalls++;
        throw new Error("already closed response reached App");
      };
      const res = Object.assign(new EventEmitter(), closed);
      const ctx = {
        body: { principalId: "U1", references: [] },
        res,
        app: { sessionNavigation: fail, sessionPage: fail, resolveSessions: fail },
      } as unknown as ApiCtx;
      await route.handle(ctx);
      assert.equal(appCalls, 0);
      assert.equal(res.listenerCount("close"), 0);
    }
  }
});
