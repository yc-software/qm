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
  assert.deepEqual(await r.json(), { error: "sign in", mode: "dev" });
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
  assert.equal(body.suggestedActivities, undefined);
  assert.equal(body.mode, "dev");
});

test("an empty principal is a 400 with guidance, distinct from being refused", async () => {
  const r = await signin("");
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "bad_request");
  assert.match(body.message, /Enter a principal/);
});
