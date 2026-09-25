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
  const r = await raw("/", { "accept-encoding": "gzip" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.ok(r.headers["etag"], "etag present");
  assert.equal(r.headers["cache-control"], "no-cache");
  const html = gunzipSync(r.body).toString("utf8");
  assert.match(html, /<!doctype html>|<html/i);
});

test("GET / respects a client that explicitly refuses gzip with q=0", async () => {
  const r = await raw("/", { "accept-encoding": "gzip;q=0, identity" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.headers["vary"], "accept-encoding");
  assert.match(r.body.toString("utf8"), /<!doctype html>|<html/i);
});

test("GET / without gzip serves identity HTML under its own etag", async () => {
  const r = await raw("/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.match(r.body.toString("utf8"), /<!doctype html>|<html/i);
  const packed = await raw("/", { "accept-encoding": "gzip" });
  assert.notEqual(r.headers["etag"], packed.headers["etag"], "each encoding needs its own validator");
});

test("GET / with matching if-none-match → 304", async () => {
  const first = await raw("/", { "accept-encoding": "gzip" });
  const etag = first.headers["etag"] as string;
  const r = await raw("/", { "accept-encoding": "gzip", "if-none-match": etag });
  assert.equal(r.status, 304);
  assert.equal(r.body.length, 0);
});

test("revalidating a cached gzip entry as an identity client gets the identity bytes, never a 304", async () => {
  const packed = await raw("/", { "accept-encoding": "gzip" });
  const r = await raw("/", { "if-none-match": packed.headers["etag"] as string });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.match(r.body.toString("utf8"), /<!doctype html>|<html/i);
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
