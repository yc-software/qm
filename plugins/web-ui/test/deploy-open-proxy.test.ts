import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get as httpGet, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

const PAGE = "<!doctype html><h1>deployed app</h1>";
let lastCoreRequest: { url: string; principal: string } | null = null;

const core = createServer((req: IncomingMessage, res) => {
  const u = req.url ?? "";
  lastCoreRequest = { url: u, principal: String(req.headers["x-as-principal"] ?? "") };
  if (!u.startsWith("/d/")) {
    res.writeHead(404, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: "not_found" }));
  }
  if (u.startsWith("/d/redirecting-app/")) {
    res.writeHead(302, { location: "/d/redirecting-app/home" });
    return void res.end();
  }
  if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    const z = gzipSync(Buffer.from(PAGE));
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": z.length });
    return void res.end(z);
  }
  res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(PAGE) });
  res.end(PAGE);
});
await new Promise<void>((r) => core.listen(0, r));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

process.env.CORE_API_URL = coreUrl;
const SECRET = "deploy-open-test-secret";
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");

const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const IDENTITY = {
  cookie: "webuiuser=alice",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET),
};

function rawGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    httpGet(`${base}${path}`, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

test("GET /deployments/:id/ relays a gzip-serving app as a decodable response", async () => {
  const r = await rawGet("/deployments/app1/", { ...IDENTITY, "accept-encoding": "gzip" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], undefined, "no stale content-encoding on the decompressed body");
  if (r.headers["content-length"] !== undefined) {
    assert.equal(Number(r.headers["content-length"]), r.body.length, "content-length matches the bytes actually sent");
  }
  assert.equal(r.body.toString(), PAGE, "the body reaches the browser decodable as declared");
  assert.equal(lastCoreRequest?.url, "/d/app1/", "the id maps onto core's /d/ path");
  assert.equal(lastCoreRequest?.principal, "alice", "the signed-in user rides as the principal");
});

test("GET /deployments/:id/ passes an app redirect through without following it", async () => {
  const r = await rawGet("/deployments/redirecting-app/", { ...IDENTITY, "accept-encoding": "identity" });
  assert.equal(r.status, 302, "the 3xx reaches the browser, which follows it itself");
  assert.equal(r.headers.location, "/d/redirecting-app/home");
});

test("GET /deployments/:id/ requires a signed-in user", async () => {
  const r = await rawGet("/deployments/app1/", {});
  assert.equal(r.status, 401);
});
