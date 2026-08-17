import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity } from "../../chassis/src/portal-identity.ts";

let lastActor: string | null = null;
let lastSigned = false;
let lastPortalIdentity: string | null = null;
let transientWhoamiFailures = 0;
let whoamiRequests = 0;
const core = createServer((req: IncomingMessage, res) => {
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/whoami")) {
    whoamiRequests++;
    if (transientWhoamiFailures > 0) {
      transientWhoamiFailures--;
      res.writeHead(502, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "temporarily_unavailable" }));
    }
    lastActor = (req.headers["x-admin-actor"] as string) ?? null;
    lastSigned = Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]);
    lastPortalIdentity = (req.headers["x-portal-identity"] as string) ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    const admin = lastActor === "U-admin@acme";
    return void res.end(
      JSON.stringify(admin ? { isAdmin: true, role: "org_admin", scopeId: "org:acme" } : { isAdmin: false }),
    );
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-whoami-test-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const api = (path: string, cookie?: string) => fetch(`${base}${path}`, cookie ? { headers: { cookie } } : {});

test("admin HTML ships a hash-only script policy and transport/browser isolation headers", async () => {
  const r = await api("/");
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'sha256-/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.equal(r.headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});

test("/api/whoami with cookie admin=U-admin → 200 with the core's admin status", async () => {
  const r = await api("/api/whoami", "admin=U-admin");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    principal: "U-admin",
    org: "acme",
    isAdmin: true,
    role: "org_admin",
    scopeId: "org:acme",
  });
  assert.equal(lastActor, "U-admin@acme", "x-admin-actor forwarded as <sub>@<org>");
  assert.equal(lastSigned, true, "source-auth headers present when CORE_SIGNING_SECRET is set");
});

test("/api/whoami with cookie admin=U-rando → 200 { isAdmin:false } (any non-empty cookie is trusted identity; the core decides)", async () => {
  const r = await api("/api/whoami", "admin=U-rando");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { principal: "U-rando", org: "acme", isAdmin: false });
});

test("/api/whoami with NO admin cookie → 401 signed_out", async () => {
  const r = await api("/api/whoami");
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "signed_out" });
});

test("/api/me with cookie admin=U-rando → 200 (not 401) with isAdmin:false", async () => {
  const r = await api("/api/me", "admin=U-rando");
  assert.equal(r.status, 200);
  const body = (await r.json()) as { principal: string; isAdmin: boolean };
  assert.equal(body.principal, "U-rando");
  assert.equal(body.isAdmin, false);
});

test("POST /api/login is removed → 404", async () => {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principal: "admin-alice" }),
  });
  assert.equal(r.status, 404);
});

test("user deployments are never served on the privileged admin origin", async () => {
  const r = await api("/deployments/example/", "admin=U-admin");
  assert.equal(r.status, 404);
});

test("a previously-non-allowlisted id (admin-zoe) is now forwarded as identity", async () => {
  const r = await api("/api/whoami", "admin=admin-zoe");
  assert.equal(r.status, 200);
  assert.equal(lastActor, "admin-zoe@acme", "the core is asked about admin-zoe@acme");
  const body = (await r.json()) as { principal: string; isAdmin: boolean };
  assert.equal(body.principal, "admin-zoe");
  assert.equal(body.isAdmin, false);
});

test("a forwarded portal identity is relayed to core (so an enforcing core can verify the admin, not just trust x-admin-actor)", async () => {
  const token = mintPortalIdentity({ p: "U-admin", exp: Date.now() + 60_000 }, "admin-whoami-test-secret");
  const r = await fetch(`${base}/api/whoami`, { headers: { "x-portal-identity": token } });
  assert.equal(r.status, 200);
  assert.equal(lastPortalIdentity, token, "x-portal-identity forwarded verbatim to core");
  assert.equal(lastActor, "U-admin@acme", "principal decoded from the portal identity, not a cookie");
  assert.deepEqual(await r.json(), {
    principal: "U-admin",
    org: "acme",
    isAdmin: true,
    role: "org_admin",
    scopeId: "org:acme",
  });
});

test("an unsigned or wrongly-signed portal identity is not accepted as an admin principal", async () => {
  const claims = Buffer.from(JSON.stringify({ p: "U-admin", exp: Date.now() + 60_000 })).toString("base64url");
  for (const token of [
    `${claims}.sig`,
    claims,
    mintPortalIdentity({ p: "U-admin", exp: Date.now() + 60_000 }, "attacker-key"),
    mintPortalIdentity({ p: "U-admin", exp: Date.now() - 1_000 }, "admin-whoami-test-secret"),
  ]) {
    const r = await fetch(`${base}/api/whoami`, { headers: { "x-portal-identity": token } });
    assert.equal(r.status, 401, `forged identity ${token.slice(0, 24)}… must not authenticate`);
  }
});

test("a transient core failure is retried before admin bootstrap fails", async () => {
  transientWhoamiFailures = 1;
  whoamiRequests = 0;
  const r = await api("/api/me", "admin=U-admin");
  assert.equal(r.status, 200);
  assert.equal(whoamiRequests, 2);
  assert.equal(((await r.json()) as { isAdmin?: boolean }).isAdmin, true);
});

test("core unreachable → /api/whoami returns 502 core_unreachable (outage, not a not-admin verdict)", async () => {
  await new Promise<void>((r) => core.close(() => r()));
  const r = await api("/api/whoami", "admin=U-admin");
  assert.equal(r.status, 502);
  const body = (await r.json()) as { error: string };
  assert.equal(body.error, "core_unreachable");
});
