import test from "node:test";
import assert from "node:assert/strict";
import { tenantOidc, type TenantOidcContext } from "../src/tenant-oidc.ts";

const prod: TenantOidcContext = {
  publicUrl: "https://agent.example.com",
  brokerUpstream: "",
  brokerPrefix: "/idp",
  isProd: true,
};
const client = { OIDC_CLIENT_ID: "client-id", OIDC_CLIENT_SECRET: "client-secret" };
const problems = (values: Record<string, string>, ctx: TenantOidcContext = prod) => tenantOidc(values, ctx).problems;

test("unset settings fall back to the Slack endpoints but never to a client", () => {
  const { oidc, rule } = tenantOidc({}, { ...prod, isProd: false });
  assert.equal(oidc.issuer, "https://slack.com");
  assert.equal(oidc.authEndpoint, "https://slack.com/openid/connect/authorize");
  assert.equal(oidc.redirectUri, "https://agent.example.com/auth/callback");
  assert.equal(oidc.clientId, "");
  assert.equal(rule.claim, "email");
  assert.deepEqual(problems({}, { ...prod, isProd: false }), ["OIDC_CLIENT_ID is required"]);
  assert.match(problems({}).join("\n"), /OIDC_CLIENT_ID is required/);
  assert.match(problems({}).join("\n"), /OIDC_CLIENT_SECRET is required/);
});

test("an own-origin authorize endpoint needs the broker upstream", () => {
  const values = { OIDC_AUTH_ENDPOINT: "https://agent.example.com/idp/authorize", OIDC_CLIENT_ID: "client-id" };
  assert.match(problems(values, { ...prod, isProd: false }).join("\n"), /AUTH_BROKER_UPSTREAM is unset/);
  const wired = { ...prod, isProd: false, brokerUpstream: "http://127.0.0.1:9099" };
  assert.deepEqual(problems(values, wired), []);
});

test("production requires an explicit identity-provider trust boundary", () => {
  for (const team of [undefined, " ", "replace-me"]) {
    const values = { ...client, ...(team === undefined ? {} : { PORTAL_EXPECTED_TEAM_ID: team }) };
    assert.match(
      problems(values).join("\n"),
      /OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_EMAIL_DOMAIN, or PORTAL_EXPECTED_TEAM_ID/,
    );
  }
  for (const gate of [
    { OIDC_ALLOWED_EMAILS: "admin@example.com" },
    { OIDC_ALLOWED_EMAIL_DOMAIN: "example.com" },
    { PORTAL_EXPECTED_TEAM_ID: "T123" },
  ] as Array<Record<string, string>>) {
    assert.deepEqual(problems({ ...client, ...gate }), []);
  }
});

test("production requires an explicit JWKS URI for custom issuers", () => {
  const values = {
    ...client,
    OIDC_ISSUER: "https://auth.example.com",
    OIDC_AUTH_ENDPOINT: "https://auth.example.com/authorize",
    OIDC_TOKEN_ENDPOINT: "https://auth.example.com/token",
    OIDC_USERINFO_ENDPOINT: "https://auth.example.com/userinfo",
    OIDC_ALLOWED_EMAILS: "admin@example.com",
  };
  assert.match(problems(values).join("\n"), /OIDC_JWKS_URI is required/);
  assert.deepEqual(problems({ ...values, OIDC_JWKS_URI: "https://auth.example.com/jwks.json" }), []);
});

test("production accepts cleartext OIDC only for server-to-server endpoints on the private broker", () => {
  const broker = { ...prod, brokerUpstream: "http://acme-auth.internal:8080" };
  const values = {
    ...client,
    OIDC_ISSUER: "https://agent.example.com/idp",
    OIDC_AUTH_ENDPOINT: "https://agent.example.com/idp/authorize",
    OIDC_TOKEN_ENDPOINT: "http://acme-auth.internal:8080/token",
    OIDC_USERINFO_ENDPOINT: "http://acme-auth.internal:8080/userinfo",
    OIDC_JWKS_URI: "http://acme-auth.internal:8080/.well-known/jwks.json",
    OIDC_ALLOWED_EMAILS: "admin@example.com",
  };
  assert.deepEqual(problems(values, broker), []);
  for (const [override, pattern] of [
    [{ OIDC_TOKEN_ENDPOINT: "http://tokens.example.com/token" }, /must be https unless it is the built-in broker/],
    [{ OIDC_JWKS_URI: "http://10.0.0.5/keys" }, /must be https unless it is the built-in broker/],
    [{ OIDC_AUTH_ENDPOINT: "http://agent.example.com/idp/authorize" }, /OIDC_AUTH_ENDPOINT must be https/],
    [
      { OIDC_AUTH_ENDPOINT: "https://elsewhere.example.com/idp/authorize" },
      /OIDC_AUTH_ENDPOINT must be https:\/\/agent\.example\.com\/idp\/authorize/,
    ],
    [{ OIDC_ISSUER: "https://elsewhere.example.com/idp" }, /OIDC_ISSUER must be https:\/\/agent\.example\.com\/idp/],
  ] as Array<[Record<string, string>, RegExp]>) {
    assert.match(problems({ ...values, ...override }, broker).join("\n"), pattern, JSON.stringify(override));
  }
  const external = {
    ...values,
    OIDC_ISSUER: "https://auth.example.com",
    OIDC_AUTH_ENDPOINT: "https://auth.example.com/authorize",
  };
  assert.match(problems({ ...external, OIDC_JWKS_URI: "http://10.0.0.5/keys" }).join("\n"), /built-in broker/);
});
