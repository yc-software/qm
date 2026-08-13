import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";
import { dockerDown, dockerUp } from "../src/backends/docker.ts";

const SECRETS = {
  ANTHROPIC_API_KEY: "anthropic-supersecret",
  CAPABILITY_SECRET: "capability-supersecret",
  CONNECTOR_SECRET_KEY: "connector-supersecret".repeat(2),
  CORE_SIGNING_SECRET: "core-signing-supersecret".repeat(2),
  PORTAL_IDENTITY_SECRET: "portal-identity-supersecret",
  SKILL_SIGNING_SECRET: "skill-signing-supersecret".repeat(2),
  FLY_SANDBOX_API_TOKEN: "fly-api-supersecret",
  SB_TOKEN: "sandbox-forwarded-supersecret",
  PLUG_TOKEN: "plugin-supersecret",
  SLACK_BOT_TOKEN: "xoxb-dual-role-supersecret",
  SLACK_APP_TOKEN: "xapp-supersecret",
  SPRITES_TOKEN: "sprites-supersecret",
  PUBLIC_API_URL: "https://core.example.com",
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
if (args[0] === "version") { console.log("29.0"); process.exit(0); }
if (args[0] === "context" && args[1] === "inspect") { console.log(process.env.FAKE_DOCKER_ENDPOINT || ${JSON.stringify(`unix://${join(dir, "docker.sock")}`)}); process.exit(0); }
if (args[0] === "run") {
  if (args.includes("--entrypoint") && args[args.indexOf("--entrypoint") + 1] === "stat") {
    console.log(process.env.FAKE_SOCKET_GID || "0");
    process.exit(0);
  }
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
if (args[0] === "volume" && args[1] === "inspect") { console.error("No such volume"); process.exit(1); }
if (args[0] === "volume" && args[1] === "create") { console.log(args[args.length - 1]); process.exit(0); }
if (args[0] === "volume" && args[1] === "ls") { process.exit(0); }
if (args[0] === "volume" && args[1] === "rm") { console.error("No such volume"); process.exit(1); }
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

function fakeLegacyDocker(dir: string): string {
  const argvLog = join(dir, "docker-legacy-argv.log");
  writeFileSync(argvLog, "");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "version") { console.log("29.0"); process.exit(0); }
if (args[0] === "ps") {
  if (args.includes("label=qm.volume-org=acme")) console.log("qm-volume-legacy-owner");
  else if (args.includes("label=qm.org=acme")) console.log(["qm-acme-core", "qm-sbx-legacy-abc123", "qm-scratch-legacy-def456"].join("\\n"));
  else console.log(["qm-acme-core", "qm-sbx-legacy-abc123", "qm-scratch-legacy-def456", "qm-volume-legacy-owner"].join("\\n"));
  process.exit(0);
}
if (args[0] === "inspect") {
  const name = args[args.length - 1];
  const format = args[args.indexOf("-f") + 1] || "";
  if (format.includes("qm.sandbox")) { console.log(name.startsWith("qm-sbx-") || name.startsWith("qm-scratch-") ? "1" : ""); process.exit(0); }
  if (format.includes(".Mounts")) { console.log(name.startsWith("qm-sbx-") ? "qm-home-legacy-abc123" : ""); process.exit(0); }
  if (format.includes("NetworkSettings.Networks")) { console.log(name.startsWith("qm-sbx-") ? "qm-net-legacy-abc123" : name.startsWith("qm-scratch-") ? "qm-net-legacy-def456" : ""); process.exit(0); }
}
if (args[0] === "volume" && args[1] === "inspect") { console.log(""); process.exit(0); }
if ((args[0] === "volume" || args[0] === "network") && args[1] === "ls") { process.exit(0); }
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return argvLog;
}

test("docker up delivers secrets via a 0600 env-file, never on the docker argv", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-"));
  const priorPath = process.env.PATH;
  const priorDb = process.env.DATABASE_URL;
  const priorContext = process.env.DOCKER_CONTEXT;
  const priorHost = process.env.DOCKER_HOST;
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
        orgId: "sekrit",
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
        ],
        sandbox: {
          app: "sekrit-sandboxes",
          image:
            "registry.fly.io/sekrit-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
          env: { TZ: "UTC" },
          secretEnv: ["SB_TOKEN", "SLACK_BOT_TOKEN"],
        },
        securityScreen: {
          backend: "proxy",
          provider: "example-screen",
          endpoint: "https://screen.example.test/classify",
          rollout: "enforce",
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
            HARNESS: "pi",
            DEPLOY_PROVIDER: " aws ",
            SANDBOX_BACKEND: " sprites ",
            SANDBOX_SECONDARY_BACKEND: " local ",
            DATA_DIR: "/custom",
            CORE_SIGNING_SECRET: "config-placeholder",
            DATABASE_URL: "postgres://config/placeholder",
            PUBLIC_API_URL: "https://config-placeholder.invalid",
            FLY_RESIDENT_ENV_SB_TOKEN: "config-placeholder",
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
        "HARNESS=pi",
      ].join("\n"),
    );
    const fake = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.DATABASE_URL = "postgres://external/db";
    process.env.DOCKER_CONTEXT = "fake";
    delete process.env.DOCKER_HOST;
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
    assert.ok(
      !argv.includes("postgres://external/db"),
      "a BYO DATABASE_URL (it embeds a password) must not reach the docker argv",
    );
    assert.ok(!argv.includes("config-placeholder"), "non-secret config env cannot shadow or expose secret values");
    assert.ok(argv.includes("--env-file"), "secrets travel via --env-file");
    assert.ok(argv.includes("FLY_SANDBOX_APP_NAME=sekrit-sandboxes"), "non-secret env still flows as -e");
    assert.ok(argv.includes("FLY_RESIDENT_ENV_TZ=UTC"), "sandbox.env literals are not secrets");
    assert.ok(argv.includes("LINEAR_REGION=us"), "undeclared plugin env still flows as -e");
    assert.ok(argv.includes("SECURITY_SCREEN_BACKEND=proxy"));
    assert.ok(argv.includes("SECURITY_SCREEN_PROXY_PROVIDER=example-screen"));
    assert.ok(argv.includes("SECURITY_SCREEN_PROXY_ENDPOINT=https://screen.example.test/classify"));
    assert.ok(argv.includes("SECURITY_SCREEN_PROXY_ROLLOUT=enforce"));
    assert.ok(argv.includes("DOCKER_CORE_CONTAINER=qm-sekrit-core"));
    assert.ok(argv.includes("DOCKER_CORE_DATA_VOLUME=qm-sekrit-coredata"));
    assert.ok(argv.includes("DOCKER_DEPLOY_NETWORK=qm-sekrit-deployments"));
    assert.ok(argv.includes("DATA_DIR=/data"));
    assert.ok(argv.includes(`${join(dir, "docker.sock")}:/var/run/docker.sock`));
    assert.ok(!argv.includes("DATA_DIR=/custom"));

    assert.ok(
      argv.includes("WEB_UI_PUBLIC_URL=http://folded.example.com/web-ui"),
      "virtual-service env folds into the core env",
    );
    assert.ok(
      lines.some((l) => /\.env keys not forwarded/.test(l) && l.includes("HARNESS")),
      "unforwarded .env keys are warned about",
    );
    assert.ok(
      !lines.some((l) => /\.env keys not forwarded/.test(l) && l.includes("SB_TOKEN")),
      "consumed secret names are not warned about",
    );

    const envFiles = readFileSync(fake.envCopy, "utf8");
    assert.ok(envFiles.includes(`CORE_SIGNING_SECRET=${SECRETS.CORE_SIGNING_SECRET}`));
    assert.ok(
      !envFiles.includes("config-placeholder"),
      "secret-store values win over colliding config env on services and plugins",
    );
    assert.ok(envFiles.includes("DATABASE_URL=postgres://external/db"), "DATABASE_URL routes through the env-file");
    assert.ok(
      envFiles.includes(`FLY_RESIDENT_ENV_SB_TOKEN=${SECRETS.SB_TOKEN}`),
      "secretEnv values route through the file",
    );
    assert.ok(envFiles.includes(`PLUG_TOKEN=${SECRETS.PLUG_TOKEN}`), "plugin secrets route through the file");
    assert.match(
      envFiles,
      new RegExp(`^ANTHROPIC_API_KEY=${ambientAnthropic}$`, "m"),
      "a blank scaffold entry falls back to the ambient secret",
    );
    assert.doesNotMatch(envFiles, /^EMPTY_TOKEN=/m, "a blank optional secret with no ambient value remains unset");
    assert.ok(
      envFiles.includes(`PUBLIC_API_URL=${SECRETS.PUBLIC_API_URL}`),
      "the sandbox-reachable self-API URL reaches core",
    );
    assert.ok(
      envFiles.includes(`FLY_RESIDENT_ENV_SLACK_BOT_TOKEN=${SECRETS.SLACK_BOT_TOKEN}`),
      "dual-role secret is forwarded into sandboxes",
    );
    assert.match(
      envFiles,
      new RegExp(`^SLACK_BOT_TOKEN=${SECRETS.SLACK_BOT_TOKEN}$`, "m"),
      "dual-role secret keeps its plain name for the in-process slack surface",
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
    assert.match(envFiles, new RegExp(`^SECURITY_SCREEN_PROXY_TOKEN=${SECRETS.EXAMPLE_SCREEN_TOKEN}$`, "m"));
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
    if (priorContext === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = priorContext;
    if (priorHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = priorHost;
    if (priorDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDb;
    for (const [name, value] of priorSecrets) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed Docker socket probe leaves no secret env file behind", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-socket-probe-"));
  const priorPath = process.env.PATH;
  const priorDb = process.env.DATABASE_URL;
  const priorContext = process.env.DOCKER_CONTEXT;
  const priorTmp = process.env.TMPDIR;
  const priorGid = process.env.FAKE_SOCKET_GID;
  const log = console.log;
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "socket-probe",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        env: { core: { HARNESS: "mock" } },
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      `CAPABILITY_SECRET=capability\nCONNECTOR_SECRET_KEY=${"connector".repeat(4)}\nCORE_SIGNING_SECRET=${"core".repeat(8)}\nPORTAL_IDENTITY_SECRET=identity\nSKILL_SIGNING_SECRET=${"skill".repeat(8)}\n`,
    );
    fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.DATABASE_URL = "postgres://external/db";
    process.env.DOCKER_CONTEXT = "fake";
    process.env.TMPDIR = dir;
    process.env.FAKE_SOCKET_GID = "invalid";
    console.log = (): void => {};
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await assert.rejects(dockerUp(config, dir, {}), /could not resolve the Docker socket group/);
    assert.equal(
      readdirSync(dir).some((name) => name.startsWith("qm-env-")),
      false,
    );
  } finally {
    console.log = log;
    process.env.PATH = priorPath;
    if (priorDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDb;
    if (priorContext === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = priorContext;
    if (priorTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmp;
    if (priorGid === undefined) delete process.env.FAKE_SOCKET_GID;
    else process.env.FAKE_SOCKET_GID = priorGid;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Docker context selection rejects remote daemons before stack mutation", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-remote-context-"));
  const priorPath = process.env.PATH;
  const priorDb = process.env.DATABASE_URL;
  const priorContext = process.env.DOCKER_CONTEXT;
  const priorHost = process.env.DOCKER_HOST;
  const priorEndpoint = process.env.FAKE_DOCKER_ENDPOINT;
  const log = console.log;
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "remote-context",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        env: { core: { HARNESS: "mock" } },
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      `CAPABILITY_SECRET=capability\nCONNECTOR_SECRET_KEY=${"connector".repeat(4)}\nCORE_SIGNING_SECRET=${"core".repeat(8)}\nPORTAL_IDENTITY_SECRET=identity\nSKILL_SIGNING_SECRET=${"skill".repeat(8)}\n`,
    );
    const fake = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.DATABASE_URL = "postgres://external/db";
    process.env.DOCKER_CONTEXT = "remote";
    process.env.DOCKER_HOST = `unix://${join(dir, "wrong.sock")}`;
    process.env.FAKE_DOCKER_ENDPOINT = "ssh://builder.example.test";
    console.log = (): void => {};
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await assert.rejects(dockerUp(config, dir, {}), /requires a local Unix socket context/);
    const calls = readFileSync(fake.argvLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "network" && args[1] === "create"),
      false,
    );
  } finally {
    console.log = log;
    process.env.PATH = priorPath;
    if (priorDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDb;
    if (priorContext === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = priorContext;
    if (priorHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = priorHost;
    if (priorEndpoint === undefined) delete process.env.FAKE_DOCKER_ENDPOINT;
    else process.env.FAKE_DOCKER_ENDPOINT = priorEndpoint;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mixed local and remote sandboxes require an external core URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-mixed-sandbox-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "mixed-sandbox",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        env: {
          core: {
            HARNESS: "mock",
            DEPLOY_PROVIDER: "aws",
            SANDBOX_BACKEND: "aws",
            SANDBOX_SECONDARY_BACKEND: "local",
          },
        },
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      `CAPABILITY_SECRET=capability\nCONNECTOR_SECRET_KEY=${"connector".repeat(4)}\nCORE_SIGNING_SECRET=${"core".repeat(8)}\nPORTAL_IDENTITY_SECRET=identity\nSKILL_SIGNING_SECRET=${"skill".repeat(8)}\n`,
    );
    fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    console.log = (): void => {};
    console.warn = console.log;
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await assert.rejects(
      dockerUp(config, dir, { dryRun: true }),
      /mixed local and remote sandbox backends require an externally reachable PUBLIC_API_URL/,
    );
    for (const publicApiUrl of ["http://10.0.0.8:8080", "https://[::1]", "https://localhost."]) {
      config.env.core = { ...config.env.core, PUBLIC_API_URL: publicApiUrl };
      await assert.rejects(
        dockerUp(config, dir, { dryRun: true }),
        /require an externally reachable HTTPS PUBLIC_API_URL/,
      );
    }
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "managed Postgres: the generated password and DATABASE_URL never reach the docker argv; state.json is 0600",
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-pg-"));
    const xdg = mkdtempSync(join(tmpdir(), "qm-docker-secrets-xdg-"));
    const priorPath = process.env.PATH;
    const priorDb = process.env.DATABASE_URL;
    const priorXdg = process.env.XDG_CONFIG_HOME;
    const log = console.log,
      warn = console.warn;
    try {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({
          contract: 1,
          orgId: "sekritpg",
          publicUrl: "http://localhost:8080",
          target: "docker",
          services: ["core"],
        }),
      );
      writeFileSync(
        join(dir, ".env"),
        `CAPABILITY_SECRET=capability-sign\nCONNECTOR_SECRET_KEY=${"connector-key".repeat(3)}\nCORE_SIGNING_SECRET=${"core-sign".repeat(4)}\nPORTAL_IDENTITY_SECRET=portal-sign\nSKILL_SIGNING_SECRET=${"skill-sign".repeat(4)}\n`,
      );
      const fake = fakeDocker(dir);
      process.env.PATH = `${dir}:${priorPath}`;
      process.env.XDG_CONFIG_HOME = xdg;
      delete process.env.DATABASE_URL;
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
      assert.ok(
        envFiles.includes(`DATABASE_URL=postgres://postgres:${password}@pg:5432/qm`),
        "the core gets DATABASE_URL via the env-file",
      );
    } finally {
      console.log = log;
      console.warn = warn;
      process.env.PATH = priorPath;
      if (priorDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDb;
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  },
);

test(
  "docker up gates missing required secrets before any container starts while Slack setup remains optional",
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-gate-"));
    const priorPath = process.env.PATH;
    const priorDb = process.env.DATABASE_URL;
    const priorBot = process.env.SLACK_BOT_TOKEN;
    const log = console.log,
      warn = console.warn;
    try {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({
          contract: 1,
          orgId: "sekritgate",
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
      process.env.DATABASE_URL = "postgres://external/db";
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
      if (priorDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDb;
      if (priorBot !== undefined) process.env.SLACK_BOT_TOKEN = priorBot;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a multi-line secret value fails loudly, naming the key (docker --env-file cannot carry newlines)",
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-nl-"));
    const priorPath = process.env.PATH;
    const priorDb = process.env.DATABASE_URL;
    const priorSecret = process.env.CORE_SIGNING_SECRET;
    const log = console.log,
      warn = console.warn;
    try {
      writeFileSync(
        join(dir, CONFIG_FILENAME),
        JSON.stringify({
          contract: 1,
          orgId: "sekritnl",
          publicUrl: "http://localhost:8080",
          target: "docker",
          services: ["core"],
        }),
      );
      writeFileSync(
        join(dir, ".env"),
        `CAPABILITY_SECRET=capability\nCONNECTOR_SECRET_KEY=${"connector".repeat(4)}\nPORTAL_IDENTITY_SECRET=identity\nSKILL_SIGNING_SECRET=${"ok".repeat(16)}\n`,
      );
      fakeDocker(dir);
      process.env.PATH = `${dir}:${priorPath}`;
      process.env.DATABASE_URL = "postgres://external/db";
      process.env.CORE_SIGNING_SECRET = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
      console.log = (): void => {};
      console.warn = console.log;
      const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
      await assert.rejects(dockerUp(config, dir, {}), /CORE_SIGNING_SECRET contains a newline/);
    } finally {
      console.log = log;
      console.warn = warn;
      process.env.PATH = priorPath;
      if (priorDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDb;
      if (priorSecret === undefined) delete process.env.CORE_SIGNING_SECRET;
      else process.env.CORE_SIGNING_SECRET = priorSecret;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("docker down preserves legacy home ownership and purge discovers its unlabeled resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-legacy-down-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        env: { core: { HARNESS: "mock", SANDBOX_BACKEND: "local" } },
      }),
    );
    const argvLog = fakeLegacyDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    console.log = (): void => {};
    console.warn = console.log;
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await dockerDown(config);
    const down = readFileSync(argvLog, "utf8");
    assert.match(down, /\["stop","-t","2","qm-sbx-legacy-abc123"\]/);
    assert.doesNotMatch(down, /\["rm","-f","qm-sbx-legacy-abc123"\]/);
    assert.doesNotMatch(down, /\["rm","-f","qm-volume-legacy-owner"\]/);
    writeFileSync(argvLog, "");
    await dockerDown(config, { purge: true });
    const purge = readFileSync(argvLog, "utf8");
    assert.match(purge, /\["network","rm","qm-net-legacy-abc123"\]/);
    assert.match(purge, /\["network","rm","qm-net-legacy-def456"\]/);
    assert.match(purge, /\["volume","rm","qm-home-legacy-abc123"\]/);
    assert.match(purge, /\["rm","-f","qm-volume-legacy-owner"\]/);
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
