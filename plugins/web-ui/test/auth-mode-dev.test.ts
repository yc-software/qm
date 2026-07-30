import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
delete process.env.CORE_SIGNING_SECRET;
delete process.env.PORTAL_IDENTITY_SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

const signin = (user: unknown) =>
  fetch(`${base}/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user }),
  });

test.after(() => {
  surface.close();
  core.close();
});

test("with no signing secret the surface advertises dev mode", async () => {
  const r = await fetch(`${base}/me`);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "sign in", mode: "dev", reason: "unauthenticated" });
});

test("a bare principal id — not just an email — can sign in", async () => {
  const r = await signin("alice");
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /webuiuser=alice/);

  const me = await fetch(`${base}/me`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user, "alice");
  assert.equal(body.mode, "dev");
});

test("a principal outside the allowlist is refused with a message naming the env var", async () => {
  const r = await signin("mallory");
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.error, "not_allowed");
  assert.match(body.message, /WEB_UI_PRINCIPALS/);
  assert.match(body.message, /mallory/);
});

test("an empty principal is a 400 with guidance, distinct from being refused", async () => {
  const r = await signin("");
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "bad_request");
  assert.match(body.message, /Enter a principal/);
});

test("an over-long principal is truncated in the echoed error", async () => {
  const r = await signin("z".repeat(500));
  assert.equal(r.status, 403);
  assert.ok(((await r.json()).message as string).length < 400);
});
