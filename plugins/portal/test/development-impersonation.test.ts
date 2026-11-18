import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { developmentImpersonation } from "../src/development-impersonation.ts";
import { deriveKey, seal, readCookie, openSession, impersonationFor, type SessionClaims } from "../src/session.ts";

const clock = Date.UTC(2026, 10, 17);
const key = deriveKey("development-impersonation-fixture-key", "fixture");
const original: SessionClaims = {
  k: "session",
  sub: "admin",
  org: "acme",
  iat: clock / 1000,
  exp: clock / 1000 + 3600,
};
const sessionCookie = `portal_session=${seal(original, key)}`;

test("development panes keep independent impersonation using HttpOnly cookies and retain the original actor", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  let enabled = true;
  let admin = true;
  const actions: Array<{ action: string; actor: string; target: string }> = [];
  const server = createServer(async (req, res) => {
    const session = openSession(readCookie(req.headers.cookie, "portal_session"), key, Date.now());
    const handled = await developmentImpersonation({
      req,
      res,
      url: new URL(req.url!, "http://portal.test"),
      session,
      enabled,
      allowedOrigin: req.headers.origin === "https://sheets.example.test",
      key,
      secure: false,
      ttlSeconds: 60,
      isAdmin: async () => admin,
      canonical: async (target) => (["alice", "bob"].includes(target) ? target : null),
      impersonate: async (action, actor, target) => {
        actions.push({ action, actor: actor.sub, target });
        return { ok: true, status: 200 };
      },
    });
    if (handled) return;
    const selected = session && impersonationFor(session, req.headers.cookie, key, Date.now());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ user: selected?.target ?? session?.sub, impersonatedBy: selected?.actor ?? null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jar = new Map<string, string>();
  const send = async (
    view: string,
    target?: string,
    options: { read?: boolean; active?: boolean; origin?: string; cookie?: string; driver?: string } = {},
  ) => {
    const params = new URLSearchParams({ development_view: view });
    if (target) params.set("target", target);
    if (options.driver) params.set("driver", options.driver);
    if (options.active) params.set("development_impersonating", "1");
    const path = options.read ? "/me" : "/api/development/impersonation";
    const response = await fetch(`${base}${path}?${params}`, {
      method: options.read ? "GET" : "POST",
      headers: {
        origin: options.origin ?? "https://sheets.example.test",
        cookie: options.cookie ?? [sessionCookie, ...jar.values()].join("; "),
      },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const name = pair.slice(0, pair.indexOf("="));
      if (cookie.includes("Max-Age=0")) jar.delete(name);
      else jar.set(name, pair);
      assert.match(cookie, /HttpOnly/);
      assert.ok(name.startsWith("portal_development_"));
    }
    return response;
  };
  assert.equal((await send("view-a", "alice")).status, 200);
  assert.equal((await send("view-b", "bob")).status, 200);
  assert.equal(jar.size, 2);
  assert.deepEqual(await (await send("view-a", undefined, { read: true, active: true })).json(), {
    user: "alice",
    impersonatedBy: "admin",
  });
  assert.deepEqual(await (await send("view-b", undefined, { read: true, active: true })).json(), {
    user: "bob",
    impersonatedBy: "admin",
  });
  assert.deepEqual(await (await send("view-a", undefined, { read: true })).json(), {
    user: "admin",
    impersonatedBy: null,
  });
  assert.equal((await send("view-a")).status, 200);
  assert.equal(jar.size, 1);
  assert.deepEqual(await (await send("view-b", undefined, { read: true, active: true })).json(), {
    user: "bob",
    impersonatedBy: "admin",
  });
  assert.equal((await send("view-a", "alice", { origin: "https://stranger.example.test" })).status, 403);
  assert.equal((await send("view-a", "alice", { driver: "someone-else" })).status, 409);
  admin = false;
  assert.equal((await send("view-a", "alice")).status, 403);
  admin = true;
  enabled = false;
  assert.equal((await send("view-a", "alice")).status, 404);
  enabled = true;
  assert.equal((await send("view-a", "unknown")).status, 400);
  t.mock.timers.tick(61_000);
  assert.equal((await send("view-b", undefined, { read: true, active: true })).status, 401);
  assert.equal(
    (await send("view-b", undefined, { read: true, active: true, cookie: [...jar.values()].join("; ") })).status,
    401,
  );
  assert.deepEqual(actions, [
    { action: "start", actor: "admin", target: "alice" },
    { action: "start", actor: "admin", target: "bob" },
    { action: "stop", actor: "admin", target: "alice" },
  ]);
});
