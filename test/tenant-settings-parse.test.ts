import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTenantSettings } from "../src/tenants/settings-parse.ts";
import { companySubscriptionAuthFor, configuredModelFor, defaultModelFor } from "../src/model/tenant-models.ts";
import { DEFAULT_CODEX_MODEL_ID, defaultModel, defaultModelForProvider } from "../src/model/pi-models.ts";
import { bindTestTenant } from "./support/tenant.ts";

bindTestTenant();

const parse = (values: Parameters<typeof parseTenantSettings>[0]) => parseTenantSettings(values);

test("AUTH_ALLOWED_EMAILS becomes a normalized email-auth principal set", () => {
  assert.deepEqual(parse({}).emailAuthPrincipals, []);
  assert.deepEqual(
    parse({ AUTH_ALLOWED_EMAILS: " New@Example.com,other@example.com,new@example.com " }).emailAuthPrincipals,
    ["new@example.com", "other@example.com"],
  );
  assert.equal(parse({}).emailAuthDomain, undefined);
  assert.equal(parse({ AUTH_ALLOWED_EMAIL_DOMAIN: " Example.COM " }).emailAuthDomain, "example.com");
});

test("the security screen defaults off with the model classifier and validates named modes", () => {
  assert.equal(parse({}).securityScreen, "off");
  assert.equal(parse({}).securityScreenClassifier, "model");
  assert.equal(parse({ SECURITY_SCREEN: "Observe" }).securityScreen, "observe");
  assert.equal(parse({ SECURITY_SCREEN: "enforce" }).securityScreen, "enforce");
  assert.throws(() => parse({ SECURITY_SCREEN: "shadow" }), /SECURITY_SCREEN="shadow" is not recognized/);
  assert.equal(parse({}).securityScreenProxy, undefined);
});

test("the security screen proxy needs all three settings and a safe provider and endpoint", () => {
  const proxy = {
    SECURITY_SCREEN: "observe",
    SECURITY_SCREEN_CLASSIFIER: "proxy",
    SECURITY_SCREEN_PROXY_PROVIDER: "example-screen",
    SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
    SECURITY_SCREEN_PROXY_TOKEN: "test-token",
  };
  assert.throws(
    () => parse({ SECURITY_SCREEN_CLASSIFIER: "proxy" }),
    /requires SECURITY_SCREEN_PROXY_PROVIDER, SECURITY_SCREEN_PROXY_ENDPOINT, and SECURITY_SCREEN_PROXY_TOKEN/,
  );
  assert.deepEqual(parse(proxy).securityScreenProxy, {
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
  });
  assert.throws(
    () => parse({ SECURITY_SCREEN_PROXY_PROVIDER: "example-screen" }),
    /requires SECURITY_SCREEN_CLASSIFIER=proxy/,
  );
  for (const provider of ["Bad Provider", "surface", "origin", "-leading", `${"x".repeat(64)}`]) {
    assert.throws(
      () => parse({ ...proxy, SECURITY_SCREEN_PROXY_PROVIDER: provider }),
      /SECURITY_SCREEN_PROXY_PROVIDER/,
    );
  }
  for (const endpoint of [
    "http://screen.example.test/classify",
    "https://user:pass@screen.example.test/classify",
    "https://screen.example.test/classify#fragment",
    "https://screen.example.test./classify",
  ]) {
    assert.throws(
      () => parse({ ...proxy, SECURITY_SCREEN_PROXY_ENDPOINT: endpoint }),
      /SECURITY_SCREEN_PROXY_ENDPOINT/,
    );
  }
});

test("MODEL_PROVIDER declares the vendor that bills the base model", () => {
  assert.equal(parse({}).modelProvider, undefined);
  assert.equal(parse({ MODEL_PROVIDER: " openrouter " }).modelProvider, "openrouter");
  assert.throws(() => parse({ MODEL_PROVIDER: "bedrock" }), /MODEL_PROVIDER.*not recognized/);
});

test("a declared MODEL_PROVIDER constrains the base model only when it is declared", () => {
  assert.equal(
    defaultModelFor(parse({ MODEL_PROVIDER: "openrouter" })),
    defaultModelForProvider("openrouter"),
    "the declaration picks that vendor's base model",
  );
  assert.equal(
    defaultModelFor(parse({})),
    defaultModel(),
    "with no declaration the shipped default stands, so upgrading never moves a deployment's model or its billing",
  );
});

test("company subscriptions satisfy model onboarding without an API key", () => {
  const codex = parse({ CODEX_AUTH_CREDENTIAL: " cred-1 " });
  assert.equal(codex.codexAuthCredential, "cred-1");
  assert.equal(companySubscriptionAuthFor(codex), "openai");
  assert.equal(companySubscriptionAuthFor(parse({})), undefined);
  assert.equal(companySubscriptionAuthFor(parse({ CLAUDE_AUTH_CREDENTIAL: "cred-2" })), "anthropic");
  assert.equal(companySubscriptionAuthFor(parse({}), "sk-ant-oat01-company"), "anthropic");
  assert.equal(companySubscriptionAuthFor(parse({ CLAUDE_AUTH_CREDENTIAL: "cred-2" }), "sk-ant-api"), undefined);
  assert.equal(parse({ MODEL_PROVIDER: "openai", CODEX_AUTH_CREDENTIAL: "cred-1" }).codexAuthCredential, "cred-1");
});

test("a subscription-only company ChatGPT deployment defaults pi to the plain Codex model id", () => {
  assert.equal(configuredModelFor(parse({ CODEX_AUTH_CREDENTIAL: "cred-1" })), DEFAULT_CODEX_MODEL_ID);
  assert.equal(configuredModelFor(parse({ CODEX_AUTH_CREDENTIAL: "cred-1", MODEL_PROVIDER: "anthropic" })), undefined);
  assert.equal(
    configuredModelFor(parse({ CODEX_AUTH_CREDENTIAL: "cred-1", PI_MODEL: "claude-opus-5" })),
    "claude-opus-5",
  );
  assert.equal(configuredModelFor(parse({})), undefined);
});
