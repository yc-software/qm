import test from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTrustedEntry, trustedEntryConfig, trustedPrincipal } from "../src/trusted-entry.ts";

const config = {
  issuer: "https://identity.example.com",
  authEndpoint: "https://identity.example.com/auth",
  tokenEndpoint: "https://identity.example.com/token",
  userinfoEndpoint: "https://identity.example.com/me",
  jwksUri: "https://identity.example.com/jwks",
  clientId: "company-client",
};
const env = {
  PORTAL_TRUSTED_OIDC: JSON.stringify(config),
  PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "separate-client-secret-of-32-characters",
  NODE_ENV: "production",
};

test("trusted entry is opt-in and cannot inherit primary provider credentials", () => {
  assert.equal(trustedEntryConfig({}, "https://portal.example.com"), null);
  for (const invalid of [
    { PORTAL_TRUSTED_OIDC: env.PORTAL_TRUSTED_OIDC },
    { PORTAL_TRUSTED_OIDC_CLIENT_SECRET: env.PORTAL_TRUSTED_OIDC_CLIENT_SECRET },
    { ...env, OIDC_CLIENT_SECRET: env.PORTAL_TRUSTED_OIDC_CLIENT_SECRET },
  ])
    assert.throws(() => trustedEntryConfig(invalid, "https://portal.example.com"));
  const parsed = trustedEntryConfig(env, "https://portal.example.com")!;
  assert.equal(parsed.redirectUri, "https://portal.example.com/auth/trusted/callback");
  assert.equal(parsed.scopes, "openid profile");
  assert.equal(parsed.prompt, undefined);
  assert.equal(parsed.identityIssuer, config.issuer);
  assert.throws(() =>
    trustedEntryConfig(
      { ...env, PORTAL_TRUSTED_OIDC: JSON.stringify({ ...config, identityIssuer: "" }) },
      "https://portal.example.com",
    ),
  );
});

test("an identity issuer keeps principals while tokens are verified against the provider's issuer", async () => {
  const previous = "https://previous-identity.example.com";
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  let nonce = "";
  const entry = createTrustedEntry(
    trustedEntryConfig(
      { ...env, PORTAL_TRUSTED_OIDC: JSON.stringify({ ...config, identityIssuer: previous }) },
      "https://portal.example.com",
    )!,
    "test-session-secret",
    async () => true,
    async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === config.jwksUri) return Response.json({ keys: [{ ...(await exportJWK(publicKey)), kid: "k" }] });
      if (url === config.userinfoEndpoint)
        return Response.json({ sub: "42", name: "A Founder", orgs: [{ id: "123", name: "Company A" }] });
      const id = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: "ES256", kid: "k" })
        .setIssuer(config.issuer)
        .setAudience(config.clientId)
        .setSubject("42")
        .setIssuedAt()
        .setExpirationTime("1m")
        .sign(privateKey);
      return Response.json({ access_token: "access", id_token: id });
    },
  );
  const start = entry.start("/");
  const authorize = new URL(start.location);
  assert.equal(authorize.searchParams.has("prompt"), false);
  nonce = authorize.searchParams.get("nonce")!;
  const identity = await entry.finish(
    start.cookie,
    new URL(`https://portal.example.com/auth/trusted/callback?code=c&state=${authorize.searchParams.get("state")}`),
  );
  assert.equal(identity.sub, trustedPrincipal(previous, "42"));
  assert.deepEqual(identity.orgs, [{ id: "123", name: "Company A" }]);
});

test("trusted provider refuses insecure endpoints in production", () => {
  for (const field of ["issuer", "authEndpoint", "tokenEndpoint", "userinfoEndpoint", "jwksUri"]) {
    for (const url of ["http://127.0.0.1:3000", "https://user:password@example.com", "https://example.com/#fragment"])
      assert.throws(() =>
        trustedEntryConfig(
          { ...env, PORTAL_TRUSTED_OIDC: JSON.stringify({ ...config, [field]: url }) },
          "https://portal.example.com",
        ),
      );
  }
});

test("subjects cannot implicitly alias primary email or Slack identities", () => {
  const principal = trustedPrincipal(config.issuer, "founder@example.com");
  assert.notEqual(principal, "founder@example.com");
  assert.notEqual(principal, trustedPrincipal("https://another.example.com", "founder@example.com"));
  assert.notEqual(principal, trustedPrincipal(config.issuer, "U123456"));
  assert.throws(() => trustedPrincipal(config.issuer, ""));
});

test("state and cookie binding are checked before claims or network access", async () => {
  let claims = 0;
  const entry = createTrustedEntry(
    trustedEntryConfig(env, "https://portal.example.com")!,
    "test-session-secret",
    async () => {
      claims++;
      return true;
    },
    async () => {
      throw new Error("Network should not be called");
    },
  );
  const start = entry.start("/");
  const url = new URL("https://portal.example.com/auth/trusted/callback?code=test&state=wrong");
  await assert.rejects(entry.finish(start.cookie, url), /Invalid trusted login state/);
  url.searchParams.set("state", new URL(start.location).searchParams.get("state")!);
  await assert.rejects(entry.finish(null, url), /Trusted login cookie missing or expired/);
  const other = createTrustedEntry(
    trustedEntryConfig(env, "https://portal.example.com")!,
    "different-session-secret",
    async () => true,
  );
  await assert.rejects(other.finish(start.cookie, url), /Trusted login cookie missing or expired/);
  assert.equal(claims, 0);
});
