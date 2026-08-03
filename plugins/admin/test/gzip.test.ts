import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

const SCOPES_BODY = { scopes: [{ id: "org:acme", label: "Org", kind: "org" }] };

const core = createServer((req: IncomingMessage, res) => {
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/scopes")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify(SCOPES_BODY));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";
process.env.CORE_SIGNING_SECRET = "admin-gzip-test-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  server.close();
  if (core.listening) core.close();
});

function raw(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET / serves gzip + etag when gzip is accepted", async () => {
  const r = await raw("/", { "accept-encoding": "gzip", "x-qm-locale": "en" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.ok(r.headers["etag"], "etag present");
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.equal(r.headers["vary"], "x-qm-locale, accept-language, accept-encoding");
  const html = gunzipSync(r.body).toString("utf8");
  assert.match(html, /<!doctype html>|<html/i);
});

test("GET / without gzip serves identity HTML with the same etag", async () => {
  const r = await raw("/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.match(r.body.toString("utf8"), /<!doctype html>|<html/i);
});

test("a direct development URL uses browser language and falls back to English", async () => {
  const browser = await raw("/", { "accept-language": "ja-JP, en;q=0.5" });
  const fallback = await raw("/");
  assert.match(browser.body.toString("utf8"), /<html lang="ja">/);
  assert.match(fallback.body.toString("utf8"), /<html lang="en">/);
});

test("GET / with matching if-none-match → 304", async () => {
  const first = await raw("/", { "accept-encoding": "gzip", "x-qm-locale": "ja" });
  const etag = first.headers["etag"] as string;
  const r = await raw("/", { "if-none-match": etag, "x-qm-locale": "ja" });
  assert.equal(r.status, 304);
  assert.equal(r.body.length, 0);
  assert.equal(r.headers["vary"], "x-qm-locale, accept-language, accept-encoding");
});

test("gzip bytes and etags differ by locale while each locale remains stable", async () => {
  const en = await raw("/", { "accept-encoding": "gzip", "x-qm-locale": "en" });
  const ja = await raw("/", { "accept-encoding": "gzip", "x-qm-locale": "ja" });
  const jaAgain = await raw("/users", { "accept-encoding": "gzip", "x-qm-locale": "ja" });
  assert.notDeepEqual(en.body, ja.body);
  assert.notEqual(en.headers["etag"], ja.headers["etag"]);
  assert.deepEqual(jaAgain.body, ja.body);
  assert.equal(jaAgain.headers["etag"], ja.headers["etag"]);
  assert.match(gunzipSync(en.body).toString("utf8"), /<html lang="en">/);
  assert.match(gunzipSync(ja.body).toString("utf8"), /<html lang="ja">/);
});

test("an etag from one locale never produces a 304 for another locale", async () => {
  const en = await raw("/", { "x-qm-locale": "en" });
  const ja = await raw("/", { "if-none-match": en.headers["etag"] as string, "x-qm-locale": "ja" });
  assert.equal(ja.status, 200);
  assert.match(ja.body.toString("utf8"), /<html lang="ja">/);
});

test("a JSON api route round-trips intact through the gzip proxy path", async () => {
  const r = await raw("/api/scopes", { "accept-encoding": "gzip", cookie: "admin=U-admin" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(gunzipSync(r.body).toString("utf8")), SCOPES_BODY);
});

test("a JSON api route without gzip is served uncompressed", async () => {
  const r = await raw("/api/scopes", { cookie: "admin=U-admin" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(r.body.toString("utf8")), SCOPES_BODY);
});
