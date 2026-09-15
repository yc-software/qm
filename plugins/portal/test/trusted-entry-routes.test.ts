import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, compactVerify } from "jose";
import { deriveKey, openSession } from "../src/session.ts";

const preferenceEnabled = process.env.TRUSTED_LOGIN_LABEL_TEST !== "0";
const adminEnabled = process.env.TRUSTED_ADMIN_ROUTE_TEST === "1";
const claims = new Set<string>();
let claimAvailable = true;
let adminAvailable = true;
let adminRequests = 0;
const identitySecret = "trusted-route-identity-secret-distinct-32";
const codes = new Map<string, { nonce: string; challenge: string }>();
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
let issuer = "";
const upstream = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url!, issuer);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/jwks")
      return res.end(JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "test" }] }));
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const code = codes.get(params.get("code")!);
      codes.delete(params.get("code")!);
      assert.equal(
        req.headers.authorization,
        `Basic ${Buffer.from("trusted-client:trusted-client-secret-of-at-least-32-characters").toString("base64")}`,
      );
      assert.ok(code);
      assert.equal(code.challenge, createHash("sha256").update(params.get("code_verifier")!).digest("base64url"));
      const id = await new SignJWT({ nonce: code.nonce })
        .setProtectedHeader({ alg: "ES256", kid: "test" })
        .setIssuer(issuer)
        .setAudience("trusted-client")
        .setSubject("person-7")
        .setIssuedAt()
        .setExpirationTime("1m")
        .sign(privateKey);
      return res.end(JSON.stringify({ access_token: "profile-access", id_token: id }));
    }
    if (url.pathname === "/userinfo")
      return res.end(JSON.stringify({ sub: "person-7", name: "Test Founder", email: "admin@example.test" }));
    if (url.pathname === "/v1/auth/trusted/admin") {
      adminRequests++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const { payload } = await compactVerify(JSON.parse(body).assertion, Buffer.from(identitySecret));
      const grant = JSON.parse(Buffer.from(payload).toString());
      assert.equal(grant.purpose, "trusted-entry-admin");
      assert.equal(grant.subject, "person-7");
      assert.equal(grant.issuer, issuer);
      assert.equal(grant.org, "org:test-company");
      res.statusCode = adminAvailable ? 200 : 503;
      return res.end(JSON.stringify({ ok: adminAvailable }));
    }
    if (url.pathname === "/v1/auth/broker/claim") {
      if (!claimAvailable) {
        res.statusCode = 503;
        return res.end("{}");
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const { ids } = JSON.parse(body) as { ids: string[] };
      const id = ids.find((id) => !claims.has(id));
      if (id) claims.add(id);
      return res.end(JSON.stringify({ claimed: id ?? null }));
    }
    return res.end("{}");
  })().catch((error) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(error) }));
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
issuer = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
const sessionSecret = "trusted-route-test-session-secret";
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://127.0.0.1:19998",
  PORTAL_SESSION_SECRET: sessionSecret,
  CORE_ORG_ID: "test-company",
  CORE_API_URL: issuer,
  CORE_SIGNING_SECRET: "test-core-secret",
  PORTAL_IDENTITY_SECRET: identitySecret,
  PORTAL_TRUSTED_OIDC_ADMIN: adminEnabled ? "1" : "0",
  PORTAL_TRUSTED_OIDC_LABEL: preferenceEnabled ? "Company SSO" : "",
  WEB_UI_UPSTREAM: issuer,
  ADMIN_UPSTREAM: issuer,
  OIDC_AUTH_ENDPOINT: "https://primary.example.test/authorize",
  OIDC_CLIENT_ID: "primary-client",
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_TRUSTED_OIDC: JSON.stringify({
    issuer,
    authEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    userinfoEndpoint: `${issuer}/userinfo`,
    jwksUri: `${issuer}/jwks`,
    clientId: "trusted-client",
  }),
  PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "trusted-client-secret-of-at-least-32-characters",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  upstream.close();
});

async function start() {
  const response = await fetch(`${base}/auth/trusted/login?returnTo=https://evil.example`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get("location")!);
  const code = `code-${codes.size}-${Math.random()}`;
  codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")! });
  return {
    callback: `${base}/auth/trusted/callback?code=${code}&state=${url.searchParams.get("state")}`,
    cookie: response.headers.getSetCookie()[0]!.split(";")[0]!,
  };
}

test("primary login still selects the original provider", async () => {
  const before = adminRequests;
  const response = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const url = new URL(response.headers.get("location")!);
  assert.equal(url.origin, "https://primary.example.test");
  assert.equal(url.searchParams.get("client_id"), "primary-client");
  assert.match(response.headers.getSetCookie()[0]!, /^portal_oidc_tmp=/);
  assert.equal(adminRequests, before);
});

test("trusted route issues an ordinary scoped session, clears transient cookies, and rejects replay", async () => {
  const login = await start();
  const response = await fetch(login.callback, { redirect: "manual", headers: { cookie: login.cookie } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(adminRequests, adminEnabled ? 1 : 0);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith("portal_trusted_tmp=") && cookie.includes("Max-Age=0")));
  const sessionCookie = cookies
    .find((cookie) => cookie.startsWith("portal_session="))!
    .split(";")[0]!
    .slice("portal_session=".length);
  const session = openSession(sessionCookie, deriveKey(sessionSecret, "portal.session.v1"), Date.now(), "test-company");
  assert.ok(session);
  assert.match(session.sub, /^oidc:/);
  assert.notEqual(session.sub, "admin@example.test");
  const replay = await fetch(login.callback, { redirect: "manual", headers: { cookie: login.cookie } });
  assert.equal(replay.status, 400);
  assert.ok(!replay.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session=")));
});

test("durable claim service failure cannot issue a session", async () => {
  const login = await start();
  claimAvailable = false;
  try {
    const response = await fetch(login.callback, { redirect: "manual", headers: { cookie: login.cookie } });
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.match(html, /href="\/auth\/trusted\/login"/);
    assert.equal(html.includes('href="/auth/login?provider=primary"'), preferenceEnabled);
    assert.ok(!response.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session=")));
  } finally {
    claimAvailable = true;
  }
});

test("admin provisioning failure cannot issue a session", { skip: !adminEnabled }, async () => {
  const login = await start();
  adminAvailable = false;
  try {
    const response = await fetch(login.callback, { redirect: "manual", headers: { cookie: login.cookie } });
    assert.equal(response.status, 400);
    assert.ok(!response.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session=")));
  } finally {
    adminAvailable = true;
  }
});

test(
  "trusted sign-in preference survives logout and preserves the requested destination",
  { skip: !preferenceEnabled },
  async () => {
    const login = await start();
    const callback = await fetch(login.callback, { redirect: "manual", headers: { cookie: login.cookie } });
    const cookies = callback.headers.getSetCookie();
    const preference = cookies.find((cookie) => cookie.startsWith("portal_login_provider="))!;
    assert.ok(preference.includes("HttpOnly"));
    assert.ok(preference.includes("SameSite=Lax"));
    const session = cookies.find((cookie) => cookie.startsWith("portal_session="))!.split(";")[0]!;
    const logout = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: { origin: process.env.PORTAL_PUBLIC_URL!, cookie: session },
    });
    assert.equal(logout.status, 200);
    assert.ok(logout.headers.getSetCookie().includes(preference));
    const response = await fetch(`${base}/auth/login?returnTo=%2Fadmin%2F`, {
      redirect: "manual",
      headers: { cookie: preference.split(";")[0]! },
    });
    assert.equal(response.headers.get("location"), "/auth/trusted/login?returnTo=%2Fadmin%2F");
    assert.ok(!response.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session=")));
    const external = await fetch(`${base}/auth/login?returnTo=https://evil.example`, {
      redirect: "manual",
      headers: { cookie: preference.split(";")[0]! },
    });
    assert.equal(external.headers.get("location"), "/auth/trusted/login?returnTo=%2F");
    const primary = await fetch(`${base}/auth/login?provider=primary`, {
      redirect: "manual",
      headers: { cookie: preference.split(";")[0]! },
    });
    assert.equal(new URL(primary.headers.get("location")!).origin, "https://primary.example.test");
  },
);

test("unknown provider preferences retain primary sign-in", async () => {
  const response = await fetch(`${base}/auth/login`, {
    redirect: "manual",
    headers: { cookie: "portal_login_provider=unknown" },
  });
  assert.equal(new URL(response.headers.get("location")!).origin, "https://primary.example.test");
});

test("switching from email retains its signed return destination", async () => {
  const email = await fetch(`${base}/auth/login?provider=primary&returnTo=%2Fadmin%2F`, { redirect: "manual" });
  const cookie = email.headers.getSetCookie()[0]!.split(";")[0]!;
  const trusted = await fetch(`${base}/auth/trusted/login`, { redirect: "manual", headers: { cookie } });
  const url = new URL(trusted.headers.get("location")!);
  const code = `switch-${Math.random()}`;
  codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")! });
  const response = await fetch(`${base}/auth/trusted/callback?code=${code}&state=${url.searchParams.get("state")}`, {
    redirect: "manual",
    headers: { cookie: trusted.headers.getSetCookie()[0]!.split(";")[0]! },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/");
});

test(
  "without an opt-in label trusted sessions do not change primary login routing",
  { skip: preferenceEnabled },
  async () => {
    const login = await start();
    const callback = await fetch(login.callback, { redirect: "manual", headers: { cookie: login.cookie } });
    assert.equal(callback.status, 302);
    assert.ok(!callback.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_login_provider=")));
    const preference = createHash("sha256").update(issuer).digest("hex");
    const primary = await fetch(`${base}/auth/login`, {
      redirect: "manual",
      headers: { cookie: `portal_login_provider=${preference}` },
    });
    assert.equal(new URL(primary.headers.get("location")!).origin, "https://primary.example.test");
  },
);
