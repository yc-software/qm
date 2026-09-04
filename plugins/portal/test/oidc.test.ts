import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import {
  pkcePair,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  resolvePrincipal,
  verifyIdToken,
  type OidcConfig,
} from "../src/oidc.ts";

const cfg: OidcConfig = {
  authEndpoint: "https://slack.com/openid/connect/authorize",
  tokenEndpoint: "https://slack.com/api/openid.connect.token",
  userinfoEndpoint: "https://slack.com/api/openid.connect.userInfo",
  clientId: "123.456",
  clientSecret: "shh",
  scopes: "openid profile email",
  redirectUri: "https://agent.example.com/auth/callback",
  issuer: "https://slack.com",
  jwksUri: "https://slack.com/openid/connect/keys",
};

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

test("pkcePair challenge is the S256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(verifier, challenge);
});

test("buildAuthorizeUrl carries code+PKCE+state+nonce", () => {
  const u = new URL(buildAuthorizeUrl(cfg, { state: "ST", nonce: "NO", challenge: "CH" }));
  assert.equal(u.origin + u.pathname, "https://slack.com/openid/connect/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "123.456");
  assert.equal(u.searchParams.get("redirect_uri"), "https://agent.example.com/auth/callback");
  assert.equal(u.searchParams.get("scope"), "openid profile email");
  assert.equal(u.searchParams.get("state"), "ST");
  assert.equal(u.searchParams.get("nonce"), "NO");
  assert.equal(u.searchParams.get("code_challenge"), "CH");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
});

test("exchangeCode posts client_secret_basic + PKCE verifier and parses the token", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ ok: true, access_token: "AT", id_token: jwt({ sub: "U1" }) }), {
      status: 200,
    });
  }) as typeof fetch;

  const out = await exchangeCode(cfg, { code: "CODE", codeVerifier: "VER" }, stub);
  assert.equal(out.accessToken, "AT");
  assert.ok(out.idToken);
  assert.equal(seen!.url, cfg.tokenEndpoint);
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Basic ${Buffer.from("123.456:shh").toString("base64")}`);
  const body = new URLSearchParams(String(seen!.init.body));
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "CODE");
  assert.equal(body.get("code_verifier"), "VER");
  assert.equal(body.get("redirect_uri"), cfg.redirectUri);
});

test("exchangeCode treats Slack's 200 {ok:false} as an error", async () => {
  const stub = (async () =>
    new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200 })) as typeof fetch;
  await assert.rejects(exchangeCode(cfg, { code: "x", codeVerifier: "v" }, stub), /invalid_code/);
});

test("exchangeCode rejects non-2xx and missing access_token", async () => {
  const bad = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(exchangeCode(cfg, { code: "x", codeVerifier: "v" }, bad));
  const noTok = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
  await assert.rejects(exchangeCode(cfg, { code: "x", codeVerifier: "v" }, noTok), /access_token/);
});

test("fetchUserinfo sends the bearer token and returns claims", async () => {
  let auth = "";
  const stub = (async (_url: string | URL | Request, init?: RequestInit) => {
    auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    return new Response(JSON.stringify({ ok: true, sub: "U00000001" }), { status: 200 });
  }) as typeof fetch;
  const info = await fetchUserinfo(cfg, "AT", stub);
  assert.equal(info.sub, "U00000001");
  assert.equal(auth, "Bearer AT");
});

test("verifyIdToken requires a valid signature, issuer, audience, subject, nonce, and timestamps", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", use: "sig", alg: "EdDSA" };
  const signed = await new SignJWT({ nonce: "N", email: "alice@example.com" })
    .setProtectedHeader({ alg: "EdDSA", kid: "key-1" })
    .setIssuer("https://idp.example.test")
    .setAudience("client-1")
    .setSubject("subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const provider = {
    ...cfg,
    clientId: "client-1",
    issuer: "https://idp.example.test",
    jwksUri: "https://idp.example.test/jwks.json",
  };
  const fetchJwks = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const claims = await verifyIdToken(provider, signed, "N", fetchJwks);
  assert.equal(claims.sub, "subject-1");
  const multiAudience = (azp?: string) =>
    new SignJWT({ nonce: "N", ...(azp ? { azp } : {}) })
      .setProtectedHeader({ alg: "EdDSA", kid: "key-1" })
      .setIssuer("https://idp.example.test")
      .setAudience(["client-1", "other-client"])
      .setSubject("subject-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  await verifyIdToken(provider, await multiAudience("client-1"), "N", fetchJwks);
  await assert.rejects(verifyIdToken(provider, await multiAudience(), "N", fetchJwks), /authorized party/);
  await assert.rejects(
    verifyIdToken(provider, await multiAudience("other-client"), "N", fetchJwks),
    /authorized party/,
  );
  const wrongSingleParty = await new SignJWT({ nonce: "N", azp: "other-client" })
    .setProtectedHeader({ alg: "EdDSA", kid: "key-1" })
    .setIssuer("https://idp.example.test")
    .setAudience("client-1")
    .setSubject("subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  await assert.rejects(verifyIdToken(provider, wrongSingleParty, "N", fetchJwks), /authorized party/);
  const [header, payload, signature] = signed.split(".");
  const tamperedSignature = `${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1)}`;
  await assert.rejects(verifyIdToken(provider, `${header}.${payload}.${tamperedSignature}`, "N", fetchJwks));
  await assert.rejects(verifyIdToken(provider, signed, "wrong", fetchJwks), /nonce/);
});

test("resolvePrincipal claim=sub returns the subject untouched", () => {
  assert.equal(resolvePrincipal({ claim: "sub" }, { sub: "U1", claims: {}, userinfo: { email: "a@b.com" } }), "U1");
});

test("resolvePrincipal claim=email returns the verified email, normalized", () => {
  const got = resolvePrincipal(
    { claim: "email" },
    { sub: "g-123", claims: {}, userinfo: { email: " Alice@Example.com ", email_verified: true } },
  );
  assert.equal(got, "alice@example.com");
});

test("resolvePrincipal claim=email requires the verified userinfo response", () => {
  assert.throws(
    () =>
      resolvePrincipal(
        { claim: "email" },
        { sub: "g-123", claims: { email: "a@acme.com", email_verified: "true" }, userinfo: {} },
      ),
    /no email/,
  );
});

test("resolvePrincipal claim=email rejects missing or unverified emails", () => {
  assert.throws(() => resolvePrincipal({ claim: "email" }, { sub: "g", claims: {}, userinfo: {} }), /no email/);
  assert.throws(
    () => resolvePrincipal({ claim: "email" }, { sub: "g", claims: {}, userinfo: { email: "a@b.com" } }),
    /not verified/,
  );
  assert.throws(
    () =>
      resolvePrincipal(
        { claim: "email" },
        { sub: "g", claims: {}, userinfo: { email: "a@b.com", email_verified: false } },
      ),
    /not verified/,
  );
});

test("resolvePrincipal allowedEmailDomain gates the email suffix and the hd claim", () => {
  const rule = { claim: "email" as const, allowedEmailDomain: "example.com" };
  const ok = resolvePrincipal(rule, {
    sub: "g",
    claims: {},
    userinfo: { email: "a@example.com", email_verified: true, hd: "example.com" },
  });
  assert.equal(ok, "a@example.com");
  assert.throws(
    () => resolvePrincipal(rule, { sub: "g", claims: {}, userinfo: { email: "a@gmail.com", email_verified: true } }),
    /permitted domain/,
  );
  assert.throws(
    () =>
      resolvePrincipal(rule, {
        sub: "g",
        claims: {},
        userinfo: { email: "a@example.com", email_verified: true, hd: "evil.com" },
      }),
    /permitted domain/,
  );
  assert.throws(
    () =>
      resolvePrincipal(rule, {
        sub: "g",
        claims: {},
        userinfo: { email: "a@notexample.com", email_verified: true },
      }),
    /permitted domain/,
  );
});

test("resolvePrincipal allowedEmails permits only the seeded verified addresses", () => {
  const rule = { claim: "email" as const, allowedEmails: ["Admin@Example.com"] };
  assert.equal(
    resolvePrincipal(rule, { sub: "g", claims: {}, userinfo: { email: "admin@example.com", email_verified: true } }),
    "admin@example.com",
  );
  assert.throws(
    () =>
      resolvePrincipal(rule, { sub: "g", claims: {}, userinfo: { email: "other@example.com", email_verified: true } }),
    /permitted email list/,
  );
});
