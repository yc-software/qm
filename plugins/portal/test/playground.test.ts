import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { deriveKey, seal, openSession, type SessionClaims } from "../src/session.ts";

const claimed = new Set<string>();
let claimCalls = 0;
let refuseClaims = false;

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.method === "POST" && req.url?.startsWith("/v1/auth/broker/claim")) {
    claimCalls++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (refuseClaims) return void res.end(JSON.stringify({ claimed: null }));
      const { ids } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ids: string[] };
      const winner = ids.find((id) => !claimed.has(id)) ?? null;
      if (winner) claimed.add(winner);
      res.end(JSON.stringify({ claimed: winner }));
    });
    return;
  }
  if (req.url === "/api/whoami") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: false }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://localhost:18196";
process.env.PORTAL_SESSION_SECRET = "playground-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "playground-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_PLAYGROUND = "1";
process.env.PORTAL_PLAYGROUND_MINTS_PER_IP = "3";
delete process.env.PORTAL_LOCAL_AUTH_BYPASS;

const { server, mintBucketOf } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  upstream.close();
});

const HTML = { accept: "text/html" };

function sessionCookieOf(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("portal_session=") && !/portal_session=;/.test(c));
  assert.ok(raw, "expected a portal_session cookie");
  return raw.split(";")[0]!;
}

test("an unauthenticated browser visit mints an anonymous session pinned to the cookie", async () => {
  const first = await fetch(`${base}/`, { headers: HTML, redirect: "manual" });
  assert.equal(first.status, 200);
  const cookie = sessionCookieOf(first);
  const body = (await first.json()) as { cookie: string };
  const principal = /webuiuser=(playground-[0-9a-f]+)/.exec(body.cookie)?.[1];
  assert.ok(principal, `expected a playground principal, got: ${body.cookie}`);

  const callsBefore = claimCalls;
  const again = await fetch(`${base}/`, { headers: { ...HTML, cookie }, redirect: "manual" });
  assert.equal(again.status, 200);
  const reuse = (await again.json()) as { cookie: string };
  assert.match(reuse.cookie, new RegExp(`webuiuser=${principal}`));
  assert.equal(claimCalls, callsBefore, "a returning session must not mint again");
});

test("API requests without a session still require sign-in", async () => {
  const api = await fetch(`${base}/api/state`, { headers: { accept: "application/json" } });
  assert.equal(api.status, 401);
  const post = await fetch(`${base}/api/turn`, { method: "POST", headers: HTML });
  assert.equal(post.status, 401);
});

test("anonymous sessions are refused the admin surface", async () => {
  const visit = await fetch(`${base}/`, { headers: HTML, redirect: "manual" });
  const cookie = sessionCookieOf(visit);
  const admin = await fetch(`${base}/admin/`, { headers: { ...HTML, cookie } });
  assert.equal(admin.status, 403);
  const adminApi = await fetch(`${base}/admin/api/me`, { headers: { accept: "application/json", cookie } });
  assert.equal(adminApi.status, 403);
});

test("explicit sign-in still goes to the identity provider", async () => {
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.match(login.headers.get("location") ?? "", /^https:\/\/slack\.com\/openid\/connect\/authorize/);
});

test("sliding renewal preserves the anon flag", async () => {
  const key = deriveKey("playground-test-portal-secret", "portal.session.v1");
  const now = Math.floor(Date.now() / 1000);
  const aged: SessionClaims = {
    k: "session",
    sub: "playground-deadbeef",
    org: process.env.CORE_ORG_ID ?? "acme",
    name: "Guest",
    anon: true,
    auth: now - 15000,
    iat: now - 15000,
    exp: now + 13800,
  };
  const res = await fetch(`${base}/`, {
    headers: { ...HTML, cookie: `portal_session=${encodeURIComponent(seal(aged, key))}` },
    redirect: "manual",
  });
  assert.equal(res.status, 200);
  const renewed = openSession(decodeURIComponent(sessionCookieOf(res).split("=")[1]!), key, Date.now());
  assert.ok(renewed, "expected a renewed session");
  assert.equal(renewed.anon, true);
  assert.equal(renewed.sub, "playground-deadbeef");
  assert.ok(renewed.iat > aged.iat, "expected a re-stamped iat");
});

test("anonymous sessions are refused the connect and secret-drop flows", async () => {
  const visit = await fetch(`${base}/`, { headers: HTML, redirect: "manual" });
  const cookie = sessionCookieOf(visit);
  for (const path of ["/connect/redeem/tok123", "/connect/google/self-connect", "/drop/tok123/form"]) {
    const r = await fetch(`${base}${path}`, { headers: { ...HTML, cookie } });
    assert.equal(r.status, 403, `${path} must refuse anon sessions`);
  }
  const drop = await fetch(`${base}/drop/tok123`, {
    method: "POST",
    headers: { cookie, origin: "http://localhost:18196" },
  });
  assert.equal(drop.status, 403);
  assert.match(((await drop.json()) as { message: string }).message, /playground/);
});

test("mintBucketOf keys IPv4 per address and IPv6 per /64", () => {
  assert.equal(mintBucketOf("203.0.113.9"), "203.0.113.9");
  assert.equal(mintBucketOf("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(mintBucketOf("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(mintBucketOf("2001:db8:1:2:ffff::1"), mintBucketOf("2001:db8:1:2:3:4:5:6"));
  assert.notEqual(mintBucketOf("2001:db8:1:3::1"), mintBucketOf("2001:db8:1:2::1"));
  assert.equal(mintBucketOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(mintBucketOf("fe80::1%en0"), "fe80:0:0:0::/64");
});

test("boot refuses playground configurations that leak or brick", () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORTAL_PUBLIC_URL: "http://localhost:18196",
    PORTAL_PLAYGROUND: "1",
  };
  delete baseEnv.PORTAL_COOKIE_DOMAIN;
  delete baseEnv.PORTAL_APPS_DOMAIN;
  delete baseEnv.PORTAL_DEPLOYMENTS_ENABLED;
  delete baseEnv.PORTAL_PLAYGROUND_MINTS_PER_IP;
  delete baseEnv.PORTAL_PLAYGROUND_MINT_WINDOW_S;
  const boot = (env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", command], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(boot(baseEnv).status, 0);
  const bad: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{ PORTAL_PLAYGROUND_MINTS_PER_IP: "0" }, /between 1 and 64/],
    [{ PORTAL_PLAYGROUND_MINTS_PER_IP: "65" }, /between 1 and 64/],
    [{ PORTAL_PLAYGROUND_MINTS_PER_IP: "lots" }, /between 1 and 64/],
    [{ PORTAL_PLAYGROUND_MINT_WINDOW_S: "30" }, /between 60 and 86400/],
    [{ PORTAL_PLAYGROUND_MINT_WINDOW_S: "172800" }, /between 60 and 86400/],
    [{ PORTAL_COOKIE_DOMAIN: "qm.example.com" }, /PORTAL_COOKIE_DOMAIN and PORTAL_APPS_DOMAIN unset/],
    [{ PORTAL_DEPLOYMENTS_ENABLED: "1" }, /PORTAL_DEPLOYMENTS_ENABLED unset/],
  ];
  for (const [extra, pattern] of bad) {
    const r = boot({ ...baseEnv, ...extra });
    assert.notEqual(r.status, 0, `expected boot failure for ${JSON.stringify(extra)}`);
    assert.match(r.stderr, pattern);
  }
});

test("mints beyond the per-IP budget are refused, and refusal sets no cookie", async () => {
  let last: Response | null = null;
  for (let i = 0; i < 10; i++) last = await fetch(`${base}/`, { headers: HTML, redirect: "manual" });
  assert.equal(last!.status, 429);
  assert.equal(last!.headers.getSetCookie().length, 0);

  refuseClaims = true;
  try {
    const down = await fetch(`${base}/`, { headers: HTML, redirect: "manual" });
    assert.equal(down.status, 429, "a failed claim must fail closed");
  } finally {
    refuseClaims = false;
  }
});
