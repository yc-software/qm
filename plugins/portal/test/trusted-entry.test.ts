import test from "node:test";
import assert from "node:assert/strict";
import { createTrustedEntry, trustedEntryConfig, trustedPrincipal, verifiedEmails } from "../src/trusted-entry.ts";

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
  assert.equal(parsed.prompt, "login");
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

test("a verified-emails claim opts into the email scope and only verified addresses are read", () => {
  const withClaim = (claim: unknown) => ({
    ...env,
    PORTAL_TRUSTED_OIDC: JSON.stringify({ ...config, verifiedEmailsClaim: claim }),
  });
  const parsed = trustedEntryConfig(withClaim("verified_addresses"), "https://portal.example.com")!;
  assert.equal(parsed.scopes, "openid profile email");
  assert.equal(parsed.verifiedEmailsClaim, "verified_addresses");
  for (const invalid of ["", 7, "has space", "x".repeat(101)])
    assert.throws(() => trustedEntryConfig(withClaim(invalid), "https://portal.example.com"));
  assert.deepEqual(verifiedEmails(undefined, { email: "a@example.com", email_verified: true }, {}), []);
  assert.deepEqual(
    verifiedEmails(
      "verified_addresses",
      { verified_addresses: ["B@Example.com", "bad"], email: "a@example.com", email_verified: "true" },
      { email: "unverified@example.com", email_verified: false, verified_addresses: "c@example.com" },
    ),
    ["b@example.com", "a@example.com", "c@example.com"],
  );
  assert.deepEqual(verifiedEmails("email", { email: "a@example.com" }, { email: "b@example.com" }), []);
  const many = Array.from({ length: 30 }, (_, i) => `p${i}@example.com`);
  assert.equal(verifiedEmails("verified_addresses", { verified_addresses: many }, {}).length, 20);
});
