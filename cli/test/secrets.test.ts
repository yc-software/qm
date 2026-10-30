import { test } from "node:test";
import assert from "node:assert/strict";
import { type QmConfig } from "../src/config.ts";
import {
  computedSecrets,
  missingRequiredSecrets,
  serviceSecretValue,
  runtimeSecretNames,
  secretDestinations,
  secretsForService,
  type ComputedSecret,
} from "../src/secrets.ts";
import { renderEnvExample } from "../src/env-example.ts";
import { isReservedContainerName, pluginNameError, DECLARED_SERVICE_NAMES } from "../src/services.ts";

function makeConfig(overrides: Partial<QmConfig> = {}): QmConfig {
  return {
    contract: 1,
    deploymentId: "acme",
    publicUrl: "http://localhost:8080",
    target: "docker",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    ...overrides,
  };
}

function secretByName(config: QmConfig, name: string): ComputedSecret {
  const secret = computedSecrets(config).find((s) => s.name === name);
  assert.ok(secret, `computed secret ${name} exists`);
  return secret;
}

test("required secret validation uses the selected values without ambient credentials", () => {
  const config = makeConfig({ target: "aws" });
  const database = secretByName(config, "DATABASE_URL");
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://local/db";
  try {
    for (const value of [undefined, "", "replace-me"]) {
      assert.deepEqual(
        missingRequiredSecrets([database], () => value),
        ["DATABASE_URL"],
      );
    }
    assert.deepEqual(
      missingRequiredSecrets([database], () => "postgres://deployed/db"),
      [],
    );
    assert.deepEqual(
      missingRequiredSecrets([{ ...database, required: false }], () => undefined),
      [],
    );
  } finally {
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
  }
});

test("a virtual-only secret keeps its plain name on the edge (the virtual service runs in-process)", () => {
  const config = makeConfig({ services: ["core", "slack"] });
  const secret = secretByName(config, "SLACK_APP_TOKEN");
  assert.deepEqual(runtimeSecretNames("edge", secret), ["SLACK_APP_TOKEN"]);
  assert.ok(secretsForService(config, "edge").some((s) => s.name === "SLACK_APP_TOKEN"));
  assert.ok(!secretsForService(config, "harness").some((s) => s.name === "SLACK_APP_TOKEN"));
});

test("split security keys are required and routed only to their trust boundary", () => {
  const config = makeConfig({ services: ["core", "portal"] });
  for (const name of ["CAPABILITY_SECRET", "CONNECTOR_SECRET_KEY"] as const) {
    const secret = secretByName(config, name);
    assert.equal(secret.required, true);
    assert.deepEqual([...secretDestinations(secret).keys()], ["edge", "harness"]);
  }
  const identity = secretByName(config, "PORTAL_IDENTITY_SECRET");
  assert.equal(identity.required, true);
  assert.deepEqual([...secretDestinations(identity).keys()].sort(), ["edge", "harness"]);
  const example = renderEnvExample(config);
  for (const name of ["CORE_SIGNING_SECRET", "CAPABILITY_SECRET", "PORTAL_IDENTITY_SECRET", "CONNECTOR_SECRET_KEY"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  }
});

test("portal sign-in coordinates can come from the target secret store as tenant settings", () => {
  const secretBacked = makeConfig({ services: ["core", "portal"], env: { portal: { OIDC_PRINCIPAL_CLAIM: "email" } } });
  for (const name of ["OIDC_CLIENT_ID", "PORTAL_EXPECTED_TEAM_ID"]) {
    const secret = secretByName(secretBacked, name);
    assert.equal(secret.required, true);
    assert.deepEqual(runtimeSecretNames("portal", secret), [], `${name} is a tenant setting served by core`);
  }

  const configured = makeConfig({
    services: ["core", "portal"],
    env: { portal: { OIDC_CLIENT_ID: "client", OIDC_ALLOWED_EMAIL_DOMAIN: "example.com" } },
  });
  assert.ok(!computedSecrets(configured).some((secret) => secret.name === "OIDC_CLIENT_ID"));
  assert.ok(!computedSecrets(configured).some((secret) => secret.name === "PORTAL_EXPECTED_TEAM_ID"));
});

test("portal deployments require a real initial administrator seed", () => {
  const hosted = makeConfig({
    services: ["core", "portal"],
    secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
  });
  const secret = secretByName(hosted, "ADMIN_GRANTS");
  assert.equal(secret.required, true);
  assert.deepEqual(runtimeSecretNames("edge", secret), [], "the seed is a tenant setting, not edge env");
  assert.deepEqual(runtimeSecretNames("harness", secret), [], "the seed is a tenant setting, not harness env");
  assert.ok(!computedSecrets(makeConfig()).some((item) => item.name === "ADMIN_GRANTS"));
});

test("a plugin secret lands plain on the plugin's own workload, nowhere else", () => {
  const config = makeConfig({
    plugins: [{ name: "linear", image: "ghcr.io/x:1", secrets: [{ name: "PLUG_TOKEN" }] }],
  });
  const secret = secretByName(config, "PLUG_TOKEN");
  assert.deepEqual(runtimeSecretNames("linear", secret), ["PLUG_TOKEN"]);
  assert.deepEqual(runtimeSecretNames("harness", secret), []);
  assert.deepEqual([...secretDestinations(secret).keys()], ["linear"]);
});

test("discovered source plugins (absent from config.plugins) get CORE_SIGNING_SECRET routed to them", () => {
  const config = makeConfig();
  const signing = secretByName(config, "CORE_SIGNING_SECRET");
  assert.deepEqual(runtimeSecretNames("srcplug", signing), [], "not routed without discovery");
  assert.deepEqual(runtimeSecretNames("srcplug", signing, ["srcplug"]), ["CORE_SIGNING_SECRET"]);
  assert.ok(secretsForService(config, "srcplug", ["srcplug"]).some((s) => s.name === "CORE_SIGNING_SECRET"));
  const other = secretByName(config, "SKILL_SIGNING_SECRET");
  assert.deepEqual(
    runtimeSecretNames("srcplug", other, ["srcplug"]),
    [],
    "only the signing secret fans out to plugins",
  );
});

test("SLACK_SIGNING_SECRET joins the secret set only in HTTP events mode (socket mode never verifies request signatures)", () => {
  const socket = makeConfig({ services: ["core", "slack"] });
  assert.ok(
    !computedSecrets(socket).some((s) => s.name === "SLACK_SIGNING_SECRET"),
    "absent in the default socket mode",
  );
  const http = makeConfig({ services: ["core", "slack"], env: { slack: { SLACK_EVENTS_MODE: "http" } } });
  assert.ok(secretByName(http, "SLACK_SIGNING_SECRET").required);
});

test('"sandbox" is a reserved name — a plugin may not shadow the sandbox pseudo-service', () => {
  assert.ok(isReservedContainerName("sandbox"));
  assert.match(pluginNameError("sandbox") ?? "", /reserved/);
});

test("model credentials are optional at deploy time because Admin onboarding can configure them", () => {
  const fly = makeConfig({ target: "fly" });
  assert.equal(secretByName(fly, "ANTHROPIC_API_KEY").required, false);
  const docker = makeConfig();
  assert.equal(secretByName(docker, "ANTHROPIC_API_KEY").required, false);
});

test("the Fly publisher token belongs only to a Fly deploy provider", () => {
  assert.ok(!computedSecrets(makeConfig({ target: "fly" })).some((secret) => secret.name === "FLY_DEPLOY_API_TOKEN"));
  assert.ok(
    secretByName(makeConfig({ target: "fly", env: { core: { DEPLOY_PROVIDER: "fly" } } }), "FLY_DEPLOY_API_TOKEN")
      .required,
  );
  for (const config of [makeConfig(), makeConfig({ sandbox: { app: "acme-sb" } }), makeConfig({ target: "aws" })]) {
    assert.ok(!computedSecrets(config).some((secret) => secret.name === "FLY_SANDBOX_API_TOKEN"));
    assert.ok(!computedSecrets(config).some((secret) => secret.name === "FLY_DEPLOY_API_TOKEN"));
  }
});

test("the sprites token is a catalog secret when the sandbox backend is sprites", () => {
  assert.ok(
    secretByName(makeConfig({ target: "aws", sandbox: { backend: "sprites", app: "acme-sb" } }), "SPRITES_TOKEN")
      .required,
  );
  assert.ok(
    !computedSecrets(makeConfig({ target: "aws", sandbox: { backend: "e2b" } })).some(
      (secret) => secret.name === "SPRITES_TOKEN",
    ),
  );
});

test("naming a base model provider makes that provider's key a required deployment secret", () => {
  for (const [provider, key] of [
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
  ] as const) {
    const config = makeConfig({ modelProvider: provider });
    assert.equal(secretByName(config, key).required, true, `${provider} requires ${key}`);
    assert.match(
      renderEnvExample(config),
      new RegExp(`^${key}=$`, "m"),
      `${key} is uncommented in .env.example so setup collects it`,
    );
  }
});

test("the providers a deployment did not select stay optional", () => {
  const anthropic = makeConfig({ modelProvider: "anthropic" });
  assert.equal(secretByName(anthropic, "OPENROUTER_API_KEY").required, false);
  assert.equal(secretByName(anthropic, "OPENAI_API_KEY").required, false);
});

test("omitting modelProvider preserves the pre-existing deferred-to-Admin behavior", () => {
  const deferred = makeConfig();
  assert.equal(secretByName(deferred, "ANTHROPIC_API_KEY").required, false);
  assert.equal(secretByName(deferred, "OPENROUTER_API_KEY").required, false);
});

test("conditional secret values use the runtime's trimmed enum semantics", () => {
  const slack = makeConfig({ services: ["core", "slack"], env: { slack: { SLACK_EVENTS_MODE: "  http  " } } });
  assert.ok(secretByName(slack, "SLACK_SIGNING_SECRET").required);
});

test("AWS public app domains require and route their gate secret to core", () => {
  const disabled = makeConfig({ target: "aws" });
  assert.ok(!computedSecrets(disabled).some((secret) => secret.name === "AWS_DEPLOY_GATE_SECRET"));

  const enabled = makeConfig({ target: "aws", env: { core: { AWS_DEPLOY_APPS_DOMAIN: "apps.example.com" } } });
  const gate = secretByName(enabled, "AWS_DEPLOY_GATE_SECRET");
  assert.equal(gate.required, true);
  assert.deepEqual(runtimeSecretNames("harness", gate), ["AWS_DEPLOY_GATE_SECRET"]);
  assert.ok(renderEnvExample(enabled).includes("AWS_DEPLOY_GATE_SECRET="));
});

test("core requires and routes the sandbox-reachable PUBLIC_API_URL", () => {
  const real = makeConfig();
  const publicApi = secretByName(real, "PUBLIC_API_URL");
  assert.equal(publicApi.required, true);
  assert.deepEqual(runtimeSecretNames("harness", publicApi), ["PUBLIC_API_URL"]);
  assert.ok(renderEnvExample(real).includes("PUBLIC_API_URL="));
});

test("config secretEnv extras enter the computed set as required operator secrets, virtual services folding onto the edge", () => {
  const config = makeConfig({
    services: ["core", "slack"],
    secretEnv: { core: { EXTRA_API_KEY: "EXTRA_API_KEY" }, slack: { SLACK_AUX_BOT_TOKEN: "SLACK_AUX_BOT_TOKEN" } },
  });
  const extra = secretByName(config, "EXTRA_API_KEY");
  assert.equal(extra.required, true);
  assert.equal(extra.managedBy, "operator");
  assert.deepEqual(runtimeSecretNames("harness", extra), ["EXTRA_API_KEY"]);
  const auxiliary = secretByName(config, "SLACK_AUX_BOT_TOKEN");
  assert.deepEqual(
    [...secretDestinations(auxiliary).keys()],
    ["edge"],
    "a virtual service's extra folds onto the edge",
  );
  assert.match(renderEnvExample(config), /^EXTRA_API_KEY=$/m);
});

test("a secretEnv alias delivers the stored secret under its declared env name only", () => {
  const config = makeConfig({
    services: ["core", "web-ui", "portal"],
    secretEnv: { core: { DEPLOY_APPS_SESSION_SECRET: "PORTAL_SESSION_SECRET" } },
  });
  const secret = secretByName(config, "PORTAL_SESSION_SECRET");
  assert.deepEqual(secret.services, ["portal"], "the alias adds no plain-name claim");
  assert.deepEqual(runtimeSecretNames("harness", secret), ["DEPLOY_APPS_SESSION_SECRET"]);
  assert.deepEqual(runtimeSecretNames("edge", secret).sort(), ["DEPLOY_APPS_SESSION_SECRET", "PORTAL_SESSION_SECRET"]);
  assert.ok(secretsForService(config, "harness").some((s) => s.name === "PORTAL_SESSION_SECRET"));
  assert.ok(
    !computedSecrets(config).some((s) => s.name === "DEPLOY_APPS_SESSION_SECRET"),
    "the alias env name is delivery, not a second stored secret",
  );
});

test("secretEnv merges onto an existing computed secret instead of duplicating it", () => {
  const config = makeConfig({
    services: ["core", "web-ui", "portal"],
    secretEnv: { "web-ui": { PORTAL_IDENTITY_SECRET: "PORTAL_IDENTITY_SECRET" } },
  });
  const identity = secretByName(config, "PORTAL_IDENTITY_SECRET");
  assert.deepEqual(identity.services, ["core", "portal", "web-ui"]);
  assert.equal(computedSecrets(config).filter((s) => s.name === "PORTAL_IDENTITY_SECRET").length, 1);
});

test("secretEnv for a service the config does not enable is ignored", () => {
  const config = makeConfig({ secretEnv: { portal: { EXTRA_TOKEN: "EXTRA_TOKEN" } } });
  assert.ok(!computedSecrets(config).some((s) => s.name === "EXTRA_TOKEN"));
});

test("PORTAL_IDENTITY_SECRET reaches every service that signs or verifies a portal identity", () => {
  const config = makeConfig({ services: ["core", "web-ui", "admin", "portal"] });
  const secret = secretByName(config, "PORTAL_IDENTITY_SECRET");
  assert.deepEqual(
    [...secretDestinations(secret).keys()].sort(),
    ["edge", "harness"],
    "core verifies with PORTAL_IDENTITY_SECRET, so a surface left without it signs with a different key and every request it makes is rejected",
  );
});

test("the invitation-email pair reaches core as optional secrets on every topology", () => {
  for (const name of ["RESEND_API_KEY", "AUTH_EMAIL_FROM"]) {
    const alone = secretByName(makeConfig(), name);
    assert.equal(alone.required, false);
    assert.deepEqual([...secretDestinations(alone).keys()], ["edge", "harness"]);
    assert.match(alone.description, /admin Users tab or by chatting with QM/);
    assert.match(renderEnvExample(makeConfig()), new RegExp(`^# ${name}=  # optional$`, "m"));

    const broker = makeConfig({
      services: ["core", "portal", "auth"],
      env: { auth: { AUTH_EMAIL_TRANSPORT: "resend" } },
    });
    const shared = secretByName(broker, name);
    assert.equal(shared.required, false);
    assert.deepEqual([...secretDestinations(shared).keys()].sort(), ["edge", "harness"]);
  }
});

test("the .env.example catalog names every secret exactly once", () => {
  for (const services of [["core"], ["core", "portal"], ["core", "portal", "auth"], DECLARED_SERVICE_NAMES] as const) {
    const rendered = renderEnvExample(makeConfig({ services: [...services] as QmConfig["services"] }));
    const declared = rendered
      .split("\n")
      .map((line) => /^#?\s*([A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
    const duplicated = declared.filter((name, i) => declared.indexOf(name) !== i);
    assert.deepEqual(duplicated, [], `services=${services.join("+")} lists a secret twice`);
  }
});

test("runtime model provider override controls the required billing key", () => {
  const config = makeConfig({
    modelProvider: "anthropic",
    env: { core: { MODEL_PROVIDER: " openrouter " } },
  });
  assert.equal(secretByName(config, "OPENROUTER_API_KEY").required, true);
  assert.equal(secretByName(config, "ANTHROPIC_API_KEY").required, false);
});

test("combined auth rejects two source secrets for the same environment name", () => {
  const config = makeConfig({
    services: ["portal", "auth"],
    secretEnv: {
      portal: { RESEND_API_KEY: "PORTAL_RESEND" },
      auth: { RESEND_API_KEY: "AUTH_RESEND" },
    },
  });
  assert.throws(
    () => serviceSecretValue(config, "auth", "RESEND_API_KEY", new Map()),
    /would receive env RESEND_API_KEY from both/,
  );
});

test("the retired SANDBOX_SCOPE_BACKENDS map no longer requires provider credentials", () => {
  const config = makeConfig({
    env: {
      core: { SANDBOX_BACKEND: "sprites", SANDBOX_SCOPE_BACKENDS: '{"personal":"modal"}' },
    },
  });
  const required = computedSecrets(config)
    .filter((secret) => secret.required)
    .map((secret) => secret.name);
  assert.ok(required.includes("SPRITES_TOKEN"));
  assert.ok(!required.includes("MODAL_TOKEN_ID"));
});

test("shared Fly publishing requires private peers only when selected", () => {
  for (const provider of ["fly", "aws"]) {
    for (const shared of [false, true]) {
      const config = makeConfig({
        target: "aws",
        env: {
          core: {
            DEPLOY_PROVIDER: provider,
            ...(shared ? { FLY_DEPLOY_SHARED_APP_NAME: "acme-apps" } : {}),
          },
        },
      });
      const peer = computedSecrets(config).find((secret) => secret.name === "FLY_DEPLOY_WIREGUARD_PEERS");
      assert.equal(Boolean(peer?.required), provider === "fly" && shared);
      if (provider === "fly" && shared) assert.doesNotMatch(renderEnvExample(config), /tokens create org/);
    }
  }
});

test("deployment control credentials are required everywhere and cannot be delivered to plugins", () => {
  assert.equal(secretByName(makeConfig(), "DEPLOYMENT_CONTROL_SECRET").required, true);
  const aws = { backgroundWorkControl: true } as NonNullable<QmConfig["aws"]>;
  const config = makeConfig({ target: "aws", aws });
  const control = secretByName(config, "DEPLOYMENT_CONTROL_SECRET");
  assert.equal(control.required, true);
  assert.deepEqual(control.services, ["core"]);
  assert.throws(
    () =>
      computedSecrets({
        ...config,
        plugins: [{ name: "external", secrets: [{ name: "DEPLOYMENT_CONTROL_SECRET" }] }],
      }),
    /only to core/,
  );
  assert.throws(
    () =>
      computedSecrets({
        ...config,
        services: ["core", "portal"],
        secretEnv: { portal: { TOKEN: "DEPLOYMENT_CONTROL_SECRET" } },
      }),
    /only to core/,
  );
});
