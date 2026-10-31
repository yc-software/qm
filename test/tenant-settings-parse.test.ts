import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTenantSettings } from "../src/tenants/settings-parse.ts";
import { configuredModelFor, defaultModelFor, harnessCarriedModelAuthFor } from "../src/model/tenant-models.ts";
import { DEFAULT_CODEX_MODEL_ID, defaultModelForHarness, defaultModelForProvider } from "../src/model/pi-models.ts";

const parse = (values: Parameters<typeof parseTenantSettings>[0], harness = "pi") =>
  parseTenantSettings(values, harness);

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

test("CLAUDE_MODEL is the configured model on the claude harness", () => {
  const settings = parse({ CLAUDE_MODEL: "claude-opus-4-8" }, "claude");
  assert.equal(settings.claudeModel, "claude-opus-4-8");
  assert.equal(configuredModelFor(settings, "claude"), "claude-opus-4-8");
});

test("MODEL_PROVIDER declares the vendor that bills the base model", () => {
  assert.equal(parse({}).modelProvider, undefined);
  assert.equal(parse({ MODEL_PROVIDER: " openrouter " }).modelProvider, "openrouter");
  assert.throws(() => parse({ MODEL_PROVIDER: "bedrock" }), /MODEL_PROVIDER.*not recognized/);
});

test("MODEL_PROVIDER is refused when the harness can never run that vendor's models", () => {
  assert.throws(() => parse({ MODEL_PROVIDER: "openrouter" }, "claude"), /cannot serve a base model on HARNESS=claude/);
  assert.throws(() => parse({ MODEL_PROVIDER: "openai" }, "claude"), /cannot serve a base model on HARNESS=claude/);
  assert.equal(parse({ MODEL_PROVIDER: "openai" }, "pi").modelProvider, "openai");
});

test("a declared MODEL_PROVIDER constrains the base model only when it is declared", () => {
  assert.equal(
    defaultModelFor(parse({ MODEL_PROVIDER: "openrouter" }), "pi"),
    defaultModelForProvider("pi", "openrouter"),
    "the declaration picks that vendor's base model",
  );
  assert.equal(
    defaultModelFor(parse({}), "pi"),
    defaultModelForHarness("pi", undefined, undefined),
    "with no declaration the shipped default stands, so upgrading never moves a deployment's model or its billing",
  );
});

test("company ChatGPT auth satisfies model onboarding on any harness without an API key", () => {
  const codex = parse({ CODEX_AUTH_CREDENTIAL: " cred-1 " });
  assert.equal(codex.codexAuthCredential, "cred-1");
  assert.equal(harnessCarriedModelAuthFor(codex, "pi"), "openai");
  assert.equal(harnessCarriedModelAuthFor(codex, "claude"), "openai");
  assert.equal(harnessCarriedModelAuthFor(parse({}), "pi"), undefined);
  assert.equal(
    harnessCarriedModelAuthFor(parse({ CLAUDE_AUTH_CREDENTIAL: "cred-2" }, "claude"), "claude"),
    "anthropic",
  );
  assert.equal(parse({ MODEL_PROVIDER: "openai", CODEX_AUTH_CREDENTIAL: "cred-1" }).codexAuthCredential, "cred-1");
});

test("a subscription-only company ChatGPT deployment defaults pi to the plain Codex model id", () => {
  assert.equal(configuredModelFor(parse({ CODEX_AUTH_CREDENTIAL: "cred-1" }), "pi"), DEFAULT_CODEX_MODEL_ID);
  assert.equal(
    configuredModelFor(parse({ CODEX_AUTH_CREDENTIAL: "cred-1", MODEL_PROVIDER: "anthropic" }), "pi"),
    undefined,
  );
  assert.equal(
    configuredModelFor(parse({ CODEX_AUTH_CREDENTIAL: "cred-1", PI_MODEL: "claude-opus-5" }), "pi"),
    "claude-opus-5",
  );
  assert.equal(configuredModelFor(parse({}), "pi"), undefined);
});
