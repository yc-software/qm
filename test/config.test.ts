import { test } from "node:test";
import assert from "node:assert/strict";
import {
  companySubscriptionAuth,
  baseModelProviders,
  loadConfig,
  configuredModel,
  providerKeysPresent,
  CONFIG_DEFAULTS,
} from "../src/config.ts";
import { boolEnv, numEnv } from "../src/config-env.ts";

const productionEnv = {
  NODE_ENV: "production",
  CORE_SIGNING_SECRET: "core-signing-secret-0123456789abcdef",
  CAPABILITY_SECRET: "capabilities",
  PORTAL_IDENTITY_SECRET: "portal",
  CONNECTOR_SECRET_KEY: "connector-secret-0123456789abcdef",
  SANDBOX_BACKEND: "local",
  DATABASE_URL: "postgres://qm@localhost/qm",
} as const;

test("capability compression is explicitly enabled after verifier rollout", () => {
  assert.equal(loadConfig({}).capabilityTokenCompression, false);
  assert.equal(loadConfig({ CAPABILITY_TOKEN_COMPRESSION: "0" }).capabilityTokenCompression, false);
  assert.equal(loadConfig({ CAPABILITY_TOKEN_COMPRESSION: "1" }).capabilityTokenCompression, true);
  assert.throws(() => loadConfig({ CAPABILITY_TOKEN_COMPRESSION: "invalid" }), /CAPABILITY_TOKEN_COMPRESSION/);
});

test("ORG_BRAND_* parses into a validated branding default", () => {
  assert.equal(loadConfig({}).brandingDefault, undefined);
  assert.deepEqual(
    loadConfig({ ORG_BRAND_ACCENT: "#6366f1", ORG_BRAND_MARK: "Q", ORG_BRAND_SELF_LABEL: "qm" }).brandingDefault,
    { accent: "#6366f1", mark: "Q", selfLabel: "qm" },
  );
  assert.equal(loadConfig({ ORG_BRAND_ACCENT: "#abcde" }).brandingDefault, undefined);
  assert.deepEqual(loadConfig({ ORG_BRAND_MARK: 'a"bc' }).brandingDefault, { mark: "ab" });
  assert.equal(loadConfig({ ORG_BRAND_SELF_LABEL: "x".repeat(80) }).brandingDefault?.selfLabel?.length, 80);
  assert.deepEqual(loadConfig({ ORG_BRAND_ORG_NAME: "Acme Corp" }).brandingDefault, { orgName: "Acme Corp" });
  assert.equal(loadConfig({ ORG_BRAND_ORG_NAME: "x".repeat(80) }).brandingDefault?.orgName?.length, 80);
  assert.deepEqual(loadConfig({ ORG_BRAND_SELF_LABEL: "{{straylight}}" }).brandingDefault, { selfLabel: "straylight" });
});

test("AUTH_ALLOWED_EMAILS becomes a normalized email-auth principal set", () => {
  assert.equal(loadConfig({}).emailAuthPrincipals, undefined);
  assert.deepEqual(
    loadConfig({ AUTH_ALLOWED_EMAILS: " New@Example.com,other@example.com,new@example.com " }).emailAuthPrincipals,
    ["new@example.com", "other@example.com"],
  );
});

test("deploy provider defaults to docker and rejects unknown values", () => {
  assert.equal(loadConfig({}).deployProvider, "docker");
  assert.throws(() => loadConfig({ DEPLOY_PROVIDER: "fly" }), /DEPLOY_PROVIDER="fly" is not recognized/);
  assert.throws(() => loadConfig({ DEPLOY_PROVIDER: "flly" }), /DEPLOY_PROVIDER="flly" is not recognized/);
});

test("production is parsed once", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /missing or insecure required core secrets/);
  assert.equal(loadConfig(productionEnv).production, true);
  assert.equal(loadConfig({}).production, false);
});

test("the screen classifier follows the proxy settings", () => {
  assert.equal(loadConfig({}).securityScreenProxy, undefined);
  const proxy = {
    SECURITY_SCREEN_PROXY_PROVIDER: "example-screen",
    SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
    SECURITY_SCREEN_PROXY_TOKEN: "test-token",
  };
  assert.deepEqual(loadConfig(proxy).securityScreenProxy, {
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
  });
  assert.throws(
    () => loadConfig({ SECURITY_SCREEN_PROXY_PROVIDER: "example-screen" }),
    /SECURITY_SCREEN_PROXY_PROVIDER, SECURITY_SCREEN_PROXY_ENDPOINT, and SECURITY_SCREEN_PROXY_TOKEN must be set together/,
  );
  for (const provider of ["Bad Provider", "surface", "origin", "-leading", `${"x".repeat(64)}`]) {
    assert.throws(
      () => loadConfig({ ...proxy, SECURITY_SCREEN_PROXY_PROVIDER: provider }),
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
      () => loadConfig({ ...proxy, SECURITY_SCREEN_PROXY_ENDPOINT: endpoint }),
      /SECURITY_SCREEN_PROXY_ENDPOINT/,
    );
  }
});

test("a remote sandbox backend without the shared egress proxy warns once", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    loadConfig({ SANDBOX_BACKEND: "modal", MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" });
    loadConfig({
      SANDBOX_BACKEND: "modal",
      MODAL_TOKEN_ID: "id",
      MODAL_TOKEN_SECRET: "secret",
      SANDBOX_EGRESS_PROXY_URL: "https://egress.test",
    });
    loadConfig({ SANDBOX_BACKEND: "local" });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.filter((w) => w.includes("without SANDBOX_EGRESS_PROXY_URL")).length, 1);
});

test("boolEnv: one vocabulary for every boolean env knob", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) assert.equal(boolEnv(v), true, v);
  for (const v of ["0", "false", "no", "off", "none", "OFF"]) assert.equal(boolEnv(v), false, v);
  for (const v of [undefined, "", "2", "enabled"]) assert.equal(boolEnv(v), undefined, String(v));
});

test("every boolean knob accepts the shared vocabulary (off means off)", () => {
  assert.equal(loadConfig({ REACH_EXEC: "off" }).reachExecEnabled, false);
  assert.equal(loadConfig({ REACH_EXEC: "1" }).reachExecEnabled, true);
});

test("numEnv: empty and non-numeric values fall back instead of poisoning config with NaN", () => {
  assert.equal(numEnv(""), undefined);
  assert.equal(numEnv("abc"), undefined);
  assert.equal(numEnv("42"), 42);
  assert.equal(loadConfig({ PORT: "" }).port, CONFIG_DEFAULTS.port);
});

test("a set-but-unparseable env value refuses to boot instead of silently taking the default", () => {
  assert.throws(() => loadConfig({ WORKERS: "not-a-number" }), /WORKERS="not-a-number" is not a number/);
  assert.throws(() => loadConfig({ BUDGET_USD_PER_WINDOW: "10$" }), /BUDGET_USD_PER_WINDOW="10\$" is not a number/);
  assert.throws(() => loadConfig({ REACH_EXEC: "2" }), /REACH_EXEC="2" is not a recognized boolean/);
  assert.throws(() => loadConfig({ SANDBOX_BACKEND: "docker" }), /SANDBOX_BACKEND="docker" is not recognized/);
  assert.equal(loadConfig({ WORKERS: "  " }).workers, CONFIG_DEFAULTS.workers);
  assert.equal(loadConfig({ REACH_EXEC: "" }).reachExecEnabled, false);
});

test("sandbox backend is parsed once before production backend guards", () => {
  assert.equal(loadConfig({ SANDBOX_BACKEND: " e2b ", E2B_API_KEY: "e2b_k" }).sandboxBackend, "e2b");
  assert.throws(
    () => loadConfig({ ...productionEnv, SANDBOX_BACKEND: "bogus" }),
    /SANDBOX_BACKEND="bogus" is not recognized/,
  );
});

test("production refuses to boot without Postgres", () => {
  const { DATABASE_URL: _databaseUrl, ...noDatabase } = productionEnv;
  assert.throws(
    () => loadConfig(noDatabase),
    /missing or insecure required core secrets: DATABASE_URL \(.*resident disk\)/,
  );
  assert.doesNotThrow(() => loadConfig(productionEnv));
  assert.doesNotThrow(
    () => loadConfig({ SANDBOX_BACKEND: "local" }),
    "a single-process dev instance needs no durable store",
  );
});

test("production refuses missing, placeholder, or weak signing keys", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /CAPABILITY_SECRET, CONNECTOR_SECRET_KEY, CORE_SIGNING_SECRET, PORTAL_IDENTITY_SECRET/,
  );
  assert.throws(
    () => loadConfig({ ...productionEnv, CORE_SIGNING_SECRET: "short" }),
    /core secrets: CORE_SIGNING_SECRET$/,
  );
  assert.throws(
    () => loadConfig({ ...productionEnv, CONNECTOR_SECRET_KEY: "short" }),
    /core secrets: CONNECTOR_SECRET_KEY$/,
  );
  assert.throws(
    () => loadConfig({ ...productionEnv, CAPABILITY_SECRET: "replace-me" }),
    /core secrets: CAPABILITY_SECRET$/,
  );
});

test("defaults come from CONFIG_DEFAULTS, set exactly once", () => {
  const def = loadConfig({});
  assert.equal(CONFIG_DEFAULTS.workers, 16);
  assert.equal(def.workers, CONFIG_DEFAULTS.workers);
});

test("PUBLIC_API_URL is not treated as the human-facing web URL", () => {
  const apiOnly = loadConfig({ PUBLIC_API_URL: "https://agent-api.example" });
  assert.equal(apiOnly.apiBaseUrl, "https://agent-api.example");
  assert.equal(apiOnly.publicUrl, "https://agent-api.example");
  assert.equal(apiOnly.publicWebUrl, undefined);

  const disabledWeb = loadConfig({ PUBLIC_API_URL: "https://agent-api.example", PUBLIC_WEB_URL: "" });
  assert.equal(disabledWeb.apiBaseUrl, "https://agent-api.example");
  assert.equal(disabledWeb.publicUrl, "https://agent-api.example");
  assert.equal(disabledWeb.publicWebUrl, undefined);

  const web = loadConfig({ PUBLIC_API_URL: "https://agent-api.example/", PUBLIC_WEB_URL: "https://portal.example//" });
  assert.equal(web.apiBaseUrl, "https://agent-api.example");
  assert.equal(web.publicUrl, "https://portal.example");
  assert.equal(web.publicWebUrl, "https://portal.example");
  const slack = loadConfig({
    SLACK_BOT_TOKEN: "xoxb-1",
    SLACK_APP_TOKEN: "xapp-1",
    WEB_UI_PUBLIC_URL: " https://web.example/ ",
  });
  assert.equal(slack.slack?.webUiPublicUrl, "https://web.example");
});

test("the server can boot before an admin configures a model provider", () => {
  assert.doesNotThrow(() => loadConfig({}));
  assert.doesNotThrow(() => loadConfig({ ANTHROPIC_API_KEY: "sk-ant" }));
  assert.doesNotThrow(() => loadConfig(productionEnv));
  assert.doesNotThrow(() => loadConfig({ ...productionEnv, ANTHROPIC_API_KEY: "sk-ant" }));
});

test("SANDBOX_BACKEND: unset defaults to local (dev only); the retired secondary variable is tolerated", () => {
  assert.equal(loadConfig({}).sandboxBackend, "local");
  assert.throws(
    () => loadConfig({ ...productionEnv, SANDBOX_BACKEND: undefined }),
    /SANDBOX_BACKEND must be set explicitly in production/,
  );
  assert.throws(() => loadConfig({ SANDBOX_BACKEND: "sprites" }), /SPRITES_TOKEN/);
  for (const retired of ["agent37", "superserve", "porter", "aws"])
    assert.throws(() => loadConfig({ SANDBOX_BACKEND: retired }), /not recognized/);
});

test("Slack runtime settings are parsed once into Config", () => {
  const config = loadConfig({
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_API_URL: "https://slack.example/api",
  });
  assert.deepEqual(config.slack, {
    botToken: "xoxb-test",
    appToken: "xapp-test",
    apiUrl: "https://slack.example/api",
  });
});

test("MODEL_PROVIDER declares the vendor that bills the base model", () => {
  assert.equal(loadConfig({}).modelProvider, undefined);
  assert.equal(loadConfig({ MODEL_PROVIDER: " openrouter ", OPENROUTER_API_KEY: "k" }).modelProvider, "openrouter");
  assert.throws(() => loadConfig({ MODEL_PROVIDER: "bedrock" }), /MODEL_PROVIDER.*not recognized/);
});

test("baseModelProviders constrains the base model only when a provider is declared", () => {
  assert.deepEqual(
    baseModelProviders(loadConfig({ MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "k" })),
    { anthropic: false, openai: false, openrouter: true },
    "the declaration outranks a stray key from another vendor",
  );
  assert.equal(
    baseModelProviders(loadConfig({ OPENROUTER_API_KEY: "k" })),
    undefined,
    "with no declaration the shipped default stands, so upgrading never moves a deployment's model or its billing",
  );
});

test("DEPLOY_PROVIDER=porter selects the Porter deploy provider and reads its env", () => {
  const config = loadConfig({
    DEPLOY_PROVIDER: "porter",
    PORTER_DEPLOY_PROJECT_ID: "7",
    PORTER_DEPLOY_CLUSTER_ID: "9",
    PORTER_DEPLOY_API_TOKEN: "tok",
    PORTER_DEPLOY_APPS_DOMAIN: "apps.example.com",
    PORTER_DEPLOY_RUNNER_IMAGE: "ghcr.io/x/runner:1",
    PORTER_DEPLOY_VISIBILITY: "private",
  });
  assert.equal(config.deployProvider, "porter");
  assert.deepEqual(config.porterDeploy, {
    token: "tok",
    baseUrl: "https://dashboard.porter.run/api/v2/alpha/projects/7/clusters/9",
    runnerImage: "ghcr.io/x/runner:1",
    appsDomain: "apps.example.com",
    visibility: "private",
  });
});

test("DEPLOY_PROVIDER=e2b selects E2B publishing and needs the E2B key", () => {
  assert.equal(loadConfig({ DEPLOY_PROVIDER: "e2b", E2B_API_KEY: "e2b-key" }).deployProvider, "e2b");
  assert.throws(() => loadConfig({ DEPLOY_PROVIDER: "e2b" }), /missing or insecure required core secrets: E2B_API_KEY/);
});

test("DEPLOY_PROVIDER=porter refuses to boot without a cluster and tolerates a missing apps domain", () => {
  assert.throws(
    () =>
      loadConfig({
        DEPLOY_PROVIDER: "porter",
        PORTER_DEPLOY_API_TOKEN: "tok",
        PORTER_DEPLOY_APPS_DOMAIN: "apps.example.com",
      }),
    /PORTER_DEPLOY_PROJECT_ID/,
  );
  assert.equal(
    loadConfig({
      DEPLOY_PROVIDER: "porter",
      PORTER_DEPLOY_API_TOKEN: "tok",
      PORTER_DEPLOY_PROJECT_ID: "7",
      PORTER_DEPLOY_CLUSTER_ID: "9",
    }).porterDeploy.appsDomain,
    undefined,
  );
  assert.throws(
    () =>
      loadConfig({
        DEPLOY_PROVIDER: "porter",
        PORTER_DEPLOY_API_TOKEN: "tok",
        PORTER_DEPLOY_PROJECT_ID: "7",
        PORTER_DEPLOY_CLUSTER_ID: "9",
        PORTER_DEPLOY_APPS_DOMAIN: "a.b",
        PORTER_DEPLOY_VISIBILITY: "hidden",
      }),
    /PORTER_DEPLOY_VISIBILITY/,
  );
});

test("PORTER_DEPLOY_VISIBILITY=internal is accepted and refuses an apps domain", () => {
  const cluster = {
    DEPLOY_PROVIDER: "porter",
    PORTER_DEPLOY_API_TOKEN: "tok",
    PORTER_DEPLOY_PROJECT_ID: "7",
    PORTER_DEPLOY_CLUSTER_ID: "9",
    PORTER_DEPLOY_VISIBILITY: "internal",
  };
  assert.equal(loadConfig(cluster).porterDeploy.visibility, "internal");
  assert.throws(
    () => loadConfig({ ...cluster, PORTER_DEPLOY_APPS_DOMAIN: "apps.example.com" }),
    /PORTER_DEPLOY_APPS_DOMAIN/,
  );
});

test("DEPLOY_PROVIDER=porter locates the API", () => {
  assert.throws(
    () => loadConfig({ DEPLOY_PROVIDER: "porter", PORTER_DEPLOY_API_TOKEN: "tok" }),
    /PORTER_DEPLOY_PROJECT_ID/,
  );
  const inCluster = loadConfig({ DEPLOY_PROVIDER: "porter", PORTER_DEPLOY_API_TOKEN: "tok", PORTER_CLUSTER_ID: "3" });
  assert.equal(inCluster.porterDeploy.token, "tok");
});

test("DEPLOY_APPS_DOMAIN is the one-var apps setup: it feeds the gate and defaults every provider's domain", () => {
  const config = loadConfig({
    DEPLOY_PROVIDER: "porter",
    PORTER_DEPLOY_API_TOKEN: "tok",
    PORTER_DEPLOY_PROJECT_ID: "7",
    PORTER_DEPLOY_CLUSTER_ID: "9",
    DEPLOY_APPS_DOMAIN: "apps.example.com",
    AWS_DEPLOY_GATE_SECRET: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(config.deployAppsDomain, "apps.example.com");
  assert.equal(
    config.porterDeploy.appsDomain,
    undefined,
    "the gate domain must not be registered on Porter ingress — that would bypass the gate or loop the proxy",
  );
  assert.equal(config.awsDeploy.appsDomain, "apps.example.com");
  const overridden = loadConfig({
    DEPLOY_PROVIDER: "porter",
    PORTER_DEPLOY_API_TOKEN: "tok",
    PORTER_DEPLOY_PROJECT_ID: "7",
    PORTER_DEPLOY_CLUSTER_ID: "9",
    DEPLOY_APPS_DOMAIN: "apps.example.com",
    PORTER_DEPLOY_APPS_DOMAIN: "apps.other.example.com",
    AWS_DEPLOY_GATE_SECRET: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(overridden.porterDeploy.appsDomain, "apps.other.example.com");
  assert.equal(overridden.deployAppsDomain, "apps.example.com");
});

test("the active provider's own apps domain reaches the gate when DEPLOY_APPS_DOMAIN is unset", () => {
  const porter = loadConfig({
    DEPLOY_PROVIDER: "porter",
    PORTER_DEPLOY_API_TOKEN: "tok",
    PORTER_DEPLOY_PROJECT_ID: "7",
    PORTER_DEPLOY_CLUSTER_ID: "9",
    PORTER_DEPLOY_APPS_DOMAIN: "apps.example.com",
  });
  assert.equal(porter.deployAppsDomain, "apps.example.com");
  assert.equal(porter.awsDeploy.appsDomain, undefined);
  assert.equal(porter.porterDeploy.appsDomain, "apps.example.com");
  const aws = loadConfig({
    DEPLOY_APPS_DOMAIN: "apps.example.com",
    AWS_DEPLOY_GATE_SECRET: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(aws.deployAppsDomain, "apps.example.com");
  assert.equal(aws.awsDeploy.appsDomain, "apps.example.com");
  assert.equal(loadConfig({}).deployAppsDomain, undefined);
});

test("DEPLOY_APPS_DOMAIN refuses shared platform domains that cannot carry per-app subdomains", () => {
  assert.throws(() => loadConfig({ DEPLOY_APPS_DOMAIN: "myapp.onporter.run" }), /shared platform domain/);
  assert.throws(() => loadConfig({ DEPLOY_APPS_DOMAIN: "myapp.fly.dev" }), /shared platform domain/);
  assert.throws(() => loadConfig({ DEPLOY_APPS_DOMAIN: "8081-abc.e2b.app" }), /shared platform domain/);
  assert.equal(
    loadConfig({ DEPLOY_APPS_DOMAIN: "apps.example.com", AWS_DEPLOY_GATE_SECRET: "0123456789abcdef0123456789abcdef" })
      .deployAppsDomain,
    "apps.example.com",
  );
});

test("DEPLOY_APPS_DOMAIN must be a bare DNS name, normalized to lowercase without a trailing dot", () => {
  const gate = { AWS_DEPLOY_GATE_SECRET: "0123456789abcdef0123456789abcdef" };
  assert.equal(loadConfig({ DEPLOY_APPS_DOMAIN: "Apps.Example.COM.", ...gate }).deployAppsDomain, "apps.example.com");
  assert.throws(() => loadConfig({ DEPLOY_APPS_DOMAIN: "https://apps.example.com", ...gate }), /bare domain/);
  assert.throws(() => loadConfig({ DEPLOY_APPS_DOMAIN: "apps.example.com:443@evil.example", ...gate }), /bare domain/);
  assert.throws(() => loadConfig({ DEPLOY_APPS_DOMAIN: "*.apps.example.com", ...gate }), /bare domain/);
  assert.throws(() => loadConfig({ DEPLOY_APPS_DOMAIN: "myapp.fly.dev.", ...gate }), /shared platform domain/);
});

test("the portal session secret is the deploy-apps viewer secret when a login URL exists", () => {
  const derived = loadConfig({ PORTAL_SESSION_SECRET: "shared", PUBLIC_WEB_URL: "https://qm.example.com" });
  assert.equal(derived.deployAppsSessionSecret, "shared");
  assert.equal(derived.deployAppsLoginUrl, "https://qm.example.com");
  const noUrl = loadConfig({ PORTAL_SESSION_SECRET: "shared" });
  assert.equal(
    noUrl.deployAppsSessionSecret,
    undefined,
    "no sign-in address means the fallback stays off, not a throw",
  );
});

test("the deploy-apps sign-in address defaults to the public web URL", () => {
  const derived = loadConfig({
    PORTAL_SESSION_SECRET: "s",
    PUBLIC_WEB_URL: "https://qm.example.com/",
  });
  assert.equal(derived.deployAppsLoginUrl, "https://qm.example.com");
  assert.equal(derived.deployAppsSessionSecret, "s");
  assert.equal(derived.deployAppsLoginPath, "/auth/login");
  assert.equal(
    loadConfig({
      PORTAL_SESSION_SECRET: "s",
      PUBLIC_WEB_URL: "https://qm.example.com",
      DEPLOY_APPS_LOGIN_PATH: "/auth/trusted/login",
    }).deployAppsLoginPath,
    "/auth/trusted/login",
  );
  assert.throws(() => loadConfig({ DEPLOY_APPS_LOGIN_PATH: "//evil.example" }), /DEPLOY_APPS_LOGIN_PATH/);
  const explicit = loadConfig({
    PORTAL_SESSION_SECRET: "s",
    DEPLOY_APPS_LOGIN_URL: "https://portal.example.com/",
    PUBLIC_WEB_URL: "https://qm.example.com",
  });
  assert.equal(explicit.deployAppsLoginUrl, "https://portal.example.com");
  assert.equal(loadConfig({ PORTAL_SESSION_SECRET: "s" }).deployAppsSessionSecret, undefined);
  assert.throws(
    () => loadConfig({ DEPLOY_APPS_LOGIN_URL: "https://portal.example.com" }),
    /requires PORTAL_SESSION_SECRET/,
  );
});

test("company Claude subscription auth comes from the keychain credential, not the API key's text", () => {
  assert.equal(companySubscriptionAuth(loadConfig({ ANTHROPIC_API_KEY: "sk-ant-oat01-company" })), undefined);
  assert.equal(companySubscriptionAuth(loadConfig({ ANTHROPIC_API_KEY: "sk-ant-api" })), undefined);
  const keychainHeld = loadConfig({ CLAUDE_AUTH_CREDENTIAL: "cred-1" });
  assert.equal(providerKeysPresent(keychainHeld).anthropic, true);
  assert.equal(companySubscriptionAuth(keychainHeld), "anthropic");
});

test("company ChatGPT auth satisfies model onboarding without an API key", () => {
  const config = loadConfig({});
  assert.equal(companySubscriptionAuth({ ...config, codexAuthCredential: "cred-1" }), "openai");
  assert.equal(companySubscriptionAuth(config), undefined);
  assert.equal(providerKeysPresent({ ...config, codexAuthCredential: "cred-1" }).codexOAuth, true);
  assert.equal(loadConfig({ MODEL_PROVIDER: "openai", CODEX_AUTH_CREDENTIAL: "cred-1" }).codexAuthCredential, "cred-1");
});

test("shared SANDBOX_* settings are parsed once for every provider", () => {
  const config = loadConfig({
    SANDBOX_NAME_PREFIX: "qmdev",
    SANDBOX_EGRESS_PROXY_URL: "https://proxy.example.com",
    SANDBOX_SNAPSHOT_INTERVAL_SEC: "120",
    SANDBOX_CPUS: "2",
    SANDBOX_MEMORY_MB: "4096",
    SANDBOX_DISK_GB: "20",
    SANDBOX_IDLE_PARK_SEC: "900",
    SANDBOX_MAX_LIFETIME_SEC: "3600",
  });
  assert.deepEqual(config.sandbox, {
    namePrefix: "qmdev",
    egressProxyUrl: "https://proxy.example.com",
    snapshotIntervalSec: 120,
    cpus: 2,
    memoryMb: 4096,
    diskGb: 20,
    idleParkSec: 900,
    maxLifetimeSec: 3600,
  });
  assert.deepEqual(loadConfig({}).sandbox, {});
  assert.throws(() => loadConfig({ SANDBOX_IDLE_PARK_SEC: "soon" }), /SANDBOX_IDLE_PARK_SEC/);
});

test("suggestion generation defaults on and can be explicitly disabled", () => {
  assert.equal(loadConfig({}).suggestedActivitiesEnabled, true);
  assert.equal(loadConfig({ SUGGESTED_ACTIVITIES_ENABLED: "true" }).suggestedActivitiesEnabled, true);
  assert.equal(loadConfig({ SUGGESTED_ACTIVITIES_ENABLED: "false" }).suggestedActivitiesEnabled, false);
  assert.throws(() => loadConfig({ SUGGESTED_ACTIVITIES_ENABLED: "maybe" }));
  const context = "The team ships on Fridays. ".repeat(400);
  assert.equal(loadConfig({ SUGGESTED_ACTIVITIES_CONTEXT: context }).suggestedActivitiesContext, context);
});

test("background ownership requires durable storage and an independent deployment authority", () => {
  const env = {
    BACKGROUND_DEPLOYMENT_ID: "core:release-a",
    DATABASE_URL: "postgres://localhost/test",
    CORE_SIGNING_SECRET: "source-signing-secret-0123456789abcdef",
    CAPABILITY_SECRET: "capability-secret-0123456789abcdef0123",
    PORTAL_IDENTITY_SECRET: "portal-identity-secret-0123456789abcdef",
    DEPLOYMENT_CONTROL_SECRET: "deployment-control-secret-0123456789abcdef",
  };
  const config = loadConfig(env);
  assert.equal(config.backgroundDeploymentId, env.BACKGROUND_DEPLOYMENT_ID);
  assert.equal(config.deploymentControlSecret, env.DEPLOYMENT_CONTROL_SECRET);
  assert.equal(config.backgroundWorkEnabled, true);
  assert.equal(loadConfig({ ...env, BACKGROUND_WORK_ENABLED: "false" }).backgroundWorkEnabled, false);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: "" }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ ...env, DEPLOYMENT_CONTROL_SECRET: "short" }), /distinct DEPLOYMENT_CONTROL_SECRET/);
  assert.throws(
    () => loadConfig({ ...env, DEPLOYMENT_CONTROL_SECRET: env.CORE_SIGNING_SECRET }),
    /distinct DEPLOYMENT_CONTROL_SECRET/,
  );
  assert.throws(() => loadConfig({ ...env, BACKGROUND_DEPLOYMENT_ID: " " }), /BACKGROUND_DEPLOYMENT_ID/);
  const longId = `core:${"release-".repeat(40)}end`;
  assert.equal(loadConfig({ ...env, BACKGROUND_DEPLOYMENT_ID: longId }).backgroundDeploymentId, longId);
  assert.throws(() => loadConfig({ ...env, CORE_SIGNING_SECRET: "short" }), /CORE_SIGNING_SECRET/);
  assert.throws(() => loadConfig({ ...env, DEPLOYMENT_CONTROL_SECRET: " ".repeat(32) }), /DEPLOYMENT_CONTROL_SECRET/);
});

test("the spend export token is optional, strong, trimmed and never shared with another environment value", () => {
  const env = {
    CORE_SIGNING_SECRET: "source-signing-secret-0123456789abcdef",
    CAPABILITY_SECRET: "capability-secret-0123456789abcdef0123",
    PORTAL_IDENTITY_SECRET: "portal-identity-secret-0123456789abcdef",
    SPEND_EXPORT_TOKEN: "spend-export-token-0123456789abcdef01234",
  };
  assert.equal(loadConfig(env).spendExportToken, env.SPEND_EXPORT_TOKEN);
  assert.equal(loadConfig({ ...env, SPEND_EXPORT_TOKEN: undefined }).spendExportToken, undefined);
  assert.equal(loadConfig({ ...env, SPEND_EXPORT_TOKEN: "" }).spendExportToken, undefined);
  assert.throws(() => loadConfig({ ...env, SPEND_EXPORT_TOKEN: "short" }), /SPEND_EXPORT_TOKEN/);
  assert.throws(() => loadConfig({ ...env, SPEND_EXPORT_TOKEN: " ".repeat(40) }), /SPEND_EXPORT_TOKEN/);
  assert.throws(() => loadConfig({ ...env, SPEND_EXPORT_TOKEN: `${env.SPEND_EXPORT_TOKEN}\n` }), /SPEND_EXPORT_TOKEN/);
  for (const name of [
    "CORE_SIGNING_SECRET",
    "QM_SLACK_SERVICE_TOKEN",
    "PORTAL_SESSION_SECRET",
    "SLACK_SIGNING_SECRET",
  ]) {
    assert.throws(
      () => loadConfig({ ...env, [name]: env.SPEND_EXPORT_TOKEN }),
      /SPEND_EXPORT_TOKEN/,
      `${name} must not share the export token`,
    );
  }
});

test("a subscription-only company ChatGPT deployment defaults pi to the plain Codex model id", () => {
  const base = loadConfig({});
  assert.equal(configuredModel({ ...base, codexAuthCredential: "cred-1" }), "gpt-5.6-sol");
  assert.equal(configuredModel({ ...base, codexAuthCredential: "cred-1", anthropicApiKey: "k" }), undefined);
  assert.equal(configuredModel({ ...base, codexAuthCredential: "cred-1", modelId: "claude-opus-5" }), "claude-opus-5");
  assert.equal(configuredModel(base), undefined);
});

test("background work defaults on and BACKGROUND_WORK_ENABLED turns it off", () => {
  assert.equal(loadConfig({}).backgroundWorkEnabled, true);
  assert.equal(loadConfig({ BACKGROUND_WORK_ENABLED: "0" }).backgroundWorkEnabled, false);
  assert.throws(() => loadConfig({ BACKGROUND_WORK_ENABLED: "sometimes" }), /BACKGROUND_WORK_ENABLED/);
});

test("the Docker target's QM_CORE_CONTAINER reaches the local sandbox", () => {
  assert.equal(loadConfig({ QM_CORE_CONTAINER: "qm-acme-core" }).localSandbox.coreContainer, "qm-acme-core");
  assert.equal(loadConfig({}).localSandbox.coreContainer, undefined);
});
