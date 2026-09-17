import { mintPortalIdentity, verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, get as httpGet, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

const SECRET = "deploy-open-test-secret";
const IDENTITY_SECRET = "deploy-open-identity-test-secret";
const PAGE = "<!doctype html><h1>deployed app</h1>";
const ASSET = Buffer.from([0, 1, 127, 128, 255]);
const coreRequests: Array<{ url: string; method: string; headers: IncomingMessage["headers"] }> = [];

const core = createServer((req: IncomingMessage, res) => {
  const u = req.url ?? "";
  if (!u.startsWith("/d/")) {
    res.writeHead(404, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: "not_found" }));
  }
  coreRequests.push({ url: u, method: req.method ?? "GET", headers: req.headers });
  if (u === "/d/redirecting-app/") {
    res.writeHead(302, { location: "/d/redirecting-app/home" });
    return void res.end();
  }
  if (u === "/d/forbidden-app/") {
    res.writeHead(403, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: "forbidden" }));
  }
  if (u === "/d/app1/assets/file.bin?v=2") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return void res.end(ASSET);
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
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.PORTAL_IDENTITY_SECRET = IDENTITY_SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";

const { handler } = await import("../server/index.ts");

const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const IDENTITY = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 600_000 }, IDENTITY_SECRET),
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

function assertAuthenticatedRequest(index: number, url: string): void {
  const request = coreRequests[index];
  assert.ok(request, "the app request reaches core");
  assert.equal(request.url, url);
  assert.equal(request.method, "GET");
  assert.equal(request.headers["x-as-principal"], "alice");
  assert.equal(request.headers[PORTAL_IDENTITY_HEADER], IDENTITY[PORTAL_IDENTITY_HEADER]);
  assert.equal(
    verifyPortalIdentity(String(request.headers[PORTAL_IDENTITY_HEADER]), IDENTITY_SECRET, Date.now())?.p,
    "alice",
  );
  const expected = createHmac("sha256", SECRET)
    .update(`v0:${request.headers["x-timestamp"]}:GET\n${url}\nalice`)
    .digest("hex");
  assert.equal(request.headers["x-signature"], `v0=${expected}`, "signature binds the core path, query, and principal");
  assert.equal(request.headers.cookie, undefined, "browser cookies are not forwarded to apps");
}

for (const prefix of ["/deployments", "/d"]) {
  test(`GET ${prefix}/:id/ relays a gzip-serving app as a decodable response`, async () => {
    const before = coreRequests.length;
    const r = await rawGet(`${prefix}/app1/`, { ...IDENTITY, "accept-encoding": "gzip" });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-encoding"], undefined, "no stale content-encoding on the decompressed body");
    if (r.headers["content-length"] !== undefined) {
      assert.equal(
        Number(r.headers["content-length"]),
        r.body.length,
        "content-length matches the bytes actually sent",
      );
    }
    assert.equal(r.body.toString(), PAGE, "the body reaches the browser decodable as declared");
    assert.equal(
      r.headers["content-security-policy"],
      "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    );
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(coreRequests.length, before + 1);
    assertAuthenticatedRequest(before, "/d/app1/");
  });

  for (const [suffix, corePath] of [
    ["/app1", "/d/app1/"],
    ["/%61pp1/nested/page?x=1&x=2&next=%2Fd%2Fother%2F", "/d/app1/nested/page?x=1&x=2&next=%2Fd%2Fother%2F"],
  ]) {
    test(`GET ${prefix}${suffix} preserves the normalized id, subpath, and query`, async () => {
      const before = coreRequests.length;
      const r = await rawGet(`${prefix}${suffix}`, IDENTITY);
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), PAGE);
      assert.equal(coreRequests.length, before + 1);
      assertAuthenticatedRequest(before, corePath);
    });
  }

  test(`GET ${prefix}/:id/assets/file.bin preserves binary bytes`, async () => {
    const before = coreRequests.length;
    const r = await rawGet(`${prefix}/app1/assets/file.bin?v=2`, IDENTITY);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "application/octet-stream");
    assert.deepEqual(r.body, ASSET);
    assert.equal(coreRequests.length, before + 1);
    assertAuthenticatedRequest(before, "/d/app1/assets/file.bin?v=2");
  });

  test(`GET ${prefix}/:id/ passes an app redirect through without following it`, async () => {
    const before = coreRequests.length;
    const r = await rawGet(`${prefix}/redirecting-app/`, { ...IDENTITY, "accept-encoding": "identity" });
    assert.equal(r.status, 302, "the 3xx reaches the browser, which follows it itself");
    assert.equal(r.headers.location, "/d/redirecting-app/home");
    assert.equal(coreRequests.length, before + 1);
    assertAuthenticatedRequest(before, "/d/redirecting-app/");
  });

  test(`GET ${prefix}/:id/ still reaches the app after following a /d/ redirect`, async () => {
    const before = coreRequests.length;
    const r = await fetch(`${base}${prefix}/redirecting-app/`, { headers: IDENTITY });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), PAGE);
    assert.equal(coreRequests.length, before + 2);
    assertAuthenticatedRequest(before, "/d/redirecting-app/");
    assertAuthenticatedRequest(before + 1, "/d/redirecting-app/home");
  });

  test(`GET ${prefix}/:id/ preserves a core authorization denial`, async () => {
    const before = coreRequests.length;
    const r = await rawGet(`${prefix}/forbidden-app/`, IDENTITY);
    assert.equal(r.status, 403);
    assert.deepEqual(JSON.parse(r.body.toString()), { error: "forbidden" });
    assert.equal(coreRequests.length, before + 1);
    assertAuthenticatedRequest(before, "/d/forbidden-app/");
  });

  const invalidIdentities: Array<[string, Record<string, string>]> = [
    ["no identity", {}],
    ["cookie and forged principal", { cookie: "webuiuser=alice", "x-as-principal": "alice" }],
    ["invalid portal token", { [PORTAL_IDENTITY_HEADER]: "invalid", cookie: "webuiuser=alice" }],
    [
      "expired portal token",
      { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() - 60_000 }, IDENTITY_SECRET) },
    ],
    [
      "disallowed principal",
      { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "mallory", exp: Date.now() + 600_000 }, IDENTITY_SECRET) },
    ],
  ];
  for (const [label, headers] of invalidIdentities) {
    test(`GET ${prefix}/:id/ refuses ${label} before reaching core`, async () => {
      const before = coreRequests.length;
      const r = await rawGet(`${prefix}/app1/`, headers);
      assert.equal(r.status, 401);
      assert.equal(coreRequests.length, before);
    });
  }

  test(`GET ${prefix}/:id/ binds the verified principal rather than client headers`, async () => {
    const before = coreRequests.length;
    const r = await rawGet(`${prefix}/app1/`, {
      ...IDENTITY,
      "x-as-principal": "mallory",
      cookie: "webuiuser=mallory; private=not-for-apps",
    });
    assert.equal(r.status, 200);
    assert.equal(coreRequests.length, before + 1);
    assertAuthenticatedRequest(before, "/d/app1/");
  });

  for (const method of ["HEAD", "POST"]) {
    test(`${method} ${prefix}/:id/ remains outside the GET-only proxy`, async () => {
      const before = coreRequests.length;
      const r = await fetch(`${base}${prefix}/app1/`, { method, headers: IDENTITY });
      await r.arrayBuffer();
      assert.equal(r.status, 404);
      assert.equal(coreRequests.length, before);
    });
  }
}

for (const path of ["/d-other/app1/issue-923.js", "/deployments-other/app1/issue-923.js"]) {
  test(`GET ${path} is not mistaken for a deployment alias`, async () => {
    const before = coreRequests.length;
    const r = await rawGet(path, IDENTITY);
    assert.equal(r.status, 404);
    assert.equal(coreRequests.length, before);
  });
}
