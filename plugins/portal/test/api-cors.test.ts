import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { isChatApiRoute, parseAllowedOrigins } from "../src/cors.ts";

const upstream = createServer((req: IncomingMessage, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url === "/api/whoami") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ isAdmin: (req.headers.cookie ?? "").includes("admin=U-admin") }));
    }
    res.writeHead(200, { "content-type": "application/json", vary: "accept-encoding" });
    res.end(JSON.stringify({ url: req.url, method: req.method, cookie: req.headers.cookie ?? null }));
  });
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const PUBLIC = "https://qm.test";
const EMBEDDER = "https://internal.example.test";
const STRANGER = "https://apps.qm.test";
process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = "api-cors-test-portal-secret-0123456789";
process.env.CORE_SIGNING_SECRET = "api-cors-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_API_ALLOWED_ORIGINS = `${EMBEDDER}, http://localhost:5173`;
const SESSION_TTL_S = 28800;
process.env.PORTAL_SESSION_TTL_S = String(SESSION_TTL_S);

const { server } = await import("../src/index.ts");
const { deriveKey, seal } = await import("../src/session.ts");
const impersonateKey = deriveKey("api-cors-test-portal-secret-0123456789", "portal.impersonate.v1");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const sessionKey = deriveKey("api-cors-test-portal-secret-0123456789", "portal.session.v1");
function sessionCookie(sub: string): string {
  const iat = Math.floor(Date.now() / 1000);
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat, exp: iat + SESSION_TTL_S }, sessionKey))}`;
}

function impersonating(actor: string, target: string): string {
  const iat = Math.floor(Date.now() / 1000);
  return `portal_impersonate=${encodeURIComponent(seal({ k: "impersonate", actor, target, org: "acme", iat, exp: iat + 3600 }, impersonateKey))}`;
}

test.after(() => {
  server.close();
  upstream.close();
});

function preflight(path: string, origin: string, method = "POST"): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": "content-type" },
  });
}

test("an allowlisted origin's preflight for a chat route is answered without a session", async () => {
  const r = await preflight("/api/turn", EMBEDDER);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), EMBEDDER);
  assert.equal(r.headers.get("access-control-allow-credentials"), "true");
  assert.match(r.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.equal(r.headers.get("access-control-allow-headers"), "content-type");
  assert.equal(r.headers.get("vary"), "Origin");
});

test("a preflight from an unlisted origin, or for a route outside the chat API, gets no CORS grant", async () => {
  for (const r of [
    await preflight("/api/turn", STRANGER),
    await preflight("/api/memory", EMBEDDER, "PUT"),
    await preflight("/auth/logout", EMBEDDER),
    await preflight("/admin/api/whoami", EMBEDDER, "GET"),
    await preflight("/api/turn", EMBEDDER, "DELETE"),
  ]) {
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
});

test("an allowlisted origin can POST a turn with the session cookie, and can read the answer", async () => {
  const r = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { cookie: sessionCookie("U1"), origin: EMBEDDER, "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), EMBEDDER);
  assert.equal(r.headers.get("access-control-allow-credentials"), "true");
  assert.equal(r.headers.get("access-control-expose-headers"), "content-disposition");
  assert.equal(((await r.json()) as { url: string }).url, "/api/turn");
});

test("Vary: Origin survives the surface's own Vary, and is sent on chat routes whatever the origin", async () => {
  for (const origin of [EMBEDDER, PUBLIC, STRANGER]) {
    const r = await fetch(`${base}/api/sessions/s1`, { headers: { cookie: sessionCookie("U1"), origin } });
    assert.equal(r.headers.get("vary"), "Origin, accept-encoding", origin);
  }
  const signedOut = await fetch(`${base}/me`, { headers: { origin: EMBEDDER } });
  assert.match(signedOut.headers.get("vary") ?? "", /Origin/);
});

test("an admin's impersonation applies to QM's own pages but never to calls from an embedding origin", async () => {
  const cookie = `${sessionCookie("U-admin")}; ${impersonating("U-admin", "alice@acme")}`;
  const same = await fetch(`${base}/api/sessions/s1`, { headers: { cookie, origin: PUBLIC } });
  assert.match(((await same.json()) as { cookie: string }).cookie, /webuiuser=alice%40acme/);
  const cross = await fetch(`${base}/api/sessions/s1`, { headers: { cookie, origin: EMBEDDER } });
  const forwarded = ((await cross.json()) as { cookie: string }).cookie;
  assert.match(forwarded, /webuiuser=U-admin/);
  assert.doesNotMatch(forwarded, /impersonator/);
});

test("reads of the chat API carry the CORS grant, including a signed-out 401 the embedder must read", async () => {
  const session = await fetch(`${base}/api/sessions/s1?tailTurns=5`, {
    headers: { cookie: sessionCookie("U1"), origin: EMBEDDER },
  });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("access-control-allow-origin"), EMBEDDER);
  const signedOut = await fetch(`${base}/me`, { headers: { origin: EMBEDDER } });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.headers.get("access-control-allow-origin"), EMBEDDER);
});

test("CSRF still holds: an allowlisted origin cannot write outside the chat API, and an unlisted one cannot write at all", async () => {
  const outside = await fetch(`${base}/api/memory/restore`, {
    method: "POST",
    headers: { cookie: sessionCookie("U1"), origin: EMBEDDER },
  });
  assert.equal(outside.status, 403);
  assert.equal(outside.headers.get("access-control-allow-origin"), null);
  const stranger = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { cookie: sessionCookie("U1"), origin: STRANGER },
  });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.headers.get("access-control-allow-origin"), null);
});

test("same-origin requests are untouched by the allowlist", async () => {
  const r = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { cookie: sessionCookie("U1"), origin: PUBLIC },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("PORTAL_API_ALLOWED_ORIGINS accepts bare https origins and rejects everything else", () => {
  const ok = parseAllowedOrigins(" https://a.example.com ,https://b.example.com:8443,, http://localhost:5173");
  assert.deepEqual([...ok.origins], ["https://a.example.com", "https://b.example.com:8443", "http://localhost:5173"]);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual([...parseAllowedOrigins(undefined).origins], []);
  for (const bad of ["*", "https://a.example.com/", "https://a.example.com/path", "http://a.example.com", "null"]) {
    const parsed = parseAllowedOrigins(bad);
    assert.equal(parsed.origins.size, 0, bad);
    assert.equal(parsed.problems.length, 1, bad);
  }
});

test("the chat API route set is exact on method and shape", () => {
  assert.ok(isChatApiRoute("GET", "/api/runs/r1/events"));
  assert.ok(isChatApiRoute("POST", "/api/runs/r1/signal"));
  assert.ok(isChatApiRoute("GET", "/api/files/f1/content/report.pdf"));
  assert.ok(isChatApiRoute("POST", "/api/blobs"));
  assert.ok(isChatApiRoute("GET", "/api/sessions"));
  assert.ok(!isChatApiRoute("POST", "/api/files/upload"));
  assert.ok(!isChatApiRoute("GET", "/api/files/by-name/content"));
  assert.ok(isChatApiRoute("GET", "/api/files/by-name-x/content"));
  assert.ok(!isChatApiRoute("PATCH", "/api/runs/r1/input"));
  assert.ok(!isChatApiRoute("POST", "/api/runs/r1/events"));
  assert.ok(!isChatApiRoute("GET", "/api/runs/r1/events/extra"));
  assert.ok(!isChatApiRoute("POST", "/api/sessions/s1"));
  assert.ok(!isChatApiRoute("POST", "/api/sessions/s1/share"));
});

test("boot refuses allowlist entries that would trust untrusted or downgraded origins", async () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", PORTAL_PUBLIC_URL: "https://qm.example.com" };
  delete baseEnv.PORTAL_COOKIE_DOMAIN;
  delete baseEnv.PORTAL_APPS_DOMAIN;
  delete baseEnv.DEPLOY_APPS_DOMAIN;
  delete baseEnv.PORTAL_PLAYGROUND;
  const boot = (env: NodeJS.ProcessEnv) =>
    new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", command], { cwd: process.cwd(), env });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject).on("close", (status) => resolve({ status, stderr }));
    });
  const ok = await boot({ ...baseEnv, PORTAL_API_ALLOWED_ORIGINS: "https://internal.example.com" });
  assert.equal(ok.status, 0, ok.stderr);
  const bad: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{ PORTAL_API_ALLOWED_ORIGINS: "https://internal.example.com/" }, /must be a bare origin/],
    [{ PORTAL_API_ALLOWED_ORIGINS: "http://internal.example.com" }, /must use https/],
    [{ PORTAL_API_ALLOWED_ORIGINS: "https://qm.example.com" }, /portal's own origin/],
    [
      { PORTAL_API_ALLOWED_ORIGINS: "https://tool.apps.qm.example.com", DEPLOY_APPS_DOMAIN: "apps.qm.example.com" },
      /under the apps domain/,
    ],
  ];
  const refused = await Promise.all(bad.map(([extra]) => boot({ ...baseEnv, ...extra })));
  bad.forEach(([extra, pattern], i) => {
    assert.notEqual(refused[i]!.status, 0, `expected boot failure for ${JSON.stringify(extra)}`);
    assert.match(refused[i]!.stderr, pattern);
  });
});
