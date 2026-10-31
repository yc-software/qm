import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";
import { dockerUp } from "../src/backends/docker.ts";
import { derivedLoginPassword } from "../src/database-logins.ts";
import { tenantSettingsEnv } from "../src/tenant-settings.ts";
import { readEnvFile } from "../src/util.ts";

const SECRETS = {
  ANTHROPIC_API_KEY: "anthropic-supersecret",
  CAPABILITY_SECRET: "capability-supersecret",
  CONNECTOR_SECRET_KEY: "connector-supersecret".repeat(2),
  CORE_SIGNING_SECRET: "core-signing-supersecret".repeat(2),
  PORTAL_IDENTITY_SECRET: "portal-identity-supersecret",
  SKILL_SIGNING_SECRET: "skill-signing-supersecret".repeat(2),
  DEPLOYMENT_CONTROL_SECRET: "deployment-control-supersecret".repeat(2),
  SB_TOKEN: "sandbox-forwarded-supersecret",
  PLUG_TOKEN: "plugin-supersecret",
  SLACK_BOT_TOKEN: "xoxb-dual-role-supersecret",
  SLACK_APP_TOKEN: "xapp-supersecret",
  PUBLIC_API_URL: "https://core.example.test",
  EXTRA_API_KEY: "config-declared-extra-supersecret",
  EXAMPLE_SCREEN_TOKEN: "security-screen-supersecret",
};

function fakeDocker(dir: string): { argvLog: string; envCopy: string } {
  const argvLog = join(dir, "docker-argv.log");
  const envCopy = join(dir, "env-copy.log");
  writeFileSync(argvLog, "");
  writeFileSync(envCopy, "");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "version") { console.log("25.0"); process.exit(0); }
if (args[0] === "run") {
  const i = args.indexOf("--env-file");
  if (i !== -1) {
    const path = args[i + 1];
    const mode = (fs.statSync(path).mode & 0o777).toString(8);
    fs.appendFileSync(${JSON.stringify(envCopy)}, "mode=" + mode + "\\n" + fs.readFileSync(path, "utf8") + "---\\n");
  }
  console.log("cid");
  process.exit(0);
}
if (args[0] === "logs") { console.log("listening on :8080"); process.exit(0); }
if (args[0] === "volume") { console.error("No such volume"); process.exit(1); }
if (args[0] === "inspect") {
  if (String(args[args.length - 1]).endsWith("-pg")) { console.error("No such object"); process.exit(1); }
  console.log("true");
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return { argvLog, envCopy };
}

test("docker up delivers secrets via a 0600 env-file, never on the docker argv", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-"));
  const priorPath = process.env.PATH;
  const priorDb = process.env.DATABASE_OWNER_URL;
  const priorSecrets = new Map(Object.keys(SECRETS).map((name) => [name, process.env[name]]));
  const log = console.log,
    warn = console.warn;
  const lines: string[] = [];
  const ambientAnthropic = "ambient-anthropic-supersecret";
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        deploymentId: "sekrit",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core", "slack"],
        plugins: [
          {
            name: "linear",
            image: "ghcr.io/x:1",
            env: { LINEAR_REGION: "us", PLUG_TOKEN: "config-placeholder" },
            secrets: [{ name: "PLUG_TOKEN" }, { name: "EMPTY_TOKEN", required: false }],
          },
          { name: "signer", image: "ghcr.io/acme/signer:1", coreAccess: false },
        ],
        sandbox: { app: "sekrit-sandboxes" },
        securityScreen: {
          mode: "enforce",
          classifier: "proxy",
          provider: "example-screen",
          endpoint: "https://screen.example.test/classify",
        },
        secretEnv: {
          core: {
            EXTRA_API_KEY: "EXTRA_API_KEY",
            APPS_SESSION_ALIAS: "PORTAL_IDENTITY_SECRET",
            SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN",
          },
        },
        env: {
          core: {
            CORE_SIGNING_SECRET: "config-placeholder",
            DATABASE_URL: "postgres://config/placeholder",
            PUBLIC_API_URL: "https://config-placeholder.invalid",
          },
          slack: { WEB_UI_PUBLIC_URL: "http://folded.example.com/web-ui", CORE_SIGNING_SECRET: "config-placeholder" },
        },
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      [
        ...Object.entries(SECRETS)
          .filter(([name]) => name !== "ANTHROPIC_API_KEY")
          .map(([k, v]) => `${k}=${v}`),
        "ANTHROPIC_API_KEY=",
        "EMPTY_TOKEN=",
        "STRAY_KEY=1",
      ].join("\n"),
    );
    const fake = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.DATABASE_OWNER_URL = "postgres://owner:owner-pw@external/db";
    for (const name of Object.keys(SECRETS)) delete process.env[name];
    process.env.ANTHROPIC_API_KEY = ambientAnthropic;
    console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
    console.warn = console.log;
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await dockerUp(config, dir, {});

    const argv = readFileSync(fake.argvLog, "utf8");
    for (const value of Object.values(SECRETS)) {
      assert.ok(!argv.includes(value), `secret value must not reach the docker argv: ${value}`);
    }
    assert.ok(!argv.includes("postgres://"), "database URLs (they embed passwords) must not reach the docker argv");
    assert.ok(!argv.includes("config-placeholder"), "non-secret config env cannot shadow or expose secret values");
    assert.ok(argv.includes("--env-file"), "secrets travel via --env-file");
    assert.ok(argv.includes("LINEAR_REGION=us"), "undeclared plugin env still flows as -e");
    const signerArgs = argv
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .find((args) => args.includes("qm-sekrit-signer"));
    assert.ok(signerArgs, "coreless plugin starts");
    assert.ok(!signerArgs.includes("CORE_API_URL=http://core:8080"), "coreless plugin gets no core endpoint");
    assert.ok(!signerArgs.includes("--env-file"), "coreless plugin gets no source-auth secret");
    assert.ok(!argv.includes("SECURITY_SCREEN"), "the security screen is a tenant setting, never core env");

    assert.ok(
      argv.includes("WEB_UI_PUBLIC_URL=http://folded.example.com/web-ui"),
      "virtual-service env folds into the core env",
    );
    assert.ok(
      lines.some((l) => /\.env keys not forwarded/.test(l) && l.includes("STRAY_KEY")),
      "unforwarded .env keys are warned about",
    );

    const envFiles = readFileSync(fake.envCopy, "utf8");
    assert.ok(envFiles.includes(`CORE_SIGNING_SECRET=${SECRETS.CORE_SIGNING_SECRET}`));
    assert.ok(
      !envFiles.includes("config-placeholder"),
      "secret-store values win over colliding config env on services and plugins",
    );
    assert.ok(envFiles.includes("DATABASE_OWNER_URL=postgres://owner:owner-pw@external/db"));
    assert.match(envFiles, /\nDATABASE_URL=postgres:\/\/qm_app:[A-Za-z0-9_-]{43}@external\/db\n/);
    assert.match(envFiles, /\nDATABASE_READER_URL=postgres:\/\/qm_reader:[A-Za-z0-9_-]{43}@external\/db\n/);
    assert.ok(!envFiles.includes("EXAMPLE_SCREEN_TOKEN"), "tenant-owned secrets stay out of core env");
    assert.ok(envFiles.includes(`PLUG_TOKEN=${SECRETS.PLUG_TOKEN}`), "plugin secrets route through the file");
    assert.doesNotMatch(envFiles, /^ANTHROPIC_API_KEY=/m, "model keys are tenant settings, never core env");
    assert.equal(
      tenantSettingsEnv(config, readEnvFile(join(dir, ".env"))).ANTHROPIC_API_KEY,
      ambientAnthropic,
      "a blank scaffold entry falls back to the ambient secret when seeding tenant settings",
    );

    assert.doesNotMatch(envFiles, /^EMPTY_TOKEN=/m, "a blank optional secret with no ambient value remains unset");
    assert.ok(
      envFiles.includes(`PUBLIC_API_URL=${SECRETS.PUBLIC_API_URL}`),
      "the sandbox-reachable self-API URL reaches core",
    );
    assert.doesNotMatch(envFiles, /FLY_RESIDENT_ENV_/, "no deployment-wide sandbox secret reaches core");
    assert.match(
      envFiles,
      new RegExp(`^SLACK_BOT_TOKEN=${SECRETS.SLACK_BOT_TOKEN}$`, "m"),
      "the virtual slack surface secret keeps its plain name",
    );
    assert.match(
      envFiles,
      new RegExp(`^EXTRA_API_KEY=${SECRETS.EXTRA_API_KEY}$`, "m"),
      "config secretEnv extras route through the file",
    );
    assert.match(
      envFiles,
      new RegExp(`^APPS_SESSION_ALIAS=${SECRETS.PORTAL_IDENTITY_SECRET}$`, "m"),
      "a secretEnv alias delivers the stored value under its declared env name",
    );
    assert.doesNotMatch(envFiles, /^SECURITY_SCREEN_PROXY_TOKEN=/m);
    assert.equal(
      tenantSettingsEnv(config, readEnvFile(join(dir, ".env"))).SECURITY_SCREEN_PROXY_TOKEN,
      SECRETS.EXAMPLE_SCREEN_TOKEN,
      "a secretEnv alias onto a tenant setting is seeded under its declared env name",
    );
    assert.ok(!envFiles.includes("FLY_RESIDENT_ENV_TZ"), "literal sandbox env is not in the secret file");
    for (const mode of envFiles.match(/^mode=.*$/gm) ?? []) assert.equal(mode, "mode=600");

    for (const line of readFileSync(fake.argvLog, "utf8").split("\n").filter(Boolean)) {
      const args = JSON.parse(line) as string[];
      const index = args.indexOf("--env-file");
      if (index !== -1)
        assert.ok(!existsSync(args[index + 1]!), "the env-file is removed once the container is created");
    }
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    if (priorDb === undefined) delete process.env.DATABASE_OWNER_URL;
    else process.env.DATABASE_OWNER_URL = priorDb;
    for (const [name, value] of priorSecrets) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "managed Postgres: core gets the qm_owner, qm_app and qm_reader logins, never the superuser; state.json is 0600",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-pg-"));
    const xdg = mkdtempSync(join(tmpdir(), "qm-docker-secrets-xdg-"));
    const priorPath = process.env.PATH;
    const priorDb = process.env.DATABASE_OWNER_URL;
    const priorXdg = process.env.XDG_CONFIG_HOME;
    const log = console.log,
      warn = console.warn;
    try {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({
          contract: 1,
          deploymentId: "sekritpg",
          publicUrl: "http://localhost:8080",
          target: "docker",
          services: ["core"],
        }),
      );
      writeFileSync(
        join(dir, ".env"),
        `PUBLIC_API_URL=http://localhost:8080\nCAPABILITY_SECRET=capability-sign\nCONNECTOR_SECRET_KEY=${"connector-key".repeat(3)}\nCORE_SIGNING_SECRET=${"core-sign".repeat(4)}\nPORTAL_IDENTITY_SECRET=portal-sign\nSKILL_SIGNING_SECRET=${"skill-sign".repeat(4)}\nDEPLOYMENT_CONTROL_SECRET=${"control-sign".repeat(4)}\n`,
      );
      const fake = fakeDocker(dir);
      process.env.PATH = `${dir}:${priorPath}`;
      process.env.XDG_CONFIG_HOME = xdg;
      delete process.env.DATABASE_OWNER_URL;
      console.log = (): void => {};
      console.warn = console.log;
      const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
      await dockerUp(config, dir, {});

      const statePath = join(xdg, "qm", "deployments", "sekritpg", "state.json");
      const password = (JSON.parse(readFileSync(statePath, "utf8")) as { pgPassword?: string }).pgPassword;
      assert.ok(password, "the generated pg password is recorded in deployment state");
      assert.equal(statSync(statePath).mode & 0o777, 0o600, "state.json holds the pg password and must be 0600");

      const argv = readFileSync(fake.argvLog, "utf8");
      assert.ok(!argv.includes(password), "the pg password must not reach the docker argv");
      assert.ok(!argv.includes("POSTGRES_PASSWORD"), "POSTGRES_PASSWORD travels via the env-file, not -e");
      assert.ok(!argv.includes("postgres://"), "the derived DATABASE_URL must not reach the docker argv");

      const envFiles = readFileSync(fake.envCopy, "utf8");
      assert.ok(envFiles.includes(`POSTGRES_PASSWORD=${password}`), "pg gets its password via the env-file");
      const owner = derivedLoginPassword(password, "qm_owner");
      assert.ok(envFiles.includes(`DATABASE_OWNER_URL=postgres://qm_owner:${owner}@pg:5432/qm`));
      assert.ok(
        envFiles.includes(`DATABASE_URL=postgres://qm_app:${derivedLoginPassword(owner, "qm_app")}@pg:5432/qm`),
      );
      assert.ok(!envFiles.includes(`postgres://postgres:`), "core never receives the superuser login");
      assert.match(argv, /\["exec","-i","qm-sekritpg-pg","psql","-U","postgres","-d","qm"/);
      assert.ok(
        argv.includes('"--name","qm-sekritpg-pg","--label","qm.org=sekritpg"'),
        "container names and labels are pinned",
      );
      assert.ok(!argv.includes(owner), "the owner password reaches psql on stdin only");
    } finally {
      console.log = log;
      console.warn = warn;
      process.env.PATH = priorPath;
      if (priorDb === undefined) delete process.env.DATABASE_OWNER_URL;
      else process.env.DATABASE_OWNER_URL = priorDb;
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  },
);

test(
  "docker up gates missing required secrets before any container starts while Slack setup remains optional",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-gate-"));
    const priorPath = process.env.PATH;
    const priorDb = process.env.DATABASE_OWNER_URL;
    const priorBot = process.env.SLACK_BOT_TOKEN;
    const log = console.log,
      warn = console.warn;
    try {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({
          contract: 1,
          deploymentId: "sekritgate",
          publicUrl: "http://localhost:8080",
          target: "docker",
          services: ["core", "slack"],
        }),
      );
      writeFileSync(
        join(dir, ".env"),
        `CAPABILITY_SECRET=capability\nCONNECTOR_SECRET_KEY=${"connector".repeat(4)}\nCORE_SIGNING_SECRET=${"a".repeat(32)}\nPORTAL_IDENTITY_SECRET=identity\nSLACK_APP_TOKEN=app\n`,
      );
      const fake = fakeDocker(dir);
      process.env.PATH = `${dir}:${priorPath}`;
      process.env.DATABASE_OWNER_URL = "postgres://owner:owner-pw@external/db";
      delete process.env.SLACK_BOT_TOKEN;
      console.log = (): void => {};
      console.warn = console.log;
      const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
      await assert.rejects(dockerUp(config, dir, {}), /required secrets have no value.*SKILL_SIGNING_SECRET/s);
      for (const line of readFileSync(fake.argvLog, "utf8").split("\n").filter(Boolean)) {
        const args = JSON.parse(line) as string[];
        assert.notEqual(args[0], "run", "no container may start when a required secret is missing");
      }
    } finally {
      console.log = log;
      console.warn = warn;
      process.env.PATH = priorPath;
      if (priorDb === undefined) delete process.env.DATABASE_OWNER_URL;
      else process.env.DATABASE_OWNER_URL = priorDb;
      if (priorBot !== undefined) process.env.SLACK_BOT_TOKEN = priorBot;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a multi-line secret value fails loudly, naming the key (docker --env-file cannot carry newlines)",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-nl-"));
    const priorPath = process.env.PATH;
    const priorDb = process.env.DATABASE_OWNER_URL;
    const priorSecret = process.env.CORE_SIGNING_SECRET;
    const log = console.log,
      warn = console.warn;
    try {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({
          contract: 1,
          deploymentId: "sekritnl",
          publicUrl: "http://localhost:8080",
          target: "docker",
          services: ["core"],
        }),
      );
      writeFileSync(
        join(dir, ".env"),
        `PUBLIC_API_URL=http://localhost:8080\nCAPABILITY_SECRET=capability\nCONNECTOR_SECRET_KEY=${"connector".repeat(4)}\nPORTAL_IDENTITY_SECRET=identity\nSKILL_SIGNING_SECRET=${"ok".repeat(16)}\nDEPLOYMENT_CONTROL_SECRET=${"ctl".repeat(16)}\n`,
      );
      fakeDocker(dir);
      process.env.PATH = `${dir}:${priorPath}`;
      process.env.DATABASE_OWNER_URL = "postgres://owner:owner-pw@external/db";
      process.env.CORE_SIGNING_SECRET = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
      console.log = (): void => {};
      console.warn = console.log;
      const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
      await assert.rejects(dockerUp(config, dir, {}), /CORE_SIGNING_SECRET contains a newline/);
    } finally {
      console.log = log;
      console.warn = warn;
      process.env.PATH = priorPath;
      if (priorDb === undefined) delete process.env.DATABASE_OWNER_URL;
      else process.env.DATABASE_OWNER_URL = priorDb;
      if (priorSecret === undefined) delete process.env.CORE_SIGNING_SECRET;
      else process.env.CORE_SIGNING_SECRET = priorSecret;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
