import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end((req.url ?? "").startsWith("/v1/surface-config") ? JSON.stringify({ branding: {} }) : "{}");
});
await new Promise<void>((r) => core.listen(0, r));

const objects: Record<string, string> = {
  "/channels/live.json": JSON.stringify({ id: "aaaaaaaaaaaaaaaa", protocol: 1 }),
  "/channels/pr-7.json": JSON.stringify({ id: "bbbbbbbbbbbbbbbb", protocol: 1 }),
  "/channels/stale.json": JSON.stringify({ id: "cccccccccccccccc", protocol: 0 }),
  "/releases/aaaaaaaaaaaaaaaa/index.html": "<html><head><title>live</title></head><body></body></html>",
  "/releases/bbbbbbbbbbbbbbbb/index.html": "<html><head><title>preview</title></head><body></body></html>",
  "/assets/app-1234.js": "console.log('bundle')",
};
let bucketDenies = false;
const bucket = createServer((req, res) => {
  const body = bucketDenies ? undefined : objects[req.url ?? ""];
  if (bucketDenies || body === undefined) {
    res.writeHead(bucketDenies ? 403 : 404);
    return void res.end(bucketDenies ? "AccessDenied" : "NoSuchKey");
  }
  res.writeHead(200, { "content-type": (req.url ?? "").endsWith(".js") ? "text/javascript" : "text/html" });
  res.end(body);
});
await new Promise<void>((r) => bucket.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.WEB_UI_RELEASES_URL = `http://localhost:${(bucket.address() as AddressInfo).port}/`;

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => {
  handler(req, res).catch(() => {
    res.writeHead(502);
    res.end();
  });
});
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  bucket.close();
  core.close();
});

test("the document comes from the live channel's release and names it", async () => {
  const r = await fetch(`${base}/s/some-session`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<title>live/);
  assert.match(html, /<meta name="qm-ui-release" content="aaaaaaaaaaaaaaaa" \/>/);
});

test("a preview cookie selects that channel's release", async () => {
  const r = await fetch(`${base}/`, { headers: { cookie: "webuiuser=alice; qm_ui_channel=pr-7" } });
  assert.match(await r.text(), /content="bbbbbbbbbbbbbbbb"/);
});

test("an unpublished channel and a release older than the server allows fail visibly", async () => {
  const missing = await fetch(`${base}/`, { headers: { cookie: "qm_ui_channel=pr-404" } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No web UI release is published on channel &quot;pr-404&quot;/);
  const stale = await fetch(`${base}/`, { headers: { cookie: "qm_ui_channel=stale" } });
  assert.equal(stale.status, 503);
  assert.match(await stale.text(), /speaks protocol 0; this server needs 1 or newer/);
});

test("assets the CDN did not answer are relayed from the bucket", async () => {
  const r = await fetch(`${base}/assets/app-1234.js`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "console.log('bundle')");
  assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
});

test("a bucket that starts refusing keeps serving the last good release, and a cold refusal is an error", async () => {
  const warm = await fetch(`${base}/`, { headers: { cookie: "qm_ui_channel=pr-7" } });
  assert.match(await warm.text(), /content="bbbbbbbbbbbbbbbb"/);
  bucketDenies = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    const kept = await fetch(`${base}/`, { headers: { cookie: "qm_ui_channel=pr-7" } });
    assert.equal(kept.status, 200);
    assert.match(await kept.text(), /content="bbbbbbbbbbbbbbbb"/);
    const cold = await fetch(`${base}/`, { headers: { cookie: "qm_ui_channel=never-read" } });
    assert.equal(cold.status, 502);
    assert.equal((await fetch(`${base}/assets/app-1234.js`)).status, 502);
  } finally {
    bucketDenies = false;
  }
});

test("an API call from a UI older than the server's minimum is refused with ui_outdated", async () => {
  const old = await fetch(`${base}/me`, { headers: { cookie: "webuiuser=alice", "x-qm-ui-version": "0+abc" } });
  assert.equal(old.status, 409);
  assert.equal(((await old.json()) as { error: string }).error, "ui_outdated");
  const current = await fetch(`${base}/api/runtime-config`, {
    headers: { cookie: "webuiuser=alice", "x-qm-ui-version": "1+aaaaaaaaaaaaaaaa" },
  });
  assert.notEqual(current.status, 409);
});
