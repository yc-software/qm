import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

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

const { server } = await import("../src/index.ts");
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
