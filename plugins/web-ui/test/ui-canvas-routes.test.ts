import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const seen: Array<{ method: string; url: string; body: string }> = [];
const core = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method ?? "", url: req.url ?? "", body });
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url?.startsWith("/v1/ui/canvases/s1?")) {
    res.end(JSON.stringify({ canvas: { html: "<p/>", css: "", js: "canvas.send('hi')", pinned: false, rev: 4 } }));
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const secret = "ui-canvas-route-test-secret";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const headers = (imp?: string) => ({
  "content-type": "application/json",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
    { p: "alice@example.com", exp: Date.now() + 60_000, ...(imp ? { imp } : {}) },
    secret,
  ),
});

test.after(() => {
  surface.closeAllConnections();
  surface.close();
  core.closeAllConnections();
  core.close();
});

test("canvas script is served for the signed-in person at the current revision only", async () => {
  const r = await fetch(`${base}/api/ui-canvas/s1/script.js?rev=4`, { headers: headers() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^application\/javascript/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const js = await r.text();
  assert.match(js, /canvas\.send\('hi'\)/);
  assert.match(js, /qmUiCanvasTake\?\.\("s1", 4\)/);
  assert.ok(seen.some((s) => s.url.startsWith("/v1/ui/canvases/s1?principalId=alice%40example.com")));
  assert.equal((await fetch(`${base}/api/ui-canvas/s1/script.js?rev=3`, { headers: headers() })).status, 409);
});

test("canvas routes refuse impersonated sessions", async () => {
  const imp = headers("admin@example.com");
  assert.equal((await fetch(`${base}/api/ui-canvas/s1/script.js?rev=4`, { headers: imp })).status, 403);
  assert.equal((await fetch(`${base}/api/ui-canvas/s1`, { headers: imp })).status, 403);
  const post = await fetch(`${base}/api/ui-canvas/observe/c1`, {
    method: "POST",
    headers: imp,
    body: JSON.stringify({ snapshot: {} }),
  });
  assert.equal(post.status, 403);
});

test("observe results and pin changes are relayed as the signed-in person", async () => {
  seen.length = 0;
  await fetch(`${base}/api/ui-canvas/observe/c1`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ snapshot: { html: "<b/>" }, principalId: "mallory" }),
  });
  await fetch(`${base}/api/ui-canvas/s1`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ pinned: true, principalId: "mallory" }),
  });
  const observed = seen.find((s) => s.url.startsWith("/v1/ui/observe/c1/result"))!;
  assert.deepEqual(JSON.parse(observed.body), { snapshot: { html: "<b/>" }, principalId: "alice@example.com" });
  const pinned = seen.find((s) => s.url.startsWith("/v1/ui/canvases/s1") && s.method === "POST")!;
  assert.equal(JSON.parse(pinned.body).principalId, "alice@example.com");
});
