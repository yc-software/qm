import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, verifyPortalIdentity } from "../../../chassis/src/portal-identity.ts";
import { signRequest, canonicalPayload } from "../../../chassis/src/source-auth-sign.ts";

const identitySecret = "admin-api-identity-secret-0123456789";
const signingSecret = "admin-api-core-secret-0123456789";

interface CoreCall {
  method: string;
  path: string;
  query: URLSearchParams;
  actor: string | undefined;
  principal: string | undefined;
  signed: boolean;
  body: string;
}

const calls: CoreCall[] = [];
let brandingSaveStatus = 200;

const readAll = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const core = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://core");
  const raw = await readAll(req);
  const body = raw.toString("utf8");
  const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
  const signedTail = url.pathname === "/v1/blobs" ? (header("x-content-sha256") ?? "") : body;
  const timestamp = Number(header("x-timestamp"));
  const expected = signRequest(signingSecret, timestamp, canonicalPayload(req.method!, req.url!, signedTail));
  calls.push({
    method: req.method!,
    path: url.pathname,
    query: url.searchParams,
    actor: header("x-admin-actor"),
    principal: verifyPortalIdentity(header("x-portal-identity") ?? "", identitySecret, Date.now())?.p,
    signed: header("x-signature") === expected,
    body,
  });
  if (url.pathname === "/v1/admin/files/download" && url.searchParams.get("id") === "reset-mid-stream") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000" });
    res.write("partial");
    return setTimeout(() => res.socket?.destroy(), 20);
  }
  if (url.pathname === "/v1/admin/files/download") {
    res.writeHead(200, {
      "content-type": "image/png",
      "content-disposition": 'attachment; filename="chart.png"',
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, max-age=60",
      "x-core-internal": "secret",
    });
    return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  }
  if (url.pathname === "/v1/admin/spend" && url.searchParams.get("format") === "csv") {
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="spend.csv"',
    });
    return res.end("day,cost\n2026-09-01,1.50\n");
  }
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/v1/blobs") return res.end(JSON.stringify({ blobId: "blob-1" }));
  if (url.pathname === "/v1/surface-config") return res.end(JSON.stringify({ branding: { selfLabel: "Acme" } }));
  if (url.pathname === "/v1/connectors/catalog") return res.end(JSON.stringify({ catalog: [{ id: "github" }] }));
  if (url.pathname.endsWith("/branding")) {
    res.statusCode = brandingSaveStatus;
    return res.end(JSON.stringify({ saved: brandingSaveStatus < 300 }));
  }
  res.statusCode = url.pathname.startsWith("/v1/admin/") ? 200 : 404;
  res.end(JSON.stringify({ path: url.pathname, search: url.search }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = signingSecret;
process.env.PORTAL_IDENTITY_SECRET = identitySecret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
const { handler } = await import("../../server/index.ts");
const server = createServer((req, res) => {
  handler(req, res).catch(() => {
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  core.close();
});

const identity = (principal = "admin@example.com") => ({
  "x-portal-identity": mintPortalIdentity({ p: principal, exp: Date.now() + 60_000 }, identitySecret),
});

async function call(method: string, path: string, body?: unknown, principal?: string) {
  const before = calls.length;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...identity(principal), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, text, hops: calls.slice(before).filter((c) => c.path !== "/v1/surface-config") };
}

const pathOf = (c: CoreCall) => {
  const query = new URLSearchParams(c.query);
  query.delete("_sourceAuthNonce");
  const search = query.toString();
  return `${c.method} ${c.path}${search ? `?${search}` : ""}`;
};

test("admin API calls reach core signed, attributed to the actor, and carrying the portal identity", async () => {
  for (const principal of ["admin@example.com", "member@example.com"]) {
    const { response, hops } = await call("GET", "/api/admin/scopes", undefined, principal);
    assert.equal(response.status, 200);
    assert.equal(hops.length, 1);
    assert.equal(pathOf(hops[0]!), "GET /v1/admin/scopes");
    assert.equal(hops[0]!.actor, `${principal}@acme`);
    assert.equal(hops[0]!.principal, principal);
    assert.equal(hops[0]!.signed, true);
  }
});

test("admin API calls without a portal identity are refused before any core hop", async () => {
  const before = calls.filter((c) => c.path.startsWith("/v1/admin/")).length;
  for (const [method, path] of [
    ["GET", "/api/admin/scopes"],
    ["POST", "/api/admin/grants"],
    ["GET", "/api/admin/files/download?id=a"],
    ["GET", "/api/admin/spend?format=csv"],
    ["POST", "/api/admin/files/upload?scope=org%3Aacme"],
  ]) {
    const response = await fetch(`${base}${path}`, { method, headers: { cookie: "admin=admin@example.com" } });
    await response.text();
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  assert.equal(calls.filter((c) => c.path.startsWith("/v1/admin/")).length, before);
});

test("reads relay with their query intact", async () => {
  for (const path of [
    "whoami",
    "resources",
    "users",
    "keychain?summary=1",
    "memory?scope=org%3Aacme",
    "memory/scopes",
    "sessions/s1?scope=personal%3AU1&limit=500",
    "crons?scope=org%3Aacme",
    "skill-packs",
    "spend?from=2026-08-26&to=2026-09-25",
    "slack-mirror/messages?container=C1",
    "principal-links",
  ]) {
    const { response, hops } = await call("GET", `/api/admin/${path}`);
    assert.equal(response.status, 200, path);
    const expected = new URL(`/v1/admin/${path}`, "http://core");
    assert.equal(pathOf(hops[0]!), `GET ${expected.pathname}${expected.search}`);
    assert.equal(hops[0]!.signed, true);
  }
});

test("writes relay their method and body only where the allow-list permits them", async () => {
  const grant = { principalId: "U1", role: "org_admin", scopeId: "org:acme" };
  for (const [method, path, body] of [
    ["POST", "grants", grant],
    ["DELETE", "grants/U1?scope=org%3Aacme&role=org_admin", undefined],
    ["POST", "external-users", { email: "dana@partner.example" }],
    ["DELETE", `external-users/${encodeURIComponent("dana@partner.example")}`, undefined],
    ["PATCH", "memory?scope=personal%3AU1", { edits: [] }],
    ["PUT", "crons/c1/destination?scope=personal%3AU1", { destinationKey: "dm" }],
    ["POST", "skill-packs", { url: "https://github.com/x/y", ref: "main" }],
    ["POST", "skill-packs/s1/import", { selected: "all" }],
    ["PATCH", "skill-packs/s1", { ref: "dev" }],
    ["DELETE", "skill-packs/s1", undefined],
    ["PUT", "model-registry/known", { verify: true }],
  ] as const) {
    const { response, hops } = await call(method, `/api/admin/${path}`, body);
    assert.equal(response.status, 200, `${method} ${path}`);
    const expected = new URL(`/v1/admin/${path}`, "http://core");
    assert.equal(pathOf(hops[0]!), `${method} ${expected.pathname}${expected.search}`);
    assert.equal(hops[0]!.actor, "admin@example.com@acme");
    assert.equal(hops[0]!.signed, true);
    assert.deepEqual(hops[0]!.body ? JSON.parse(hops[0]!.body) : undefined, body);
  }
});

test("anything outside the allow-lists is a 404 that never reaches core", async () => {
  for (const [method, path] of [
    ["GET", "nonexistent"],
    ["POST", "scopes"],
    ["DELETE", "users/U1"],
    ["PUT", "whoami"],
    ["POST", "audit"],
    ["DELETE", "scopes/org%3Aacme"],
    ["PUT", "scopes/org%3Aacme"],
  ]) {
    const { response, hops } = await call(method, `/api/admin/${path}`, method === "GET" ? undefined : {});
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(hops.length, 0, `${method} ${path}`);
  }
});

test("scope reads, scope writes and the auto flagger test relay to the per-scope endpoints", async () => {
  const scope = encodeURIComponent("org:acme");
  const read = await call("GET", `/api/admin/scopes/${scope}?view=governance`);
  assert.equal(pathOf(read.hops[0]!), `GET /v1/admin/scopes/${scope}?view=governance`);
  assert.equal(JSON.parse(read.text).path, `/v1/admin/scopes/${scope}`);
  const exported = await call("GET", `/api/admin/scopes/${scope}/export?secrets=include`);
  assert.equal(pathOf(exported.hops[0]!), `GET /v1/admin/scopes/${scope}/export?secrets=include`);
  const write = await call("PUT", `/api/admin/scopes/${scope}/security-posture`, { posture: "strict" });
  assert.equal(pathOf(write.hops[0]!), `PUT /v1/admin/scopes/${scope}/security-posture`);
  assert.deepEqual(JSON.parse(write.hops[0]!.body), { posture: "strict" });
  const flagger = await call("POST", `/api/admin/scopes/${scope}/auto-flagger/test`, { window: 25 });
  assert.equal(pathOf(flagger.hops[0]!), `POST /v1/admin/scopes/${scope}/auto-flagger/test`);
  assert.deepEqual(JSON.parse(flagger.hops[0]!.body), { window: 25 });
  assert.ok(
    [read, exported, write, flagger].every(
      ({ hops }) => hops[0]!.signed && hops[0]!.actor === "admin@example.com@acme",
    ),
  );
});

test("the connector catalog comes from the core catalog endpoint", async () => {
  const { response, text, hops } = await call("GET", "/api/admin/connector-catalog");
  assert.equal(response.status, 200);
  assert.equal(pathOf(hops[0]!), "GET /v1/connectors/catalog");
  assert.deepEqual(JSON.parse(text), { catalog: [{ id: "github" }] });
});

test("a branding save acknowledges only after the web UI brand cache has refreshed", async () => {
  const scope = encodeURIComponent("org:acme");
  const start = calls.length;
  const saved = await fetch(`${base}/api/admin/scopes/${scope}/branding`, {
    method: "PUT",
    headers: { ...identity(), "content-type": "application/json" },
    body: JSON.stringify({ selfLabel: "Acme" }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { saved: true });
  const sequence = calls.slice(start).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(sequence, [`PUT /v1/admin/scopes/${scope}/branding`, "GET /v1/surface-config"]);
  assert.equal(calls[start]!.actor, "admin@example.com@acme");
  assert.equal(calls[start]!.signed, true);
  brandingSaveStatus = 400;
  const rejectedAt = calls.length;
  const rejected = await fetch(`${base}/api/admin/scopes/${scope}/branding`, {
    method: "PUT",
    headers: { ...identity(), "content-type": "application/json" },
    body: JSON.stringify({ accent: "nope" }),
  });
  brandingSaveStatus = 200;
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { saved: false });
  assert.deepEqual(
    calls.slice(rejectedAt).map((c) => c.path),
    [`/v1/admin/scopes/${scope}/branding`],
  );
});

test("file downloads stream the core attachment with its safety headers only", async () => {
  const { response, hops } = await (async () => {
    const before = calls.length;
    const response = await fetch(`${base}/api/admin/files/download?id=art-abc123`, { headers: identity() });
    return { response, hops: calls.slice(before) };
  })();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="chart.png"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "sandbox");
  assert.equal(response.headers.get("cache-control"), "private, max-age=60");
  assert.equal(response.headers.get("x-core-internal"), null);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  assert.equal(pathOf(hops[0]!), "GET /v1/admin/files/download?id=art-abc123");
  assert.equal(hops[0]!.actor, "admin@example.com@acme");
  assert.equal(hops[0]!.principal, "admin@example.com");
  assert.equal(hops[0]!.signed, true);
});

test("a spend CSV keeps the core's download headers and body, while plain spend stays JSON", async () => {
  const csv = await call("GET", "/api/admin/spend?format=csv&breakdown=model&from=2026-08-26&to=2026-09-25");
  assert.equal(csv.response.status, 200);
  assert.equal(csv.response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(csv.response.headers.get("content-disposition"), 'attachment; filename="spend.csv"');
  assert.equal(csv.text, "day,cost\n2026-09-01,1.50\n");
  assert.equal(pathOf(csv.hops[0]!), "GET /v1/admin/spend?format=csv&breakdown=model&from=2026-08-26&to=2026-09-25");
  assert.equal(csv.hops[0]!.signed, true);
  const json = await call("GET", "/api/admin/spend?from=2026-08-26&to=2026-09-25");
  assert.equal(json.response.headers.get("content-type"), "application/json");
  assert.equal(json.response.headers.get("content-disposition"), null);
});

test("an upload stages the bytes as a blob, then registers the file as the admin", async () => {
  const bytes = Buffer.from("hello, file");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const before = calls.length;
  const query = new URLSearchParams({ scope: "personal:U1", sha, name: "notes é.txt" });
  const response = await fetch(`${base}/api/admin/files/upload?${query}`, {
    method: "POST",
    headers: { ...identity(), "content-type": "text/plain" },
    body: bytes,
  });
  assert.equal(response.status, 200);
  const [stage, register] = calls.slice(before);
  assert.equal(stage!.path, "/v1/blobs");
  assert.equal(stage!.body, "hello, file");
  assert.equal(stage!.signed, true);
  assert.equal(pathOf(register!), `POST /v1/admin/files/upload?scope=${encodeURIComponent("personal:U1")}`);
  assert.equal(register!.query.get("scope"), "personal:U1");
  assert.deepEqual(JSON.parse(register!.body), { name: "notes é.txt", mimetype: "text/plain", blobId: "blob-1" });
  assert.equal(register!.actor, "admin@example.com@acme");
  assert.equal(register!.signed, true);
  const missing = await fetch(`${base}/api/admin/files/upload?sha=${sha}`, {
    method: "POST",
    headers: identity(),
    body: bytes,
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).message, "scope required");
});

test("old /admin pages redirect into Settings", async () => {
  for (const [from, to] of [
    ["/admin", "/settings/history"],
    ["/admin/", "/settings/history"],
    ["/admin/files?scope=org%3Aacme", "/settings/files?scope=org%3Aacme"],
    ["/admin/history/s/sess-1", "/settings/history/s/sess-1"],
  ]) {
    const response = await fetch(`${base}${from}`, { redirect: "manual" });
    assert.equal(response.status, 302, from);
    assert.equal(response.headers.get("location"), to, from);
  }
});

test("a core reset mid-download fails that download without taking the server down", async () => {
  await assert.rejects(async () => {
    const response = await fetch(`${base}/api/admin/files/download?id=reset-mid-stream`, { headers: identity() });
    await response.arrayBuffer();
  });
  const { response } = await call("GET", "/api/admin/whoami");
  assert.equal(response.status, 200);
});
