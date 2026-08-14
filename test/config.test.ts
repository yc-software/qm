import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { baseModelProviders, boolEnv, loadConfig, numEnv, CONFIG_DEFAULTS } from "../src/config.ts";

const productionEnv = {
  NODE_ENV: "production",
  CORE_SIGNING_SECRET: "core-signing-secret-0123456789abcdef",
  SKILL_SIGNING_SECRET: "skill-signing-secret-0123456789abcdef",
  CAPABILITY_SECRET: "capabilities",
  PORTAL_IDENTITY_SECRET: "portal",
  CONNECTOR_SECRET_KEY: "connector-secret-0123456789abcdef",
  SANDBOX_BACKEND: "local",
} as const;

test("ORG_BRAND_* parses into a validated branding default", () => {
  assert.equal(loadConfig({}).brandingDefault, undefined);
  assert.deepEqual(
    loadConfig({ ORG_BRAND_ACCENT: "#6366f1", ORG_BRAND_MARK: "Q", ORG_BRAND_SELF_LABEL: "qm" }).brandingDefault,
    { accent: "#6366f1", mark: "Q", selfLabel: "qm" },
  );
  assert.equal(loadConfig({ ORG_BRAND_ACCENT: "#abcde" }).brandingDefault, undefined);
  assert.deepEqual(loadConfig({ ORG_BRAND_MARK: 'a"bc' }).brandingDefault, { mark: "ab" });
  assert.equal(loadConfig({ ORG_BRAND_SELF_LABEL: "x".repeat(80) }).brandingDefault?.selfLabel?.length, 40);
  assert.deepEqual(loadConfig({ ORG_BRAND_ORG_NAME: "Acme Corp" }).brandingDefault, { orgName: "Acme Corp" });
  assert.equal(loadConfig({ ORG_BRAND_ORG_NAME: "x".repeat(80) }).brandingDefault?.orgName?.length, 40);
  assert.deepEqual(loadConfig({ ORG_BRAND_SELF_LABEL: "{{straylight}}" }).brandingDefault, { selfLabel: "straylight" });
});

test("store kinds default to memory and accept postgres", () => {
  const def = loadConfig({});
  assert.equal(def.sessionStore, "memory");
  assert.equal(def.runStore, "memory");

  const pg = loadConfig({ SESSION_STORE: "postgres", DATABASE_URL: "postgres://test" });
  assert.equal(pg.sessionStore, "postgres");
  assert.equal(pg.runStore, "postgres", "runStore mirrors sessionStore when unset");

  assert.equal(
    loadConfig({ SESSION_STORE: "postgres", RUN_STORE: "memory", DATABASE_URL: "postgres://test" }).runStore,
    "memory",
  );
  assert.throws(
    () => loadConfig({ SESSION_STORE: "postgres" }),
    /missing or insecure required core secrets: DATABASE_URL/,
  );
});

test("production and unauthenticated-core escape hatch are parsed once", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /missing or insecure required core secrets/);
  assert.equal(loadConfig(productionEnv).production, true);
  assert.equal(loadConfig({}).production, false);
  assert.equal(loadConfig({ ALLOW_UNAUTHENTICATED_CORE: "yes" }).allowUnauthenticatedCore, true);
  assert.throws(() => loadConfig({ ALLOW_UNAUTHENTICATED_CORE: "sometimes" }), /not a recognized boolean/);
});

test("harness security posture defaults to auto and validates named modes", () => {
  assert.equal(loadConfig({}).securityPosture, "auto");
  assert.equal(loadConfig({}).securityScreenBackend, "model");
  assert.equal(loadConfig({}).securityScreenProxy, undefined);
  assert.equal(loadConfig({}).securityScreenTimeoutMs, 15_000);
  assert.equal(loadConfig({ SECURITY_SCREEN_TIMEOUT_MS: "25" }).securityScreenTimeoutMs, 25);
  assert.equal(loadConfig({ HARNESS_SECURITY_POSTURE: "Dangerous" }).securityPosture, "dangerous");
  assert.equal(loadConfig({ HARNESS_SECURITY_POSTURE: "strict" }).securityPosture, "strict");
  assert.throws(
    () => loadConfig({ HARNESS_SECURITY_POSTURE: "permissive" }),
    /HARNESS_SECURITY_POSTURE="permissive" is not recognized/,
  );
  assert.throws(
    () => loadConfig({ SECURITY_SCREEN_BACKEND: "proxy" }),
    /requires SECURITY_SCREEN_PROXY_PROVIDER, SECURITY_SCREEN_PROXY_ENDPOINT, SECURITY_SCREEN_PROXY_TOKEN, and SECURITY_SCREEN_PROXY_ROLLOUT/,
  );
  assert.deepEqual(
    loadConfig({
      SECURITY_SCREEN_BACKEND: "proxy",
      SECURITY_SCREEN_PROXY_PROVIDER: "example-screen",
      SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
      SECURITY_SCREEN_PROXY_TOKEN: "test-token",
      SECURITY_SCREEN_PROXY_ROLLOUT: "enforce",
    }).securityScreenProxy,
    {
      provider: "example-screen",
      endpoint: "https://screen.example.test/classify",
      token: "test-token",
      shadow: false,
    },
  );
  for (const timeout of ["0", "-1", "1.5", "2147483648"]) {
    assert.throws(
      () => loadConfig({ SECURITY_SCREEN_TIMEOUT_MS: timeout }),
      /SECURITY_SCREEN_TIMEOUT_MS must be a positive integer/,
    );
  }
  assert.throws(
    () => loadConfig({ SECURITY_SCREEN_PROXY_PROVIDER: "example-screen" }),
    /requires SECURITY_SCREEN_BACKEND=proxy/,
  );
  for (const provider of ["Bad Provider", "surface", "origin", "-leading", `${"x".repeat(64)}`]) {
    assert.throws(
      () =>
        loadConfig({
          SECURITY_SCREEN_BACKEND: "proxy",
          SECURITY_SCREEN_PROXY_PROVIDER: provider,
          SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
          SECURITY_SCREEN_PROXY_TOKEN: "test-token",
          SECURITY_SCREEN_PROXY_ROLLOUT: "shadow",
        }),
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
      () =>
        loadConfig({
          SECURITY_SCREEN_BACKEND: "proxy",
          SECURITY_SCREEN_PROXY_PROVIDER: "example-screen",
          SECURITY_SCREEN_PROXY_ENDPOINT: endpoint,
          SECURITY_SCREEN_PROXY_TOKEN: "test-token",
          SECURITY_SCREEN_PROXY_ROLLOUT: "shadow",
        }),
      /SECURITY_SCREEN_PROXY_ENDPOINT/,
    );
  }
  assert.throws(
    () =>
      loadConfig({
        SECURITY_SCREEN_BACKEND: "proxy",
        SECURITY_SCREEN_PROXY_PROVIDER: "example-screen",
        SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
        SECURITY_SCREEN_PROXY_TOKEN: "test-token",
        SECURITY_SCREEN_PROXY_ROLLOUT: "gradual",
      }),
    /SECURITY_SCREEN_PROXY_ROLLOUT/,
  );
});

test("production names a mock harness rather than letting it pass as a real deployment", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    loadConfig(productionEnv);
    loadConfig({ ...productionEnv, HARNESS: "mock" });
    loadConfig({ ...productionEnv, HARNESS: "pi" });
    loadConfig({});
  } finally {
    console.warn = original;
  }
  const mock = warnings.filter((w) => w.includes("calls no model provider"));
  assert.equal(mock.length, 2, "production + unset and production + mock each warn once");
  assert.match(mock[0]!, /unset, which means mock/);
  assert.match(mock[1]!, /HARNESS is "mock"/);
});

test("a leftover *=sqlite env throws (no silent downgrade to ephemeral memory)", () => {
  assert.throws(() => loadConfig({ SESSION_STORE: "sqlite" }), /SESSION_STORE=sqlite is no longer supported/);
  assert.throws(() => loadConfig({ RUN_STORE: "sqlite" }), /RUN_STORE=sqlite is no longer supported/);
  assert.throws(() => loadConfig({ ARTIFACT_STORE: "sqlite" }), /ARTIFACT_STORE=sqlite is no longer supported/);
});

test("a harmless ARTIFACT_STORE=memory (now a dead knob) is ignored, not fatal", () => {
  assert.doesNotThrow(() => loadConfig({ ARTIFACT_STORE: "memory" }));
});

test("boolEnv: one vocabulary for every boolean env knob", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) assert.equal(boolEnv(v), true, v);
  for (const v of ["0", "false", "no", "off", "none", "OFF"]) assert.equal(boolEnv(v), false, v);
  for (const v of [undefined, "", "2", "enabled"]) assert.equal(boolEnv(v), undefined, String(v));
});

test("every boolean knob accepts the shared vocabulary (off means off)", () => {
  const off = loadConfig({ SEED_SKILLS: "off", EXECUTE_SCRATCH: "off", REACH_EXEC: "off", PI_CAPTURE_REQUESTS: "off" });
  assert.equal(off.seedSkills, false);
  assert.equal(off.scratchExecEnabled, false);
  assert.equal(off.reachExecEnabled, false);
  assert.equal(off.sharedOwnerAuthIsolation, false);
  assert.equal(off.piCaptureRequests, false);

  const on = loadConfig({
    SEED_SKILLS: "yes",
    EXECUTE_SCRATCH: "on",
    REACH_EXEC: "1",
    SHARED_OWNER_AUTH_ISOLATION: "yes",
    PI_SYSTEM_CACHE_SPLIT: "on",
  });
  assert.equal(on.seedSkills, true);
  assert.equal(on.scratchExecEnabled, true);
  assert.equal(on.reachExecEnabled, true);
  assert.equal(on.sharedOwnerAuthIsolation, true);
  assert.equal(on.piSystemCacheSplit, true);

  const unset = loadConfig({});
  assert.equal(unset.piCaptureRequests, true, "capture defaults on");
  assert.equal(unset.piSystemCacheSplit, false, "cache split defaults off");
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
  assert.throws(() => loadConfig({ EXECUTE_SCRATCH: "2" }), /EXECUTE_SCRATCH="2" is not a recognized boolean/);
  assert.throws(() => loadConfig({ SANDBOX_BACKEND: "docker" }), /SANDBOX_BACKEND="docker" is not recognized/);
  assert.equal(loadConfig({ WORKERS: "  " }).workers, CONFIG_DEFAULTS.workers);
  assert.equal(loadConfig({ EXECUTE_SCRATCH: "" }).scratchExecEnabled, false);
});

test("sandbox backend is parsed once before production backend guards", () => {
  assert.equal(loadConfig({ SANDBOX_BACKEND: " aws " }).sandboxBackend, "aws");
  assert.throws(
    () => loadConfig({ ...productionEnv, SANDBOX_BACKEND: "bogus" }),
    /SANDBOX_BACKEND="bogus" is not recognized/,
  );
});

test("production refuses missing, placeholder, or weak signing keys", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /CAPABILITY_SECRET, CONNECTOR_SECRET_KEY, CORE_SIGNING_SECRET, PORTAL_IDENTITY_SECRET, SKILL_SIGNING_SECRET/,
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
  assert.equal(def.workers, CONFIG_DEFAULTS.workers);
  assert.equal(def.rateLimitPerWindow, CONFIG_DEFAULTS.rateLimitPerWindow);
  assert.equal(def.rateLimitWindowMs, CONFIG_DEFAULTS.rateLimitWindowMs);
  assert.equal(def.monitorPollMs, CONFIG_DEFAULTS.monitorPollMs);
  assert.equal(def.approvalSummaryTimeoutMs, CONFIG_DEFAULTS.approvalSummaryTimeoutMs);
  assert.equal(def.deployDialTimeoutMs, CONFIG_DEFAULTS.deployDialTimeoutMs);
  assert.equal(def.execTimeoutDefaultMs, CONFIG_DEFAULTS.execTimeoutDefaultSec * 1000);
  assert.equal(def.execTimeoutMaxMs, CONFIG_DEFAULTS.execTimeoutMaxSec * 1000);
  assert.equal(def.backgroundJobTtlMs, CONFIG_DEFAULTS.backgroundJobTtlSec * 1000);
  assert.equal(def.backgroundJobTtlMaxMs, CONFIG_DEFAULTS.backgroundJobTtlMaxSec * 1000);
  assert.equal(def.turnWallClockMs, CONFIG_DEFAULTS.turnWallClockSec * 1000);
  assert.equal(def.turnWallClockMs, 0);
  assert.equal(def.runMaxAgeMs, 24 * 60 * 60_000);
  assert.equal(def.runWaitMs, def.runMaxAgeMs + 60_000);
});

test("turn wall clock config drives run bounds only when capped", () => {
  const capped = loadConfig({ TURN_WALL_CLOCK_SEC: "120" });
  assert.equal(capped.turnWallClockMs, 120_000);
  assert.equal(capped.runMaxAgeMs, 240_000);
  assert.equal(capped.runWaitMs, 180_000);
  const explicit = loadConfig({ TURN_WALL_CLOCK_SEC: "120", RUN_MAX_AGE_MS: "999999" });
  assert.equal(explicit.runMaxAgeMs, 999_999);
});

test("APPROVAL_SUMMARY_TIMEOUT_MS overrides the approval-summary deadline; unset uses the 6s default", () => {
  assert.equal(loadConfig({ APPROVAL_SUMMARY_TIMEOUT_MS: "9000" }).approvalSummaryTimeoutMs, 9000);
  assert.equal(loadConfig({}).approvalSummaryTimeoutMs, 6_000);
});

test("deploy proxy dial timeout is parsed once from config", () => {
  assert.equal(loadConfig({ DEPLOY_DIAL_TIMEOUT_MS: "1234" }).deployDialTimeoutMs, 1234);
  assert.throws(() => loadConfig({ DEPLOY_DIAL_TIMEOUT_MS: "soon" }), /DEPLOY_DIAL_TIMEOUT_MS="soon" is not a number/);
});

test("PUBLIC_API_URL is not treated as the human-facing web URL", () => {
  const apiOnly = loadConfig({ PUBLIC_API_URL: "https://agent-api.example" });
  assert.equal(apiOnly.apiBaseUrl, "https://agent-api.example");
  assert.equal(apiOnly.publicUrl, "https://agent-api.example");
  assert.equal(apiOnly.publicWebUrl, undefined);

  const web = loadConfig({ PUBLIC_API_URL: "https://agent-api.example", PUBLIC_WEB_URL: "https://portal.example" });
  assert.equal(web.apiBaseUrl, "https://agent-api.example");
  assert.equal(web.publicUrl, "https://portal.example");
  assert.equal(web.publicWebUrl, "https://portal.example");
});

test("plugin skill directories can be overridden or disabled", () => {
  assert.deepEqual(loadConfig({ PLUGIN_SKILLS_DIRS: "plugins/onboarding/skills, custom/skills" }).pluginSkillDirs, [
    resolve("plugins/onboarding/skills"),
    resolve("custom/skills"),
  ]);
  assert.deepEqual(loadConfig({ PLUGIN_SKILLS_DIRS: "0" }).pluginSkillDirs, []);
  assert.deepEqual(loadConfig({}).pluginSkillDirs, [resolve("plugins/onboarding/skills")]);
});

test("HARNESS=pi can boot before an admin configures a model provider", () => {
  assert.doesNotThrow(() => loadConfig({ HARNESS: "pi" }));
  assert.doesNotThrow(() => loadConfig({ HARNESS: "pi", ANTHROPIC_API_KEY: "sk-ant" }));
  assert.doesNotThrow(() => loadConfig({ HARNESS: " pi " }));
  assert.doesNotThrow(() => loadConfig({ HARNESS: " pi ", ANTHROPIC_API_KEY: "sk-ant" }));
  assert.doesNotThrow(() => loadConfig({ HARNESS: "mock" }));
  assert.doesNotThrow(() => loadConfig({ ...productionEnv, HARNESS: "pi" }));
  assert.doesNotThrow(() => loadConfig({ ...productionEnv, HARNESS: "pi", ANTHROPIC_API_KEY: "sk-ant" }));
});

test("HARNESS=codex requires OPENAI_API_KEY: its CLI cannot do browser OAuth in a container", () => {
  assert.throws(() => loadConfig({ HARNESS: "codex" }), /missing or insecure required core secrets: OPENAI_API_KEY/);
  assert.throws(() => loadConfig({ HARNESS: " codex " }), /missing or insecure required core secrets: OPENAI_API_KEY/);
  assert.doesNotThrow(() => loadConfig({ HARNESS: "codex", OPENAI_API_KEY: "sk-openai" }));
  assert.throws(
    () => loadConfig({ ...productionEnv, HARNESS: "codex" }),
    /missing or insecure required core secrets: OPENAI_API_KEY/,
  );
  assert.doesNotThrow(() => loadConfig({ ...productionEnv, HARNESS: "codex", OPENAI_API_KEY: "sk-openai" }));
  assert.equal(
    loadConfig({ HARNESS: "codex", OPENAI_API_KEY: "sk-openai", CODEX_MODEL: "gpt-5.4" }).codexModel,
    "gpt-5.4",
  );
});

test("HARNESS=claude uses native Claude authentication and does not require an Anthropic key", () => {
  assert.doesNotThrow(() => loadConfig({ HARNESS: "claude" }));
  assert.equal(loadConfig({ HARNESS: "claude", CLAUDE_MODEL: "claude-opus-4-8" }).claudeModel, "claude-opus-4-8");
});

test("SANDBOX_BACKEND: unset defaults to local (dev only); the secondary must be recognized and differ", () => {
  assert.equal(loadConfig({}).sandboxBackend, "local");
  assert.throws(
    () => loadConfig({ ...productionEnv, SANDBOX_BACKEND: undefined }),
    /SANDBOX_BACKEND must be set explicitly in production/,
  );
  assert.equal(loadConfig({}).sandboxSecondaryBackend, undefined);
  assert.equal(
    loadConfig({ SANDBOX_SECONDARY_BACKEND: "sprites", SPRITES_TOKEN: "tok" }).sandboxSecondaryBackend,
    "sprites",
  );
  assert.throws(() => loadConfig({ SANDBOX_BACKEND: "sprites" }), /SPRITES_TOKEN/);
  assert.throws(
    () => loadConfig({ SANDBOX_SECONDARY_BACKEND: "fly" }),
    /SANDBOX_SECONDARY_BACKEND="fly" is not recognized/,
  );
  assert.throws(
    () => loadConfig({ SANDBOX_BACKEND: "sprites", SANDBOX_SECONDARY_BACKEND: "sprites", SPRITES_TOKEN: "tok" }),
    /must differ/,
  );
});

test("Fly identity and Slack runtime settings are parsed once into Config", () => {
  const config = loadConfig({
    FLY_APP_NAME: "qm-core",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_API_URL: "https://slack.example/api",
  });
  assert.equal(config.flyAppName, "qm-core");
  assert.deepEqual(config.slack, {
    botToken: "xoxb-test",
    appToken: "xapp-test",
    apiUrl: "https://slack.example/api",
  });
});

test("maxClaims defaults from CONFIG_DEFAULTS and MAX_CLAIMS overrides", () => {
  assert.equal(loadConfig({}).maxClaims, CONFIG_DEFAULTS.maxClaims);
  assert.equal(loadConfig({ MAX_CLAIMS: "5" }).maxClaims, 5);
  assert.throws(() => loadConfig({ MAX_CLAIMS: "lots" }), /MAX_CLAIMS="lots" is not a number/);
});

test("MODEL_PROVIDER declares the vendor that bills the base model", () => {
  assert.equal(loadConfig({}).modelProvider, undefined);
  assert.equal(loadConfig({ MODEL_PROVIDER: " openrouter ", OPENROUTER_API_KEY: "k" }).modelProvider, "openrouter");
  assert.throws(() => loadConfig({ MODEL_PROVIDER: "bedrock" }), /MODEL_PROVIDER.*not recognized/);
});

test("MODEL_PROVIDER is refused when the harness can never run that vendor's models", () => {
  assert.throws(
    () => loadConfig({ MODEL_PROVIDER: "openrouter", HARNESS: "codex", OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k" }),
    /cannot serve a base model on HARNESS=codex/,
  );
  assert.throws(
    () => loadConfig({ MODEL_PROVIDER: "anthropic", HARNESS: "codex", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }),
    /cannot serve a base model on HARNESS=codex/,
  );
  assert.throws(
    () => loadConfig({ MODEL_PROVIDER: "openrouter", HARNESS: "opencode", OPENROUTER_API_KEY: "k" }),
    /cannot serve a base model on HARNESS=opencode/,
    "opencode has no OpenRouter route",
  );
  assert.equal(
    loadConfig({ MODEL_PROVIDER: "openai", HARNESS: "codex", OPENAI_API_KEY: "k" }).modelProvider,
    "openai",
    "the one combination Codex can bill is accepted",
  );
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
