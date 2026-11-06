import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, compactVerify } from "jose";

const identitySecret = "trusted-email-identity-secret-distinct-32";
const codes = new Map<string, { nonce: string; challenge: string }>();
const linkRequests: Array<{ claims: Record<string, unknown>; tenantHeader: boolean }> = [];
let linkStatus = 200;
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
let issuer = "";
const upstream = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url!, issuer);
    res.setHeader("content-type", "application/json");
    let body = "";
    for await (const chunk of req) body += chunk;
    if (url.pathname === "/jwks")
      return res.end(JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "test" }] }));
    if (url.pathname === "/token") {
      const params = new URLSearchParams(body);
      const code = codes.get(params.get("code")!)!;
      codes.delete(params.get("code")!);
      assert.equal(code.challenge, createHash("sha256").update(params.get("code_verifier")!).digest("base64url"));
      const id = await new SignJWT({
        nonce: code.nonce,
        email: "Primary@Example.test",
        email_verified: true,
        verified_addresses: ["primary@example.test", "Second@Example.test", "not-an-email", 7],
      })
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
      return res.end(
        JSON.stringify({
          sub: "person-7",
          name: "Test Founder",
          email: "unverified@example.test",
          email_verified: false,
        }),
      );
    if (url.pathname === "/v1/auth/trusted/emails") {
      const { payload } = await compactVerify(JSON.parse(body).assertion, Buffer.from(identitySecret));
      linkRequests.push({
        claims: JSON.parse(Buffer.from(payload).toString()),
        tenantHeader: typeof req.headers["x-portal-identity"] === "string",
      });
      res.statusCode = linkStatus;
      return res.end(JSON.stringify({ linked: 2, unchanged: 0, skipped: {} }));
    }
    if (url.pathname === "/v1/auth/broker/claim") {
      const { ids } = JSON.parse(body) as { ids: string[] };
      return res.end(JSON.stringify({ claimed: ids[0] }));
    }
    return res.end("{}");
  })().catch((error) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(error) }));
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
issuer = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://127.0.0.1:19997",
  PORTAL_SESSION_SECRET: "trusted-email-test-session-secret",
  CORE_ORG_ID: "test-company",
  CORE_API_URL: issuer,
  CORE_SIGNING_SECRET: "test-core-secret",
  PORTAL_IDENTITY_SECRET: identitySecret,
  PORTAL_TRUSTED_OIDC_LABEL: "Company SSO",
  WEB_UI_UPSTREAM: issuer,
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
    verifiedEmailsClaim: "verified_addresses",
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

async function signIn() {
  const login = await fetch(`${base}/auth/trusted/login`, { redirect: "manual" });
  const url = new URL(login.headers.get("location")!);
  const code = `code-${Math.random()}`;
  codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")! });
  const tmp = login.headers
    .getSetCookie()
    .find((c) => c.startsWith("portal_trusted_tmp="))!
    .split(";")[0]!;
  return fetch(`${base}/auth/trusted/callback?code=${code}&state=${url.searchParams.get("state")}`, {
    redirect: "manual",
    headers: { cookie: tmp },
  });
}

test("the trusted provider is asked for the email scope", async () => {
  const login = await fetch(`${base}/auth/trusted/login`, { redirect: "manual" });
  assert.equal(new URL(login.headers.get("location")!).searchParams.get("scope"), "openid profile email");
});

test("sign-in asks core to join exactly the provider-verified emails", async () => {
  linkRequests.length = 0;
  const response = await signIn();
  assert.equal(response.status, 302);
  assert.ok(response.headers.getSetCookie().some((c) => c.startsWith("portal_session=")));
  assert.equal(linkRequests.length, 1);
  const { claims, tenantHeader } = linkRequests[0]!;
  assert.equal(claims.purpose, "trusted-entry-emails");
  assert.equal(claims.issuer, issuer);
  assert.equal(claims.subject, "person-7");
  assert.equal(claims.org, "org:test-company");
  assert.deepEqual(claims.emails, ["primary@example.test", "second@example.test"]);
  assert.ok(tenantHeader);
});

test("a failed join never blocks sign-in", async () => {
  linkStatus = 503;
  try {
    const response = await signIn();
    assert.equal(response.status, 302);
    assert.ok(response.headers.getSetCookie().some((c) => c.startsWith("portal_session=")));
  } finally {
    linkStatus = 200;
  }
});

test("starting a trusted launch keeps later sign-ins in this browser on the trusted provider", async () => {
  const login = await fetch(`${base}/auth/trusted/login?returnTo=%2Fs%2Fabc`, { redirect: "manual" });
  const preference = login.headers.getSetCookie().find((c) => c.startsWith("portal_login_provider="));
  assert.ok(preference);
  assert.equal(preference.split(";")[0], `portal_login_provider=${createHash("sha256").update(issuer).digest("hex")}`);
  const again = await fetch(`${base}/auth/login?returnTo=%2Fs%2Fabc`, {
    redirect: "manual",
    headers: { cookie: preference.split(";")[0]! },
  });
  assert.equal(again.headers.get("location"), "/auth/trusted/login?returnTo=%2Fs%2Fabc");
  const fresh = await fetch(`${base}/auth/login`, { redirect: "manual" });
  assert.equal(new URL(fresh.headers.get("location")!).origin, "https://primary.example.test");
});
