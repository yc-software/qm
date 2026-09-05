import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctorCommon,
  localDoctorSecrets,
  requiredSlackScopes,
  slackManifestBotScopes,
} from "../src/backends/doctor.ts";
import { flyDoctor, verifyLocalFlyTokens } from "../src/backends/fly.ts";
import { validatePortalTrust, type QmConfig } from "../src/config.ts";

const config: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "http://localhost:8080",
  target: "docker",
  services: ["core"],
  plugins: [],
  skills: [],
  env: { core: { HARNESS: "pi" } },
  imageOverrides: {},
  sandbox: { app: "acme-sandboxes" },
};

test("Docker doctor rejects missing and placeholder required secrets before external probes", async () => {
  const prior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "";
  try {
    await assert.rejects(
      doctorCommon(config, new Map([["CORE_SIGNING_SECRET", "replace-me"]]), { requiredSecretValues: true }),
      /CAPABILITY_SECRET, CONNECTOR_SECRET_KEY, CORE_SIGNING_SECRET, PORTAL_IDENTITY_SECRET, PUBLIC_API_URL, SKILL_SIGNING_SECRET/,
    );
  } finally {
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prior;
  }
});

test("doctor allows deferred Slack setup but rejects a partial token pair", async () => {
  const { sandbox: _sandbox, ...withoutSandbox } = config;
  void _sandbox;
  const deferredConfig: QmConfig = {
    ...withoutSandbox,
    services: ["core", "slack"],
    env: { core: { HARNESS: "mock" } },
  };
  const required = new Map([
    ["CAPABILITY_SECRET", "a".repeat(64)],
    ["CONNECTOR_SECRET_KEY", "b".repeat(64)],
    ["CORE_SIGNING_SECRET", "c".repeat(64)],
    ["PORTAL_IDENTITY_SECRET", "d".repeat(64)],
    ["SKILL_SIGNING_SECRET", "e".repeat(64)],
  ]);
  await assert.doesNotReject(doctorCommon(deferredConfig, required, { requiredSecretValues: true }));
  await assert.rejects(
    doctorCommon(deferredConfig, new Map([...required, ["SLACK_BOT_TOKEN", "xoxb-only"]]), {
      requiredSecretValues: true,
    }),
    /both SLACK_BOT_TOKEN and SLACK_APP_TOKEN/,
  );
});

test("doctor rejects missing and placeholder portal OIDC client ids and tenant gates", async () => {
  const { sandbox: _sandbox, ...withoutSandbox } = config;
  void _sandbox;
  const portalConfig: QmConfig = {
    ...withoutSandbox,
    services: ["core", "portal"],
    env: { portal: { OIDC_CLIENT_ID: "replace-me" } },
  };
  for (const oidcClientId of ["", "   ", "replace-me", " replace-me "]) {
    await assert.rejects(
      doctorCommon({ ...portalConfig, env: { portal: { OIDC_CLIENT_ID: oidcClientId } } }, new Map()),
      /OIDC_CLIENT_ID may not be a placeholder/,
    );
  }
  const rejectedGates: Array<Record<string, string>> = [
    { PORTAL_EXPECTED_TEAM_ID: " " },
    { PORTAL_EXPECTED_TEAM_ID: "replace-me", OIDC_ALLOWED_EMAIL_DOMAIN: "todo" },
  ];
  for (const gate of rejectedGates) {
    await assert.rejects(
      doctorCommon({ ...portalConfig, env: { portal: { OIDC_CLIENT_ID: "real-client-id", ...gate } } }, new Map()),
      /must be a valid, non-placeholder email domain|may not be a placeholder/,
    );
  }
  const acceptedGates: Array<Record<string, string>> = [
    { OIDC_ALLOWED_EMAIL_DOMAIN: "example.com" },
    { PORTAL_EXPECTED_TEAM_ID: "T123" },
    { OIDC_ALLOWED_EMAIL_DOMAIN: "example.com", PORTAL_EXPECTED_TEAM_ID: "T123" },
  ];
  for (const gate of acceptedGates) {
    await assert.doesNotReject(
      doctorCommon({ ...portalConfig, env: { portal: { OIDC_CLIENT_ID: "real-client-id", ...gate } } }, new Map()),
    );
  }
  assert.doesNotThrow(() =>
    validatePortalTrust(
      { ...portalConfig, env: { portal: {} } },
      "config",
      new Map([
        ["OIDC_CLIENT_ID", "secret-client"],
        ["PORTAL_EXPECTED_TEAM_ID", "T123"],
      ]),
    ),
  );
  assert.throws(
    () => validatePortalTrust({ ...portalConfig, env: { portal: {} } }, "config", new Map()),
    /OIDC_CLIENT_ID in env\.portal or the target secret store/,
  );
});

test("remote doctor keeps missing local email values distinct from disabled email", async () => {
  const brokerConfig: QmConfig = {
    ...config,
    sandbox: undefined,
    services: ["core", "portal", "auth"],
    env: {
      core: { HARNESS: "mock" },
      auth: { AUTH_EMAIL_TRANSPORT: "resend", AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" },
    },
  };
  const priorKey = process.env.RESEND_API_KEY;
  const priorSender = process.env.AUTH_EMAIL_FROM;
  const log = console.log;
  const warn = console.warn;
  process.env.RESEND_API_KEY = "";
  process.env.AUTH_EMAIL_FROM = "";
  try {
    for (const secrets of [new Map<string, string>(), new Map([["AUTH_EMAIL_FROM", "noreply@example.com"]])]) {
      const output: string[] = [];
      console.log = (...values: unknown[]): void => void output.push(values.join(" "));
      console.warn = (...values: unknown[]): void => void output.push(values.join(" "));
      await assert.doesNotReject(doctorCommon(brokerConfig, secrets));
      assert.match(output.join("\n"), /RESEND_API_KEY is not available locally/);
      assert.doesNotMatch(output.join("\n"), /sign-in email: disabled/);
    }
  } finally {
    console.log = log;
    console.warn = warn;
    if (priorKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = priorKey;
    if (priorSender === undefined) delete process.env.AUTH_EMAIL_FROM;
    else process.env.AUTH_EMAIL_FROM = priorSender;
  }
});

test("Fly doctor requires the signing secret for source plugins absent from config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-doctor-"));
  const bin = join(dir, "fake-fly.cjs");
  const prior = process.env.FLY_BIN;
  mkdirSync(join(dir, "plugins", "linear"), { recursive: true });
  writeFileSync(join(dir, "plugins", "linear", "Dockerfile"), "FROM scratch\n");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const app = args[args.indexOf("-a") + 1];
if (app === "acme-core") process.stdout.write("CAPABILITY_SECRET\\nCONNECTOR_SECRET_KEY\\nCORE_SIGNING_SECRET\\nPORTAL_IDENTITY_SECRET\\nSKILL_SIGNING_SECRET\\nFLY_API_TOKEN\\n");
`,
  );
  chmodSync(bin, 0o755);
  process.env.FLY_BIN = bin;
  try {
    await assert.rejects(
      flyDoctor({ ...config, target: "fly", appPrefix: "acme", region: "sjc", flyOrg: "personal" }, dir),
      /acme-linear: missing CORE_SIGNING_SECRET/,
    );
  } finally {
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fly doctor demands the plain name too for a dual-role (core + sandbox) secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-doctor-dual-"));
  const bin = join(dir, "fake-fly.cjs");
  const prior = process.env.FLY_BIN;
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const app = args[args.indexOf("-a") + 1];
if (app === "acme-core") process.stdout.write("CAPABILITY_SECRET\\nCONNECTOR_SECRET_KEY\\nCORE_SIGNING_SECRET\\nPORTAL_IDENTITY_SECRET\\nSKILL_SIGNING_SECRET\\nFLY_API_TOKEN\\nFLY_RESIDENT_ENV_ANTHROPIC_API_KEY\\n");
`,
  );
  chmodSync(bin, 0o755);
  process.env.FLY_BIN = bin;
  try {
    await assert.rejects(
      flyDoctor(
        {
          ...config,
          target: "fly",
          appPrefix: "acme",
          region: "sjc",
          flyOrg: "personal",
          sandbox: { app: "acme-sandboxes", secretEnv: ["ANTHROPIC_API_KEY"] },
        },
        dir,
      ),
      /acme-core: missing ANTHROPIC_API_KEY/,
    );
  } finally {
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fly doctor reports apps that are not created yet as pending, not missing secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-doctor-predeploy-"));
  const bin = join(dir, "fake-fly.cjs");
  const prior = process.env.FLY_BIN;
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "secrets" && args[1] === "list") {
  process.stderr.write("Error: app not found");
  process.exit(1);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  process.env.FLY_BIN = bin;
  const log = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    await assert.doesNotReject(
      flyDoctor({ ...config, target: "fly", appPrefix: "acme", region: "sjc", flyOrg: "personal" }, dir),
    );
    assert.ok(
      lines.some((line) => line.includes("acme-core: not created yet")),
      `printed: ${lines.join(" | ")}`,
    );
    assert.ok(!lines.some((line) => line.includes("missing")), `printed: ${lines.join(" | ")}`);
  } finally {
    console.log = log;
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reads the deployment's slack-app-manifest.yml scopes, falling back to the template", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-doctor-manifest-"));
  try {
    const templateScopes = requiredSlackScopes();
    assert.ok(templateScopes.includes("chat:write"), "template scopes parse");
    assert.deepEqual(requiredSlackScopes(dir), templateScopes, "no deployment manifest → template");
    writeFileSync(
      join(dir, "slack-app-manifest.yml"),
      [
        "display_information:",
        "  name: acme Agent",
        "oauth_config:",
        "  scopes:",
        "    bot:",
        "      - chat:write",
        "      - custom:scope",
        "settings:",
        "  socket_mode_enabled: true",
      ].join("\n"),
    );
    assert.deepEqual(requiredSlackScopes(dir), ["chat:write", "custom:scope"], "deployment manifest wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requiredSlackScopes warns when the deployment manifest lags the template's scopes, and stays quiet on a superset", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-doctor-stale-"));
  const lines: string[] = [];
  const priorWarn = console.warn;
  console.warn = (...args: unknown[]): void => void lines.push(args.join(" "));
  try {
    const templateScopes = requiredSlackScopes();
    writeFileSync(join(dir, "slack-app-manifest.yml"), "oauth_config:\n  scopes:\n    bot:\n      - chat:write\n");
    requiredSlackScopes(dir);
    assert.equal(lines.length, 1, "a lagging manifest draws exactly one warning");
    for (const scope of templateScopes.filter((s) => s !== "chat:write")) {
      assert.ok(lines[0]!.includes(scope), `warning names missing scope ${scope}`);
    }
    lines.length = 0;
    writeFileSync(
      join(dir, "slack-app-manifest.yml"),
      JSON.stringify({ oauth_config: { scopes: { bot: [...templateScopes, "custom:extra"] } } }),
    );
    assert.deepEqual(requiredSlackScopes(dir), [...templateScopes, "custom:extra"]);
    assert.deepEqual(lines, [], "a superset manifest draws no warning");
  } finally {
    console.warn = priorWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slackManifestBotScopes reads both YAML and JSON manifests", () => {
  assert.deepEqual(slackManifestBotScopes('{"oauth_config":{"scopes":{"bot":["a:b","c:d"]}}}'), ["a:b", "c:d"]);
  assert.deepEqual(slackManifestBotScopes('oauth_config:\n  scopes:\n    bot:\n      - a:b\n      - "c:d"\n'), [
    "a:b",
    "c:d",
  ]);
});

test("slackManifestBotScopes parses inline-flow lists, quoted or not", () => {
  assert.deepEqual(slackManifestBotScopes("oauth_config:\n  scopes:\n    bot: [a:b, \"c:d\", 'e:f']\n"), [
    "a:b",
    "c:d",
    "e:f",
  ]);
  assert.deepEqual(slackManifestBotScopes("oauth_config:\n  scopes:\n    bot: [chat:write]  # keep in sync\n"), [
    "chat:write",
  ]);
});

test("slackManifestBotScopes does not truncate on comments inside a block list", () => {
  const yaml = [
    "oauth_config:",
    "  scopes:",
    "    bot:",
    "      - chat:write",
    "      # socket mode needs this",
    "      - users:read  # directory sync",
    '      - "channels:history"',
    "settings:",
    "  socket_mode_enabled: true",
  ].join("\n");
  assert.deepEqual(slackManifestBotScopes(yaml), ["chat:write", "users:read", "channels:history"]);
});

test("requiredSlackScopes throws when a manifest exists but zero scopes parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-doctor-zeroscope-"));
  try {
    writeFileSync(join(dir, "slack-app-manifest.yml"), "display_information:\n  name: acme Agent\n");
    assert.throws(() => requiredSlackScopes(dir), /no bot scopes parse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SLACK_TOKENS = new Map([
  ["SLACK_BOT_TOKEN", "xoxb-test"],
  ["SLACK_APP_TOKEN", "xapp-test"],
]);

function slackConfig(): QmConfig {
  const { sandbox: _sandbox, ...rest } = config;
  void _sandbox;
  return { ...rest, services: ["core", "slack"], env: {} };
}

function manifestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-doctor-fetch-"));
  writeFileSync(
    join(dir, "slack-app-manifest.yml"),
    "oauth_config:\n  scopes:\n    bot:\n      - chat:write\n      - users:read\n",
  );
  return dir;
}

async function withStubbedSlack<T>(responses: { auth: Response; socket?: Response }, fn: () => Promise<T>): Promise<T> {
  const priorFetch = globalThis.fetch;
  const priorBot = process.env.SLACK_BOT_TOKEN;
  const priorApp = process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://slack.com/api/auth.test") return responses.auth;
    if (url === "https://slack.com/api/apps.connections.open") {
      return responses.socket ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = priorFetch;
    if (priorBot !== undefined) process.env.SLACK_BOT_TOKEN = priorBot;
    if (priorApp !== undefined) process.env.SLACK_APP_TOKEN = priorApp;
  }
}

const authOk = (scopes?: string): Response =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: scopes === undefined ? {} : { "x-oauth-scopes": scopes },
  });

test("slackCheck passes when granted scopes are a superset of the manifest's", async () => {
  const dir = manifestDir();
  try {
    await withStubbedSlack({ auth: authOk("chat:write, users:read, extra:scope") }, () =>
      doctorCommon(slackConfig(), SLACK_TOKENS, { configDir: dir }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Slack doctor validates deployment-file tokens before conflicting ambient tokens", async () => {
  const dir = manifestDir();
  const priorFetch = globalThis.fetch;
  const priorBot = process.env.SLACK_BOT_TOKEN;
  const priorApp = process.env.SLACK_APP_TOKEN;
  process.env.SLACK_BOT_TOKEN = "xoxb-ambient";
  process.env.SLACK_APP_TOKEN = "xapp-ambient";
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    const url = String(input);
    return url.endsWith("/auth.test")
      ? authOk("chat:write, users:read")
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    await doctorCommon(slackConfig(), SLACK_TOKENS, { configDir: dir });
    assert.deepEqual(seen, ["Bearer xoxb-test", "Bearer xapp-test"]);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorBot === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = priorBot;
    if (priorApp === undefined) delete process.env.SLACK_APP_TOKEN;
    else process.env.SLACK_APP_TOKEN = priorApp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slackCheck fails naming each manifest scope the token lacks", async () => {
  const dir = manifestDir();
  try {
    await withStubbedSlack({ auth: authOk("chat:write") }, () =>
      assert.rejects(doctorCommon(slackConfig(), SLACK_TOKENS, { configDir: dir }), /missing scopes: users:read/),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slackCheck surfaces a rejected bot token with Slack's error code", async () => {
  const dir = manifestDir();
  try {
    await withStubbedSlack(
      { auth: new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }) },
      () =>
        assert.rejects(
          doctorCommon(slackConfig(), SLACK_TOKENS, { configDir: dir }),
          /bot token rejected \(invalid_auth\)/,
        ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slackCheck treats a missing x-oauth-scopes header as zero granted scopes, not a pass", async () => {
  const dir = manifestDir();
  try {
    await withStubbedSlack({ auth: authOk() }, () =>
      assert.rejects(
        doctorCommon(slackConfig(), SLACK_TOKENS, { configDir: dir }),
        /missing scopes: chat:write, users:read/,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slackCheck rejects a bad Socket Mode app token even when the bot token passes", async () => {
  const dir = manifestDir();
  try {
    await withStubbedSlack(
      {
        auth: authOk("chat:write, users:read"),
        socket: new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }),
      },
      () =>
        assert.rejects(
          doctorCommon(slackConfig(), SLACK_TOKENS, { configDir: dir }),
          /app token rejected \(invalid_auth\)/,
        ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor treats a missing sandbox block as info (no Fly checks), not a failure", async () => {
  const { sandbox: _sandbox, ...rest } = config;
  void _sandbox;
  const noSandbox: QmConfig = { ...rest, env: {} };
  const priorFly = process.env.FLY_BIN;
  process.env.FLY_BIN = "/nonexistent/fly-should-never-run";
  const log = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    await doctorCommon(
      noSandbox,
      new Map([
        ["CAPABILITY_SECRET", "capability-value"],
        ["CONNECTOR_SECRET_KEY", "connector-value".repeat(3)],
        ["CORE_SIGNING_SECRET", "source-value".repeat(4)],
        ["PORTAL_IDENTITY_SECRET", "identity-value"],
        ["SKILL_SIGNING_SECRET", "skill-value".repeat(4)],
      ]),
      { requiredSecretValues: true },
    );
    assert.ok(
      lines.some((line) => line.includes("sandbox: not configured")),
      `printed: ${lines.join(" | ")}`,
    );
  } finally {
    console.log = log;
    if (priorFly === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = priorFly;
  }
});

test("an explicitly named --env-file that does not exist is a bad-path error, not 'secrets missing'", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-doctor-envfile-"));
  try {
    assert.throws(() => localDoctorSecrets(dir, join(dir, "nope.env")), /--env-file not found/);
    assert.deepEqual(localDoctorSecrets(dir), new Map(), "a missing default ./.env is still fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly doctor reports a missing flyctl before trying `fly secrets list`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-doctor-nofly-"));
  const prior = process.env.FLY_BIN;
  process.env.FLY_BIN = "/nonexistent/flyctl";
  try {
    await assert.rejects(
      flyDoctor({ ...config, target: "fly", appPrefix: "acme", region: "sjc", flyOrg: "personal" }, dir),
      /flyctl not found/,
    );
  } finally {
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fly doctor token probes reject expired scoped tokens without exposing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-doctor-fly-token-"));
  const bin = join(dir, "fake-fly.cjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.env.FLY_API_TOKEN === "FlyV1-good") process.exit(0);
process.stderr.write("unauthorized FlyV1-expired");
process.exit(1);
`,
  );
  chmodSync(bin, 0o755);
  const prior = process.env.FLY_BIN;
  const priorSandboxToken = process.env.FLY_SANDBOX_API_TOKEN;
  process.env.FLY_BIN = bin;
  process.env.FLY_SANDBOX_API_TOKEN = "FlyV1-good";
  const flyConfig: QmConfig = {
    ...config,
    target: "fly",
    appPrefix: "acme",
    region: "sjc",
    flyOrg: "personal",
  };
  try {
    assert.throws(
      () => verifyLocalFlyTokens(flyConfig, new Map([["FLY_SANDBOX_API_TOKEN", "FlyV1-expired"]])),
      (error: unknown) => {
        assert.match((error as Error).message, /FLY_SANDBOX_API_TOKEN was rejected/);
        assert.doesNotMatch((error as Error).message, /FlyV1-expired/);
        return true;
      },
    );
    assert.doesNotThrow(() =>
      verifyLocalFlyTokens(
        flyConfig,
        new Map([
          ["FLY_SANDBOX_API_TOKEN", "FlyV1-good"],
          ["FLY_DEPLOY_API_TOKEN", "FlyV1-expired"],
        ]),
      ),
    );
    assert.throws(
      () =>
        verifyLocalFlyTokens(
          {
            ...flyConfig,
            env: { ...flyConfig.env, core: { ...flyConfig.env.core, DEPLOY_PROVIDER: "fly" } },
          },
          new Map([
            ["FLY_SANDBOX_API_TOKEN", "FlyV1-good"],
            ["FLY_DEPLOY_API_TOKEN", "FlyV1-expired"],
          ]),
        ),
      /FLY_DEPLOY_API_TOKEN was rejected/,
    );
  } finally {
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
    if (priorSandboxToken === undefined) delete process.env.FLY_SANDBOX_API_TOKEN;
    else process.env.FLY_SANDBOX_API_TOKEN = priorSandboxToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor without required local values warns-and-skips the live Slack check (fly path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-doctor-skip-"));
  const bin = join(dir, "fake-fly.cjs");
  writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(0);\n");
  chmodSync(bin, 0o755);
  const priorFly = process.env.FLY_BIN;
  const priorBot = process.env.SLACK_BOT_TOKEN;
  const priorApp = process.env.SLACK_APP_TOKEN;
  process.env.FLY_BIN = bin;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  const warnLog = console.warn;
  const warned: string[] = [];
  console.warn = (...parts: unknown[]): void => void warned.push(parts.join(" "));
  try {
    await doctorCommon({ ...config, services: ["core", "slack"] }, new Map(), { configDir: dir });
    assert.ok(
      warned.some((line) => line.includes("skipping the live Slack check")),
      `warned: ${warned.join(" | ")}`,
    );
    await assert.rejects(
      doctorCommon({ ...config, services: ["core", "slack"] }, new Map(), {
        requiredSecretValues: true,
        configDir: dir,
      }),
      /required secrets are missing/,
    );
  } finally {
    console.warn = warnLog;
    if (priorFly === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = priorFly;
    if (priorBot !== undefined) process.env.SLACK_BOT_TOKEN = priorBot;
    if (priorApp !== undefined) process.env.SLACK_APP_TOKEN = priorApp;
    rmSync(dir, { recursive: true, force: true });
  }
});
