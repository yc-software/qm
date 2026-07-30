import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIRST_PARTY_SECRET_SPECS } from "../cli/src/secrets.ts";
import { MODEL_PROVIDERS, MODEL_PROVIDER_BASE_MODELS, MODEL_PROVIDER_HARNESSES } from "../cli/src/config.ts";
import { CORE_SECRET_SPECS, validateCoreSecretEnv } from "../src/deployment/secret-schema.ts";
import { HARNESS_IDS, defaultModelForProvider } from "../src/model/pi-models.ts";

test("the standalone CLI and core agree on runtime-enforced core secret names", () => {
  const cli = new Set(
    FIRST_PARTY_SECRET_SPECS.filter((secret) => secret.service === "core" && secret.required !== false).map(
      (secret) => secret.envName ?? secret.name,
    ),
  );
  const runtime = new Set(CORE_SECRET_SPECS.map((secret) => secret.name));
  assert.deepEqual([...runtime].sort(), [...cli].filter((name) => name !== "PUBLIC_API_URL").sort());
});

test('deploy/core/Dockerfile pins NODE_ENV=production — the "production" secret gate is load-bearing on that line', () => {
  const dockerfile = readFileSync(new URL("../deploy/core/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ENV NODE_ENV=production$/m);
});

test("AWS deployment app domains reject a missing or placeholder gate secret", () => {
  assert.deepEqual(validateCoreSecretEnv({ AWS_DEPLOY_APPS_DOMAIN: "apps.example.com" } as NodeJS.ProcessEnv), [
    "AWS_DEPLOY_GATE_SECRET",
  ]);
  assert.deepEqual(
    validateCoreSecretEnv({
      AWS_DEPLOY_APPS_DOMAIN: "apps.example.com",
      AWS_DEPLOY_GATE_SECRET: "replace-me",
    } as NodeJS.ProcessEnv),
    ["AWS_DEPLOY_GATE_SECRET"],
  );
  assert.deepEqual(
    validateCoreSecretEnv({
      AWS_DEPLOY_APPS_DOMAIN: "apps.example.com",
      AWS_DEPLOY_GATE_SECRET: "real-secret",
    } as NodeJS.ProcessEnv),
    [],
  );
});

test("a declared base model provider is enforced at boot, not just at deploy time", () => {
  for (const [provider, key] of [
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
  ] as const) {
    assert.deepEqual(validateCoreSecretEnv({ MODEL_PROVIDER: provider } as NodeJS.ProcessEnv), [key]);
    assert.deepEqual(validateCoreSecretEnv({ MODEL_PROVIDER: provider, [key]: "real-key" } as NodeJS.ProcessEnv), []);
    assert.deepEqual(validateCoreSecretEnv({ MODEL_PROVIDER: provider, [key]: "replace-me" } as NodeJS.ProcessEnv), [
      key,
    ]);
  }
  assert.deepEqual(validateCoreSecretEnv({} as NodeJS.ProcessEnv), [], "no provider declared, nothing required");
});

test("an OpenAI base model on the Codex harness reports its one missing key once", () => {
  assert.deepEqual(
    validateCoreSecretEnv({ MODEL_PROVIDER: "openai", HARNESS: "codex" } as NodeJS.ProcessEnv),
    ["OPENAI_API_KEY"],
    "two rules wanting the same key must not name it twice",
  );
});

test("each core secret is named by exactly one spec, so boot failures never repeat a name", () => {
  const names = CORE_SECRET_SPECS.map((spec) => spec.name);
  assert.deepEqual(
    names.filter((name, i) => names.indexOf(name) !== i),
    [],
    "give a secret answering to several rules one spec with a requiredWhen list",
  );
});

test("the CLI's provider/harness table matches what the core model registry can actually serve", () => {
  for (const provider of MODEL_PROVIDERS) {
    assert.deepEqual(
      HARNESS_IDS.filter((harness) => defaultModelForProvider(harness, provider) !== undefined).sort(),
      [...MODEL_PROVIDER_HARNESSES[provider]].sort(),
      `MODEL_PROVIDER_HARNESSES.${provider} has drifted from the registry`,
    );
  }
});

test("the CLI names the same base model the runtime will pick for each provider", () => {
  for (const provider of MODEL_PROVIDERS) {
    for (const harness of MODEL_PROVIDER_HARNESSES[provider]) {
      assert.equal(
        defaultModelForProvider(harness, provider),
        MODEL_PROVIDER_BASE_MODELS[provider],
        `MODEL_PROVIDER_BASE_MODELS.${provider} has drifted for HARNESS=${harness}`,
      );
    }
  }
});

test("production rejects weak encryption key material for managed credentials", () => {
  const strong = "x".repeat(32);
  const env = {
    NODE_ENV: "production",
    CAPABILITY_SECRET: "capability",
    CONNECTOR_SECRET_KEY: strong,
    CORE_SIGNING_SECRET: strong,
    PORTAL_IDENTITY_SECRET: "identity",
    SKILL_SIGNING_SECRET: strong,
  } as NodeJS.ProcessEnv;
  assert.deepEqual(validateCoreSecretEnv(env), []);
  assert.deepEqual(validateCoreSecretEnv({ ...env, CONNECTOR_SECRET_KEY: "short" }), ["CONNECTOR_SECRET_KEY"]);
});
