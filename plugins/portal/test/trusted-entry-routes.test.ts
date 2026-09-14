import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { deriveKey, openSession } from "../src/session.ts";

const claims = new Set<string>();
let claimAvailable = true;
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
  const response = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const url = new URL(response.headers.get("location")!);
  assert.equal(url.origin, "https://primary.example.test");
  assert.equal(url.searchParams.get("client_id"), "primary-client");
  assert.match(response.headers.getSetCookie()[0]!, /^portal_oidc_tmp=/);
});

test("trusted route issues an ordinary scoped session, clears transient cookies, and rejects replay", async () => {
  const login = await start();
  const response = await fetch(login.callback, { redirect: "manual", headers: { cookie: login.cookie } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
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
    assert.match(await response.text(), /href="\/auth\/trusted\/login"/);
    assert.ok(!response.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session=")));
  } finally {
    claimAvailable = true;
  }
});
