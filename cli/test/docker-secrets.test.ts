import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";
import { dockerUp } from "../src/backends/docker.ts";

const SECRETS = {
  ANTHROPIC_API_KEY: "anthropic-supersecret",
  CAPABILITY_SECRET: "capability-supersecret",
  CONNECTOR_SECRET_KEY: "connector-supersecret".repeat(2),
  CORE_SIGNING_SECRET: "core-signing-supersecret".repeat(2),
  PORTAL_IDENTITY_SECRET: "portal-identity-supersecret",
  SKILL_SIGNING_SECRET: "skill-signing-supersecret".repeat(2),
  SB_TOKEN: "sandbox-forwarded-supersecret",
  PLUG_TOKEN: "plugin-supersecret",
  SLACK_BOT_TOKEN: "xoxb-dual-role-supersecret",
  SLACK_APP_TOKEN: "xapp-supersecret",
  PUBLIC_API_URL: "https://core.example.test",
  EXTRA_API_KEY: "config-declared-extra-supersecret",
  EXAMPLE_SCREEN_TOKEN: "security-screen-supersecret",
};

interface CreateRequest {
  path: string;
  headers: string;
  body: {
    Env: string[];
    Image: string;
    Labels: Record<string, string>;
    HostConfig: { Binds: string[]; GroupAdd: string[]; PortBindings?: Record<string, { HostPort: string }[]> };
    NetworkingConfig: { EndpointsConfig: Record<string, { Aliases: string[] }> };
  };
}

function fakeDocker(dir: string): { argvLog: string; envCopy: string; requestsLog: string; clientEnv: string } {
  const argvLog = join(dir, "docker-argv.log");
  const envCopy = join(dir, "env-copy.log");
  writeFileSync(argvLog, "");
  writeFileSync(envCopy, "");
  const requestsLog = join(dir, "requests.log");
  const clientEnv = join(dir, "client-env.log");
  writeFileSync(requestsLog, "");
  writeFileSync(clientEnv, "");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "version") { console.log("25.0"); process.exit(0); }
if (args[0] === "system" && args[1] === "dial-stdio") {
  const raw = fs.readFileSync(0, "utf8");
  const path = raw.split(" ")[1];
  const body = JSON.parse(raw.slice(raw.indexOf("\\r\\n\\r\\n") + 4));
  fs.appendFileSync(${JSON.stringify(requestsLog)}, JSON.stringify({path, body, headers: raw.slice(0, raw.indexOf("\\r\\n\\r\\n"))}) + "\\n");
  fs.appendFileSync(${JSON.stringify(clientEnv)}, JSON.stringify(Object.fromEntries(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_API_VERSION", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "LD_PRELOAD", "PATH", "HOME", "CORE_SIGNING_SECRET", "PLUG_TOKEN"].map(k => [k, process.env[k]]))) + "\\n");
  if (body.Env) fs.appendFileSync(${JSON.stringify(envCopy)}, body.Env.join("\\n") + "\\n---\\n");
  const modePath = ${JSON.stringify(join(dir, "api-mode"))};
  const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8") : "";
  const created = JSON.stringify({Id: "a".repeat(64)});
  if (mode === "process-error") { console.error(JSON.stringify(body)); process.exit(1); }
  if (mode === "truncated") { process.stdout.write("HTTP/1.1 201 Created\\r\\nContent-Length: 1000\\r\\n\\r\\n{"); process.exit(0); }
  if (mode === "invalid-id") { process.stdout.write('HTTP/1.1 201 Created\\r\\nContent-Length: 12\\r\\n\\r\\n{"Id":"bad"}'); process.exit(0); }
  if (mode === "chunked" && path.includes("/create?")) { process.stdout.write("HTTP/1.1 201 Created\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n" + Buffer.byteLength(created).toString(16) + "\\r\\n" + created + "\\r\\n0\\r\\n\\r\\n"); process.exit(0); }
  if (mode === "informational") process.stdout.write("HTTP/1.1 100 Continue\\r\\n\\r\\n");
  if (fs.existsSync(${JSON.stringify(join(dir, "reject-api"))})) {
    process.stdout.write("HTTP/1.1 500 Server Error\\r\\nConnection: close\\r\\n\\r\\n" + JSON.stringify(body));
    process.exit(0);
  }
  process.stdout.write(path.includes("/create?") ? 'HTTP/1.1 201 Created\\r\\nContent-Length: 73\\r\\n\\r\\n{"Id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' : "HTTP/1.1 204 No Content\\r\\n\\r\\n");
  if (mode === "linger") setInterval(() => {}, 1000);
  else process.exit(0);
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
  return { argvLog, envCopy, requestsLog, clientEnv };
}

test("docker up keeps secret values off the docker argv", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-secrets-"));
  const priorPath = process.env.PATH;
  const priorDb = process.env.DATABASE_URL;
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
          { name: "signer", image: "ghcr.io/acme/signer:1", coreAccess: false },
        ],
        sandbox: {
          app: "sekrit-sandboxes",
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
    assert.ok(!argv.includes("--env-file"), "docker runs do not need a temporary env file");
    const requests = readFileSync(fake.requestsLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CreateRequest);
    const creates = requests.filter((request) => request.path.startsWith("/containers/create?"));
    const signer = creates.find((request) => request.path.endsWith("name=qm-sekrit-signer"));
    assert.ok(signer, "the actual coreless container-create request is inspected");
    assert.ok(
      !signer.body.Env.some((entry) => entry.startsWith("CORE_API_URL=")),
      "coreless plugin gets no core endpoint",
    );
    assert.ok(
      !signer.body.Env.some((entry) => entry.startsWith("CORE_SIGNING_SECRET=")),
      "coreless plugin gets no source-auth secret",
    );
    const core = creates.find((request) => request.path.endsWith("name=qm-sekrit-core"))!;
    assert.deepEqual(core.body.HostConfig.PortBindings, { "8080/tcp": [{ HostIp: "", HostPort: "8080" }] });
    assert.ok(core.body.HostConfig.Binds.includes("qm-sekrit-coredata:/data"));
    assert.deepEqual(core.body.NetworkingConfig.EndpointsConfig["qm-sekrit"]!.Aliases, [
      "core",
      "qm-sekrit-core.internal",
    ]);
    assert.equal(core.body.Labels["qm.org"], "sekrit");
    const sentEnv = creates.flatMap((request) => request.body.Env);
    for (const entry of [
      "FLY_RESIDENT_ENV_TZ=UTC",
      "LINEAR_REGION=us",
      "SECURITY_SCREEN_BACKEND=proxy",
      "SECURITY_SCREEN_PROXY_PROVIDER=example-screen",
      "SECURITY_SCREEN_PROXY_ENDPOINT=https://screen.example.test/classify",
      "SECURITY_SCREEN_PROXY_ROLLOUT=enforce",
      "WEB_UI_PUBLIC_URL=http://folded.example.com/web-ui",
    ])
      assert.ok(sentEnv.includes(entry), entry);
    const clientEnv = readFileSync(fake.clientEnv, "utf8");
    assert.ok(!clientEnv.includes(SECRETS.CORE_SIGNING_SECRET));
    assert.ok(!clientEnv.includes(SECRETS.PLUG_TOKEN));

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
    assert.ok(envFiles.includes("DATABASE_URL=postgres://external/db"), "DATABASE_URL reaches docker");
    assert.ok(envFiles.includes(`FLY_RESIDENT_ENV_SB_TOKEN=${SECRETS.SB_TOKEN}`), "secretEnv values reach docker");
    assert.ok(envFiles.includes(`PLUG_TOKEN=${SECRETS.PLUG_TOKEN}`), "plugin secrets reach docker");
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
      "config secretEnv extras reach docker",
    );
    assert.match(
      envFiles,
      new RegExp(`^APPS_SESSION_ALIAS=${SECRETS.PORTAL_IDENTITY_SECRET}$`, "m"),
      "a secretEnv alias delivers the stored value under its declared env name",
    );
    assert.match(envFiles, new RegExp(`^SECURITY_SCREEN_PROXY_TOKEN=${SECRETS.EXAMPLE_SCREEN_TOKEN}$`, "m"));

    assert.equal(process.env.CORE_SIGNING_SECRET, undefined, "secret delivery does not mutate the parent environment");
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    if (priorDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDb;
    for (const [name, value] of priorSecrets) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "managed Postgres: the generated password and DATABASE_URL never reach the docker argv; state.json is 0600",
  { timeout: 60_000 },
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
      const requests = readFileSync(fake.requestsLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CreateRequest);
      const pg = requests.find((request) => request.path.endsWith("name=qm-sekritpg-pg"))!;
      assert.equal(pg.body.Image, "postgres:16");
      assert.deepEqual(pg.body.HostConfig.Binds, ["qm-sekritpg-pgdata:/var/lib/postgresql/data"]);
      assert.ok(pg.body.Env.includes("POSTGRES_DB=qm"));
      assert.ok(!argv.includes("postgres://"), "the derived DATABASE_URL must not reach the docker argv");

      const envFiles = readFileSync(fake.envCopy, "utf8");
      assert.ok(envFiles.includes(`POSTGRES_PASSWORD=${password}`), "pg gets its password through the Docker API body");
      assert.ok(
        envFiles.includes(`DATABASE_URL=postgres://postgres:${password}@pg:5432/qm`),
        "the core gets DATABASE_URL through the Docker API body",
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
  { timeout: 60_000 },
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

test("a multi-line secret value is delivered through the Docker API body", { timeout: 60_000 }, async () => {
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
    const fake = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.DATABASE_URL = "postgres://external/db";
    process.env.CORE_SIGNING_SECRET = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
    console.log = (): void => {};
    console.warn = console.log;
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await dockerUp(config, dir, {});
    assert.ok(
      readFileSync(fake.envCopy, "utf8").includes("CORE_SIGNING_SECRET=-----BEGIN KEY-----\nabc\n-----END KEY-----"),
      "API delivery preserves multi-line secret values",
    );
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
});

async function withDockerSecrets(
  extraConfig: Record<string, unknown>,
  secrets: Record<string, string>,
  check: (fixture: ReturnType<typeof fakeDocker> & { dir: string; up: () => Promise<void> }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-api-secrets-"));
  const priorPath = process.env.PATH;
  const priorDb = process.env.DATABASE_URL;
  const log = console.log,
    warn = console.warn;
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "apisecrets",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        ...extraConfig,
      }),
    );
    writeFileSync(
      join(dir, ".env"),
      Object.entries({ ...SECRETS, DATABASE_URL: "postgres://sentinel:db@db/qm", ...secrets })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    const fake = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    delete process.env.DATABASE_URL;
    console.log = (): void => {};
    console.warn = console.log;
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await check({ ...fake, dir, up: () => dockerUp(config, dir, {}) });
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    if (priorDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDb;
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const plugin of [false, true]) {
  test(`container control variables never alter the Docker client (${plugin ? "plugin" : "core"})`, async () => {
    const names = [
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "DOCKER_API_VERSION",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "LD_PRELOAD",
      "PATH",
      "HOME",
    ];
    const values = Object.fromEntries(names.map((name) => [name, `sentinel-container-${name}`]));
    const aliases = Object.fromEntries(names.map((name) => [name, `STORED_${name}`]));
    const extraConfig = plugin
      ? {
          plugins: [
            {
              name: "signer",
              image: "example.invalid/signer:1",
              coreAccess: false,
              secrets: names.map((name) => ({ name })),
            },
          ],
        }
      : { secretEnv: { core: aliases } };
    const secrets = plugin ? values : Object.fromEntries(names.map((name) => [aliases[name], values[name]]));
    await withDockerSecrets(extraConfig, secrets, async (fixture) => {
      const expected = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      await fixture.up();
      const clients = readFileSync(fixture.clientEnv, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, string>);
      assert.ok(clients.length > 0);
      for (const client of clients) for (const name of names) assert.equal(client[name], expected[name], name);
      const creates = readFileSync(fixture.requestsLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CreateRequest);
      const request = creates.find((entry) => entry.path.endsWith(`name=qm-apisecrets-${plugin ? "signer" : "core"}`))!;
      for (const name of names) assert.ok(request.body.Env.includes(`${name}=${values[name]}`));
      if (plugin) assert.ok(!request.body.Env.some((entry) => entry.startsWith("CORE_SIGNING_SECRET=")));
      for (const name of names) assert.equal(process.env[name], expected[name]);
    });
  });
}

for (const source of ["core", "plugin", "database", "literal"]) {
  test(`NUL in ${source} environment is rejected without values before deployment changes`, async () => {
    const sentinel = "sentinel-private-prefix\0private-suffix";
    const configs: Record<string, Record<string, unknown>> = {
      plugin: {
        plugins: [
          { name: "signer", image: "example.invalid/signer:1", coreAccess: false, secrets: [{ name: "PLUG_TOKEN" }] },
        ],
      },
      literal: { env: { core: { CUSTOM_VALUE: sentinel } } },
    };
    const keys: Record<string, string> = { plugin: "PLUG_TOKEN", database: "DATABASE_URL" };
    const key = keys[source] ?? "CAPABILITY_SECRET";
    const extraConfig = configs[source] ?? {};
    const secrets = source === "literal" ? {} : { [key]: sentinel };
    await withDockerSecrets(extraConfig, secrets, async (fixture) => {
      await assert.rejects(fixture.up(), (error: Error) => {
        assert.match(error.message, /NUL byte/);
        assert.ok(!error.message.includes("sentinel-private-prefix"));
        assert.ok(!error.message.includes("private-suffix"));
        return true;
      });
      const commands = readFileSync(fixture.argvLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(
        commands.map((args) => args[0]),
        ["version"],
      );
      assert.equal(readFileSync(fixture.requestsLog, "utf8"), "");
    });
  });
}

test("Docker API error bodies containing secrets are withheld", async () => {
  await withDockerSecrets({}, {}, async (fixture) => {
    writeFileSync(join(fixture.dir, "reject-api"), "");
    await assert.rejects(fixture.up(), (error: Error) => {
      assert.match(error.message, /HTTP 500/);
      for (const secret of Object.values(SECRETS)) assert.ok(!error.message.includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});

for (const mode of ["process-error", "truncated", "invalid-id"]) {
  test(`Docker API ${mode} fails closed without starting a container or disclosing values`, async () => {
    await withDockerSecrets({}, {}, async (fixture) => {
      writeFileSync(join(fixture.dir, "api-mode"), mode);
      await assert.rejects(fixture.up(), (error: Error) => {
        assert.match(error.message, /Docker API/);
        for (const value of Object.values(SECRETS)) assert.ok(!error.message.includes(value));
        return true;
      });
      assert.ok(!readFileSync(fixture.requestsLog, "utf8").includes("/start"));
    });
  });
}

for (const mode of ["chunked", "informational", "linger"]) {
  test(`Docker API handles ${mode} and starts the returned ID rather than the mutable name`, async () => {
    await withDockerSecrets({}, {}, async (fixture) => {
      writeFileSync(join(fixture.dir, "api-mode"), mode);
      const before = Date.now();
      await fixture.up();
      assert.ok(Date.now() - before < 10_000, "a complete response must not wait for the proxy to exit");
      const requests = readFileSync(fixture.requestsLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CreateRequest);
      assert.equal(requests[1]!.path, `/containers/${"a".repeat(64)}/start`);
    });
  });
}

test("Docker proxy defaults, explicit overrides, custom headers and default platform survive API delivery", async () => {
  await withDockerSecrets({ env: { core: { HTTPS_PROXY: "explicit-proxy" } } }, {}, async (fixture) => {
    const priorConfig = process.env.DOCKER_CONFIG;
    const priorPlatform = process.env.DOCKER_DEFAULT_PLATFORM;
    const priorVersion = process.env.DOCKER_API_VERSION;
    const priorHeaders = process.env.DOCKER_CUSTOM_HEADERS;
    try {
      process.env.DOCKER_CONFIG = fixture.dir;
      process.env.DOCKER_DEFAULT_PLATFORM = "linux/arm64";
      process.env.DOCKER_API_VERSION = "1.47";
      process.env.DOCKER_CUSTOM_HEADERS = "X-Launcher-Test=launcher-header-sentinel";
      writeFileSync(
        join(fixture.dir, "config.json"),
        JSON.stringify({
          proxies: { default: { httpProxy: "http://default-proxy", httpsProxy: "https://default-proxy" } },
          HttpHeaders: { "X-Docker-Test": "header-sentinel" },
        }),
      );
      await fixture.up();
      const requests = readFileSync(fixture.requestsLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CreateRequest);
      assert.ok(requests[0]!.path.startsWith("/v1.47/containers/create?"));
      assert.ok(requests[0]!.path.endsWith("&platform=linux%2Farm64"));
      for (const request of requests) assert.match(request.headers, /X-Launcher-Test: launcher-header-sentinel/i);
      for (const request of requests) assert.match(request.headers, /X-Docker-Test: header-sentinel/i);
      const env = requests[0]!.body.Env;
      assert.ok(env.includes("HTTP_PROXY=http://default-proxy"));
      assert.ok(env.includes("http_proxy=http://default-proxy"));
      assert.ok(env.includes("HTTPS_PROXY=explicit-proxy"));
      assert.ok(env.includes("https_proxy=https://default-proxy"));
    } finally {
      if (priorConfig === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = priorConfig;
      if (priorPlatform === undefined) delete process.env.DOCKER_DEFAULT_PLATFORM;
      else process.env.DOCKER_DEFAULT_PLATFORM = priorPlatform;
      if (priorVersion === undefined) delete process.env.DOCKER_API_VERSION;
      else process.env.DOCKER_API_VERSION = priorVersion;
      if (priorHeaders === undefined) delete process.env.DOCKER_CUSTOM_HEADERS;
      else process.env.DOCKER_CUSTOM_HEADERS = priorHeaders;
    }
  });
});
