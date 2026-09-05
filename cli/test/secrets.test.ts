import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxCoreEnv, type QmConfig } from "../src/config.ts";
import { FLY_TEMPLATE_ENV_DEFAULTS } from "../src/target-env-defaults.ts";
import {
  computedSecrets,
  renderEnvExample,
  runtimeSecretNames,
  secretDestinations,
  secretsForService,
  type ComputedSecret,
} from "../src/secrets.ts";
import { isReservedContainerName, pluginNameError, SERVICE_NAMES } from "../src/services.ts";

function makeConfig(overrides: Partial<QmConfig> = {}): QmConfig {
  return {
    contract: 1,
    orgId: "acme",
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

test("a dual-role secret (sandbox.secretEnv + virtual service) needs BOTH names on core", () => {
  const config = makeConfig({
    services: ["core", "slack"],
    sandbox: { app: "acme-sb", secretEnv: ["SLACK_BOT_TOKEN"] },
  });
  const names = runtimeSecretNames("core", secretByName(config, "SLACK_BOT_TOKEN"));
  assert.deepEqual(names.sort(), ["FLY_RESIDENT_ENV_SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN"]);
});

test("a sandbox-only secret lands on core ONLY as FLY_RESIDENT_ENV_<NAME>", () => {
  const config = makeConfig({ sandbox: { app: "acme-sb", secretEnv: ["COMPANY_TOKEN"] } });
  const secret = secretByName(config, "COMPANY_TOKEN");
  assert.deepEqual(runtimeSecretNames("core", secret), ["FLY_RESIDENT_ENV_COMPANY_TOKEN"]);
  assert.deepEqual([...secretDestinations(secret).keys()], ["core"]);
});

test("a core + sandbox secret needs both the plain and renamed forms on core", () => {
  const config = makeConfig({
    env: { core: { HARNESS: "pi" } },
    sandbox: { app: "acme-sb", secretEnv: ["ANTHROPIC_API_KEY"] },
  });
  const names = runtimeSecretNames("core", secretByName(config, "ANTHROPIC_API_KEY"));
  assert.deepEqual(names.sort(), ["ANTHROPIC_API_KEY", "FLY_RESIDENT_ENV_ANTHROPIC_API_KEY"]);
});

test("a virtual-only secret keeps its plain name on core (the virtual service runs in-process)", () => {
  const config = makeConfig({ services: ["core", "slack"] });
  const secret = secretByName(config, "SLACK_APP_TOKEN");
  assert.deepEqual(runtimeSecretNames("core", secret), ["SLACK_APP_TOKEN"]);
  assert.ok(secretsForService(config, "core").some((s) => s.name === "SLACK_APP_TOKEN"));
});

test("split security keys are required and routed only to their trust boundary", () => {
  const config = makeConfig({ services: ["core", "portal"] });
  for (const name of ["CAPABILITY_SECRET", "CONNECTOR_SECRET_KEY"] as const) {
    const secret = secretByName(config, name);
    assert.equal(secret.required, true);
    assert.deepEqual([...secretDestinations(secret).keys()], ["core"]);
  }
  const identity = secretByName(config, "PORTAL_IDENTITY_SECRET");
  assert.equal(identity.required, true);
  assert.deepEqual([...secretDestinations(identity).keys()].sort(), ["core", "portal"]);
  const example = renderEnvExample(config);
  for (const name of ["CORE_SIGNING_SECRET", "CAPABILITY_SECRET", "PORTAL_IDENTITY_SECRET", "CONNECTOR_SECRET_KEY"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  }
});

test("portal deployment coordinates can come from the target secret store", () => {
  const secretBacked = makeConfig({ services: ["core", "portal"], env: { portal: { OIDC_PRINCIPAL_CLAIM: "email" } } });
  for (const name of ["OIDC_CLIENT_ID", "PORTAL_EXPECTED_TEAM_ID"]) {
    const secret = secretByName(secretBacked, name);
    assert.equal(secret.required, true);
    assert.deepEqual(runtimeSecretNames("portal", secret), [name]);
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
  assert.deepEqual(runtimeSecretNames("core", secret), ["ADMIN_GRANTS"]);
  assert.ok(!computedSecrets(makeConfig()).some((item) => item.name === "ADMIN_GRANTS"));
});

test("a plugin secret lands plain on the plugin's own workload, nowhere else", () => {
  const config = makeConfig({
    plugins: [{ name: "linear", image: "ghcr.io/x:1", secrets: [{ name: "PLUG_TOKEN" }] }],
  });
  const secret = secretByName(config, "PLUG_TOKEN");
  assert.deepEqual(runtimeSecretNames("linear", secret), ["PLUG_TOKEN"]);
  assert.deepEqual(runtimeSecretNames("core", secret), []);
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
  const flyMock = makeConfig({ target: "fly", env: { core: { HARNESS: "mock" } } });
  assert.equal(secretByName(flyMock, "ANTHROPIC_API_KEY").required, false);
  const docker = makeConfig();
  assert.equal(secretByName(docker, "ANTHROPIC_API_KEY").required, false);
});

test("the Fly sandbox token avoids flyctl's FLY_API_TOKEN authentication variable", () => {
  const fly = makeConfig({ target: "fly" });
  const sandbox = secretByName(fly, "FLY_SANDBOX_API_TOKEN");
  assert.ok(sandbox.required);
  assert.deepEqual(runtimeSecretNames("core", sandbox), ["FLY_API_TOKEN"]);
  assert.ok(!computedSecrets(fly).some((secret) => secret.name === "FLY_API_TOKEN"));
});

test("the Fly tokens belong to a Fly target, and the publisher token only to a Fly deploy provider", () => {
  assert.ok(secretByName(makeConfig({ target: "fly" }), "FLY_SANDBOX_API_TOKEN").required);
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
    !computedSecrets(makeConfig({ target: "aws", sandbox: { backend: "aws" } })).some(
      (secret) => secret.name === "SPRITES_TOKEN",
    ),
  );
});

test("the Agent37 key is required for either sandbox route", () => {
  for (const config of [
    makeConfig({ env: { core: { SANDBOX_BACKEND: "agent37" } } }),
    makeConfig({ env: { core: { SANDBOX_SECONDARY_BACKEND: "agent37" } } }),
    makeConfig({ sandbox: { backend: "agent37" } }),
  ]) {
    assert.equal(secretByName(config, "AGENT37_API_KEY").required, true);
  }
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
  // OPENAI_API_KEY keeps its own Codex rule, so it is absent rather than optional here.
  assert.ok(!computedSecrets(anthropic).some((secret) => secret.name === "OPENAI_API_KEY"));
});

test("an OpenAI base model and the Codex harness agree on one required key", () => {
  const both = makeConfig({ modelProvider: "openai", env: { core: { HARNESS: "codex" } } });
  const matches = computedSecrets(both).filter((secret) => secret.name === "OPENAI_API_KEY");
  assert.equal(matches.length, 1, "overlapping rules collapse to a single secret");
  assert.equal(matches[0]!.required, true);
});

test("omitting modelProvider preserves the pre-existing deferred-to-Admin behavior", () => {
  const deferred = makeConfig();
  assert.equal(secretByName(deferred, "ANTHROPIC_API_KEY").required, false);
  assert.equal(secretByName(deferred, "OPENROUTER_API_KEY").required, false);
});

test("conditional secret values use the runtime's trimmed enum semantics", () => {
  const pi = makeConfig({ env: { core: { HARNESS: "  pi  " } } });
  assert.equal(secretByName(pi, "ANTHROPIC_API_KEY").required, false);
  assert.ok(secretByName(pi, "PUBLIC_API_URL").required);

  const slack = makeConfig({ services: ["core", "slack"], env: { slack: { SLACK_EVENTS_MODE: "  http  " } } });
  assert.ok(secretByName(slack, "SLACK_SIGNING_SECRET").required);
});

test("AWS public app domains require and route their gate secret to core", () => {
  const disabled = makeConfig({ target: "aws" });
  assert.ok(!computedSecrets(disabled).some((secret) => secret.name === "AWS_DEPLOY_GATE_SECRET"));

  const enabled = makeConfig({ target: "aws", env: { core: { AWS_DEPLOY_APPS_DOMAIN: "apps.example.com" } } });
  const gate = secretByName(enabled, "AWS_DEPLOY_GATE_SECRET");
  assert.equal(gate.required, true);
  assert.deepEqual(runtimeSecretNames("core", gate), ["AWS_DEPLOY_GATE_SECRET"]);
  assert.ok(renderEnvExample(enabled).includes("AWS_DEPLOY_GATE_SECRET="));
});

test("real harnesses require and route the sandbox-reachable PUBLIC_API_URL to core", () => {
  for (const harness of ["pi", "opencode"]) {
    const real = makeConfig({ env: { core: { HARNESS: harness } } });
    const publicApi = secretByName(real, "PUBLIC_API_URL");
    assert.equal(publicApi.required, true);
    assert.deepEqual(runtimeSecretNames("core", publicApi), ["PUBLIC_API_URL"]);
    assert.ok(renderEnvExample(real).includes("PUBLIC_API_URL="));
  }
  assert.ok(
    !computedSecrets(makeConfig({ env: { core: { HARNESS: "mock" } } })).some((s) => s.name === "PUBLIC_API_URL"),
  );
});

test("FLY_TEMPLATE_ENV_DEFAULTS stays in sync with deploy/core/fly.toml", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const toml = readFileSync(join(root, "deploy", "core", "fly.toml"), "utf8");
  const packaged = readFileSync(join(root, "cli", "templates", "fly", "core.toml"), "utf8");
  for (const [name, value] of Object.entries(FLY_TEMPLATE_ENV_DEFAULTS.core ?? {})) {
    assert.match(
      toml,
      new RegExp(`^\\s*${name}\\s*=\\s*"${value}"`, "m"),
      `deploy/core/fly.toml sets ${name}="${value}"`,
    );
  }
  assert.doesNotMatch(toml, /^\s*DEPLOY_PROVIDER\s*=/m);
  assert.doesNotMatch(packaged, /^\s*DEPLOY_PROVIDER\s*=/m);
});

test("config secretEnv extras enter the computed set as required operator secrets, virtual services folding onto core", () => {
  const config = makeConfig({
    services: ["core", "slack"],
    secretEnv: { core: { OPENAI_API_KEY: "OPENAI_API_KEY" }, slack: { SLACK_AUX_BOT_TOKEN: "SLACK_AUX_BOT_TOKEN" } },
  });
  const openai = secretByName(config, "OPENAI_API_KEY");
  assert.equal(openai.required, true);
  assert.equal(openai.managedBy, "operator");
  assert.deepEqual(runtimeSecretNames("core", openai), ["OPENAI_API_KEY"]);
  const auxiliary = secretByName(config, "SLACK_AUX_BOT_TOKEN");
  assert.deepEqual(
    [...secretDestinations(auxiliary).keys()],
    ["core"],
    "a virtual service's extra folds onto the core",
  );
  assert.match(renderEnvExample(config), /^OPENAI_API_KEY=$/m);
});

test("a secretEnv alias delivers the stored secret under its declared env name only", () => {
  const config = makeConfig({
    services: ["core", "web-ui", "portal"],
    secretEnv: { core: { DEPLOY_APPS_SESSION_SECRET: "PORTAL_SESSION_SECRET" } },
  });
  const secret = secretByName(config, "PORTAL_SESSION_SECRET");
  assert.deepEqual(secret.services, ["portal"], "the alias adds no plain-name claim");
  assert.deepEqual(runtimeSecretNames("core", secret), ["DEPLOY_APPS_SESSION_SECRET"]);
  assert.deepEqual(runtimeSecretNames("portal", secret), ["PORTAL_SESSION_SECRET"]);
  assert.ok(secretsForService(config, "core").some((s) => s.name === "PORTAL_SESSION_SECRET"));
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
    ["admin", "core", "portal", "web-ui"],
    "core verifies with PORTAL_IDENTITY_SECRET, so a surface left without it signs with a different key and every request it makes is rejected",
  );
});

test("the invitation-email pair reaches core as optional secrets on every topology", () => {
  for (const name of ["RESEND_API_KEY", "AUTH_EMAIL_FROM"]) {
    const alone = secretByName(makeConfig(), name);
    assert.equal(alone.required, false);
    assert.deepEqual([...secretDestinations(alone).keys()], ["core"]);
    assert.match(alone.description, /admin Users tab or by chatting with QM/);
    assert.match(renderEnvExample(makeConfig()), new RegExp(`^# ${name}=  # optional$`, "m"));

    const broker = makeConfig({
      services: ["core", "portal", "auth"],
      env: { auth: { AUTH_EMAIL_TRANSPORT: "resend" } },
    });
    const shared = secretByName(broker, name);
    assert.equal(shared.required, false);
    assert.deepEqual([...secretDestinations(shared).keys()].sort(), ["auth", "core"]);
  }
});

test("a fly deployment tells core which sandbox substrate to boot", () => {
  const config = makeConfig({
    target: "fly",
    sandbox: {
      app: "acme-sb",
      image: "registry.fly.io/acme-sb@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
    },
  });
  assert.equal(
    sandboxCoreEnv(config).env.SANDBOX_BACKEND,
    "sprites",
    "core refuses to boot in production unless SANDBOX_BACKEND is set explicitly",
  );
});

test("an explicit sandbox.backend wins, and non-fly targets keep their own default", () => {
  const pinned = makeConfig({
    target: "fly",
    sandbox: {
      app: "acme-sb",
      backend: "sprites",
      image: "registry.fly.io/acme-sb@sha256:2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b",
    },
  });
  assert.equal(sandboxCoreEnv(pinned).env.SANDBOX_BACKEND, "sprites");
  const docker = makeConfig({
    sandbox: {
      app: "acme-sb",
      image: "registry.fly.io/acme-sb@sha256:3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c",
    },
  });
  assert.equal(sandboxCoreEnv(docker).env.SANDBOX_BACKEND, undefined);
});

test("the .env.example catalog names every secret exactly once", () => {
  for (const services of [["core"], ["core", "portal"], ["core", "portal", "auth"], SERVICE_NAMES] as const) {
    const rendered = renderEnvExample(makeConfig({ services: [...services] as QmConfig["services"] }));
    const declared = rendered
      .split("\n")
      .map((line) => /^#?\s*([A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
    const duplicated = declared.filter((name, i) => declared.indexOf(name) !== i);
    assert.deepEqual(duplicated, [], `services=${services.join("+")} lists a secret twice`);
  }
});
