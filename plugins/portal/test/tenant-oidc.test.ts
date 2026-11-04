import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePrincipal, tenantOidc, tenantPrincipalRule, type OidcConfig, type PrincipalRule } from "../src/oidc.ts";

const base: OidcConfig = {
  issuer: "https://shared.example/auth",
  authEndpoint: "https://shared.example/auth/authorize",
  tokenEndpoint: "https://shared.example/auth/token",
  userinfoEndpoint: "https://shared.example/auth/userinfo",
  jwksUri: "https://shared.example/auth/jwks",
  clientId: "deployment-client",
  clientSecret: "d".repeat(40),
  scopes: "openid email",
  redirectUri: "https://shared.example/auth/callback",
};

const rule: PrincipalRule = { claim: "email", allowedEmailDomain: "shared.example" };

const tenantA = {
  allowedEmails: ["alice@a.example"],
  oidcClient: { issuer: "https://a.example/auth", clientId: "client-a", clientSecret: "a".repeat(40) },
};
const tenantB = {
  allowedEmails: ["bob@b.example"],
  oidcClient: { issuer: "https://b.example/auth", clientId: "client-b", clientSecret: "b".repeat(40) },
};

const person = (email: string) => ({ sub: email, claims: {}, userinfo: { email, email_verified: true } });

test("each tenant signs in on its own host with its own OIDC client", () => {
  const local = { ...base, tokenEndpoint: "http://127.0.0.1:8099/token" };
  const a = tenantOidc(local, tenantA, "a.example");
  const b = tenantOidc(local, tenantB, "b.example");
  assert.deepEqual(
    [a.clientId, a.issuer, a.authEndpoint, a.redirectUri, a.tokenEndpoint, a.tenantHost],
    [
      "client-a",
      "https://a.example/auth",
      "https://a.example/auth/authorize",
      "https://a.example/auth/callback",
      "http://127.0.0.1:8099/token",
      "a.example",
    ],
  );
  assert.deepEqual(
    [b.clientId, b.issuer, b.jwksUri],
    ["client-b", "https://b.example/auth", "https://b.example/auth/jwks"],
  );
  assert.equal(tenantOidc(base, {}, undefined), base);
});

test("a person allowed only in tenant A is refused by tenant B", async () => {
  const admitByList = async (email: string) => ({ allowed: tenantA.allowedEmails.includes(email) });
  assert.deepEqual(await resolvePrincipal(tenantPrincipalRule(rule, tenantA), person("alice@a.example"), admitByList), {
    sub: "alice@a.example",
  });
  const refuseAll = async () => ({ allowed: false });
  await assert.rejects(
    resolvePrincipal(tenantPrincipalRule(rule, tenantB), person("alice@a.example"), refuseAll),
    /not on the permitted email list/,
  );
  assert.equal(tenantPrincipalRule(rule, {}), rule);
});
