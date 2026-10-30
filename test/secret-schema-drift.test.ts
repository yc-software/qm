import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIRST_PARTY_SECRET_SPECS } from "../cli/src/secrets.ts";
import { isInvalidSecret as cliRejectsSecret } from "../cli/src/util.ts";
import { CORE_SECRET_SPECS, validateCoreSecretEnv } from "../src/deployment/secret-schema.ts";

test("the standalone CLI and core agree on runtime-enforced core secret names", () => {
  const cli = new Set(
    FIRST_PARTY_SECRET_SPECS.filter((secret) => secret.service === "core" && secret.required !== false).map(
      (secret) => secret.envName ?? secret.name,
    ),
  );
  const runtime = new Set(CORE_SECRET_SPECS.map((secret) => secret.name));
  assert.deepEqual([...runtime].sort(), [...cli].filter((name) => name !== "PUBLIC_API_URL").sort());
});

test("background ownership requires strong control credentials only for configured deployments", () => {
  assert.deepEqual(validateCoreSecretEnv({}), []);
  for (const secret of [undefined, "", " ".repeat(32), "short", "separate-control-secret-value-0000000000\n"]) {
    assert.deepEqual(
      validateCoreSecretEnv({
        BACKGROUND_DEPLOYMENT_ID: "core:release",
        DEPLOYMENT_CONTROL_SECRET: secret,
      }),
      ["DEPLOYMENT_CONTROL_SECRET"],
    );
    assert.equal(cliRejectsSecret("DEPLOYMENT_CONTROL_SECRET", secret), true, `the CLI preflight agrees on ${secret}`);
  }
  assert.deepEqual(
    validateCoreSecretEnv({
      BACKGROUND_DEPLOYMENT_ID: "core:release",
      DEPLOYMENT_CONTROL_SECRET: "separate-control-secret-value-0000000000",
    }),
    [],
  );
  assert.equal(cliRejectsSecret("DEPLOYMENT_CONTROL_SECRET", "separate-control-secret-value-0000000000"), false);
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
      AWS_DEPLOY_GATE_SECRET: "short",
    } as NodeJS.ProcessEnv),
    ["AWS_DEPLOY_GATE_SECRET"],
    "a guessable gate secret would let anyone forge owner tokens, so strength is enforced",
  );
  assert.deepEqual(
    validateCoreSecretEnv({
      AWS_DEPLOY_APPS_DOMAIN: "apps.example.com",
      AWS_DEPLOY_GATE_SECRET: "0123456789abcdef0123456789abcdef",
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

test("an OpenAI base model needs an API key unless a company ChatGPT login serves it", () => {
  assert.deepEqual(validateCoreSecretEnv({ MODEL_PROVIDER: "openai" } as NodeJS.ProcessEnv), ["OPENAI_API_KEY"]);
  assert.deepEqual(
    validateCoreSecretEnv({ MODEL_PROVIDER: "openai", CODEX_AUTH_CREDENTIAL: "cred-1" } as NodeJS.ProcessEnv),
    [],
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

test("production rejects weak encryption key material for managed credentials", () => {
  const strong = "x".repeat(32);
  const env = {
    NODE_ENV: "production",
    CAPABILITY_SECRET: "capability",
    CONNECTOR_SECRET_KEY: strong,
    CORE_SIGNING_SECRET: strong,
    PORTAL_IDENTITY_SECRET: "identity",
    SKILL_SIGNING_SECRET: strong,
    DATABASE_URL: "postgres://qm@localhost/qm",
  } as NodeJS.ProcessEnv;
  assert.deepEqual(validateCoreSecretEnv(env), []);
  assert.deepEqual(validateCoreSecretEnv({ ...env, CONNECTOR_SECRET_KEY: "short" }), ["CONNECTOR_SECRET_KEY"]);
});

test("both porter roles share PORTER_DEPLOY_API_TOKEN", () => {
  assert.deepEqual(validateCoreSecretEnv({ SANDBOX_BACKEND: "porter" } as NodeJS.ProcessEnv), [
    "PORTER_DEPLOY_API_TOKEN",
  ]);
  assert.deepEqual(validateCoreSecretEnv({ DEPLOY_PROVIDER: "porter" } as NodeJS.ProcessEnv), [
    "PORTER_DEPLOY_API_TOKEN",
  ]);
  assert.deepEqual(
    validateCoreSecretEnv({
      SANDBOX_BACKEND: "porter",
      DEPLOY_PROVIDER: "porter",
      PORTER_DEPLOY_API_TOKEN: "t-1",
    } as NodeJS.ProcessEnv),
    [],
  );
});

test("E2B sandboxes and E2B publishing share E2B_API_KEY", () => {
  assert.deepEqual(validateCoreSecretEnv({ DEPLOY_PROVIDER: "e2b" } as NodeJS.ProcessEnv), ["E2B_API_KEY"]);
  assert.deepEqual(validateCoreSecretEnv({ SANDBOX_BACKEND: "e2b" } as NodeJS.ProcessEnv), ["E2B_API_KEY"]);
  assert.deepEqual(validateCoreSecretEnv({ DEPLOY_PROVIDER: "e2b", E2B_API_KEY: "k" } as NodeJS.ProcessEnv), []);
});

test("shared Fly publishing validates its private peer secret", () => {
  const env = { DEPLOY_PROVIDER: "fly", FLY_DEPLOY_API_TOKEN: "token", FLY_DEPLOY_SHARED_APP_NAME: "acme-apps" };
  assert.deepEqual(validateCoreSecretEnv(env), ["FLY_DEPLOY_WIREGUARD_PEERS"]);
  assert.deepEqual(validateCoreSecretEnv({ ...env, FLY_DEPLOY_WIREGUARD_PEERS: "peer-configs" }), []);
  assert.deepEqual(validateCoreSecretEnv({ ...env, DEPLOY_PROVIDER: "aws" }), []);
});
