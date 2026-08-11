import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigAt, type QmConfig } from "../src/config.ts";
import {
  derivedTomlFor,
  derivedPluginTomlFor,
  flyCheckLive,
  flyLiveSessionCommand,
  flyS3ProbeCommand,
  flyUp,
} from "../src/backends/fly.ts";
import type { ResolvedPlugin } from "../src/plugins.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Fly runs the live session smoke inside the private core machine", () => {
  assert.equal(flyLiveSessionCommand(), "node src/deployment/postdeploy-smoke.ts session http://127.0.0.1:8080");
});

test("a fly config's sandbox block rewrites the core fly.toml [env] (app, image, env literals)", () => {
  const { config } = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"));
  const cfg = {
    ...config,
    sandbox: {
      app: "acme-sb",
      image: "registry.fly.io/acme-sb@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
      env: { TZ: "UTC" },
      secretEnv: ["COMPANY_API_TOKEN"],
    },
  };

  const core = derivedTomlFor(cfg, "core", repoRoot);
  assert.match(core, /FLY_SANDBOX_APP_NAME = "acme-sb"/, "sandbox.app overrides the baked app name");
  assert.match(
    core,
    /FLY_BASE_IMAGE = "registry\.fly\.io\/acme-sb@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a"/,
    "FLY_BASE_IMAGE is the config's digest pin",
  );
  assert.match(core, /FLY_RESIDENT_ENV_TZ = "UTC"/, "sandbox.env literal forwarded as FLY_RESIDENT_ENV_*");
  assert.doesNotMatch(
    core,
    /FLY_RESIDENT_ENV_COMPANY_API_TOKEN/,
    "secretEnv value/name must not be written to the toml",
  );

  const admin = derivedTomlFor(cfg, "admin", repoRoot);
  assert.doesNotMatch(admin, /FLY_RESIDENT_ENV_TZ/);
  assert.doesNotMatch(admin, /FLY_SANDBOX_APP_NAME = "acme-sb"/);
});

test("the fly target routes security screen proxy configuration only to core", () => {
  const { config } = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"));
  const screened: QmConfig = {
    ...config,
    securityScreen: {
      backend: "proxy",
      provider: "example-screen",
      endpoint: "https://screen.example.test/classify",
      rollout: "shadow",
    },
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(generatedEnv(derivedTomlFor(screened, "core", repoRoot))).filter(([name]) =>
        name.startsWith("SECURITY_SCREEN_"),
      ),
    ),
    {
      SECURITY_SCREEN_BACKEND: "proxy",
      SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
      SECURITY_SCREEN_PROXY_PROVIDER: "example-screen",
      SECURITY_SCREEN_PROXY_ROLLOUT: "shadow",
    },
  );
  assert.deepEqual(
    Object.keys(generatedEnv(derivedTomlFor(screened, "admin", repoRoot))).filter((name) =>
      name.startsWith("SECURITY_SCREEN_"),
    ),
    [],
  );
});

test("the fly target derives a plugin fly.toml wiring it to the core over 6PN", () => {
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    appPrefix: "qm",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [{ name: "linear" }],
    skills: [],
    env: {},
    imageOverrides: {},
  };
  const plugin: ResolvedPlugin = { name: "linear", kind: "image", image: "ghcr.io/x:1", env: { LINEAR_REGION: "us" } };
  const toml = derivedPluginTomlFor(config, plugin);

  assert.match(toml, /app = "qm-linear"/, "app is <appPrefix>-<name>");
  assert.match(toml, /primary_region = "sjc"/);
  assert.match(toml, /CORE_API_URL = "http:\/\/qm-core\.internal:8080"/, "plugin reaches core over 6PN");
  assert.match(toml, /CORE_ORG_ID = "acme"/);
  assert.match(toml, /PORT = "8080"/);
  assert.match(toml, /LINEAR_REGION = "us"/, "the entry's non-secret env is forwarded");
  assert.match(
    toml,
    /\[checks\.ready\][\s\S]*type = "tcp"[\s\S]*port = 8080/,
    "plugins declare a private TCP readiness check",
  );
  assert.doesNotMatch(toml, /CORE_SIGNING_SECRET/, "the source-auth secret must not be in the toml");
});

test("a plugin's entry env can override the injected wiring (entry env wins)", () => {
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    appPrefix: "qm",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
  };
  const plugin: ResolvedPlugin = { name: "custom", kind: "source", env: { CORE_API_URL: "http://elsewhere:9000" } };
  assert.match(derivedPluginTomlFor(config, plugin), /CORE_API_URL = "http:\/\/elsewhere:9000"/);
});

test("a plugin env value with quotes/backslashes is escaped into valid TOML", () => {
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    appPrefix: "qm",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
  };
  const plugin: ResolvedPlugin = { name: "quoter", kind: "source", env: { JSON_CFG: '{"x":"y"}\\end' } };
  const toml = derivedPluginTomlFor(config, plugin);
  assert.match(toml, /JSON_CFG = "\{\\"x\\":\\"y\\"\}\\\\end"/, "quotes and backslash are escaped");
});

test("--only rejects a name that is neither a service nor a plugin (before any Fly call)", async () => {
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    appPrefix: "qm",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [{ name: "linear", image: "ghcr.io/x:1" }],
    skills: [],
    env: {},
    imageOverrides: {},
  };
  const emptyDir = mkdtempSync(join(tmpdir(), "qm-fly-only-"));
  await assert.rejects(
    () => flyUp(config, emptyDir, { dryRun: true, only: ["nope"] }),
    /--only "nope" is not a service or plugin/,
  );
});

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { flyPinSandbox, flyRollback, flySecretsPush } from "../src/backends/fly.ts";

function fakeFly(dir: string, script: string): { log: string; restore: () => void } {
  const bin = join(dir, "fly-fake");
  const log = join(dir, "fly.log");
  writeFileSync(log, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst a = process.argv.slice(2).join(" ");\nfs.appendFileSync(${JSON.stringify(log)}, a + "\\n");\n${script}\n`,
  );
  chmodSync(bin, 0o755);
  const prior = process.env.FLY_BIN;
  process.env.FLY_BIN = bin;
  return {
    log,
    restore: () => {
      if (prior === undefined) delete process.env.FLY_BIN;
      else process.env.FLY_BIN = prior;
    },
  };
}

function generatedEnv(toml: string): Record<string, string> {
  const env: Record<string, string> = {};
  let inEnv = false;
  for (const line of toml.split("\n")) {
    const section = line.match(/^\s*\[(.+)\]\s*$/);
    if (section) {
      inEnv = section[1] === "env";
      continue;
    }
    const match = inEnv ? line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/) : null;
    if (match?.[1] && match[2]) env[match[1]] = JSON.parse(match[2]) as string;
  }
  return env;
}

test("the Fly S3 probe is valid CommonJS that reports async failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-s3-probe-syntax-"));
  try {
    const command = flyS3ProbeCommand();
    const encoded = command.match(/Buffer\.from\('([^']+)'/)?.[1];
    assert.ok(encoded, "probe command carries encoded source");
    const source = Buffer.from(encoded, "base64").toString("utf8");
    assert.doesNotMatch(source, /^\s*import\s/m, "eval never receives a static ESM import");
    assert.match(source, /\(async \(\) => \{/);
    assert.match(source, /\.catch\(\(error\) => \{/);
    const path = join(dir, "probe.cjs");
    writeFileSync(path, source);
    const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push stages a dual-role secret under BOTH names on the core app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-push-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core", "slack"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "pi" } },
    imageOverrides: {},
    sandbox: { app: "acme-sb", secretEnv: ["ANTHROPIC_API_KEY", "COMPANY_TOKEN"] },
  };
  mkdirSync(join(dir, "plugins", "srcplug"), { recursive: true });
  writeFileSync(join(dir, "plugins", "srcplug", "Dockerfile"), "FROM scratch\n");
  writeFileSync(
    join(dir, ".env"),
    [
      "ANTHROPIC_API_KEY=k",
      "CAPABILITY_SECRET=cap",
      "COMPANY_TOKEN=t",
      `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
      `CORE_SIGNING_SECRET=${"core-signing".repeat(3)}`,
      "PORTAL_IDENTITY_SECRET=identity",
      `SKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}`,
      "FLY_SANDBOX_API_TOKEN=f",
      "PUBLIC_API_URL=https://core.example.test",
      "SLACK_BOT_TOKEN=xoxb",
      "SLACK_APP_TOKEN=xapp",
    ].join("\n"),
  );
  const fake = fakeFly(
    dir,
    `const v = fs.readFileSync(0, "utf8"); fs.appendFileSync(${JSON.stringify(join(dir, "fly.log"))}, "value:" + v + "\\n");`,
  );
  const priorAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "proc-wins";
  const log = console.log;
  console.log = (): void => {};
  try {
    await flySecretsPush(config, dir);
    const calls = readFileSync(fake.log, "utf8");
    assert.ok(
      calls.includes("secrets set --stage -a acme-core ANTHROPIC_API_KEY=-"),
      "plain name for the core process",
    );
    assert.ok(
      calls.includes("secrets set --stage -a acme-core FLY_RESIDENT_ENV_ANTHROPIC_API_KEY=-"),
      "renamed variant forwarded into sandboxes",
    );
    assert.ok(calls.includes("secrets set --stage -a acme-core FLY_RESIDENT_ENV_COMPANY_TOKEN=-"));
    assert.ok(!calls.includes("-a acme-core COMPANY_TOKEN=-"), "a sandbox-only secret is not staged plain");
    assert.ok(
      calls.includes("secrets set --stage -a acme-core SLACK_BOT_TOKEN=-"),
      "virtual-service secrets stage plain on core",
    );
    assert.ok(
      calls.includes("secrets set --stage -a acme-srcplug CORE_SIGNING_SECRET=-"),
      "discovered source plugins get the signing secret",
    );
    assert.ok(calls.includes("apps create acme-core --org personal"), "the service app exists before secret staging");
    assert.ok(calls.includes("apps create acme-srcplug --org personal"), "source plugin apps are created too");
    assert.ok(
      !calls.includes("apps create acme-sb --org personal"),
      "secret delivery never adopts or creates the separately managed sandbox registry app",
    );
    assert.ok(!calls.includes("-a acme-srcplug SLACK_BOT_TOKEN"), "other secrets do not fan out to plugins");
    assert.ok(calls.includes("value:k\n"), "the deployment .env wins over ambient process credentials");
    assert.ok(!calls.includes("value:proc-wins"), "ambient credentials do not replace deployment-scoped values");
  } finally {
    console.log = log;
    if (priorAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorAnthropic;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push warns that staged secrets are not live when machines are running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-push-staged-warn-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: {},
    sandbox: { app: "acme-sb" },
  };
  writeFileSync(
    join(dir, ".env"),
    [
      "CAPABILITY_SECRET=capability-secret-that-is-long-enough",
      `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
      `CORE_SIGNING_SECRET=${"core-signing".repeat(3)}`,
      "PORTAL_IDENTITY_SECRET=portal-identity-secret-that-is-long-enough",
      `SKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}`,
      "FLY_SANDBOX_API_TOKEN=fly",
    ].join("\n"),
  );
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("status -a acme-core")) console.log(JSON.stringify({ Machines: [{ id: "m1", state: "started" }] }));
else if (a.startsWith("secrets set ")) fs.readFileSync(0, "utf8");
`,
  );
  const log = console.log;
  const warnLog = console.warn;
  const warnings: string[] = [];
  console.log = (): void => {};
  console.warn = (msg: string): void => {
    warnings.push(msg);
  };
  try {
    await flySecretsPush(config, dir);
    assert.ok(
      warnings.some((line) => line.includes("staged secrets are NOT live yet on acme-core")),
      warnings.join("\n"),
    );
    assert.ok(warnings.some((line) => line.includes("run `qm up`")));
  } finally {
    console.log = log;
    console.warn = warnLog;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push stays quiet about staging when no machines are running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-push-staged-quiet-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: {},
    sandbox: { app: "acme-sb" },
  };
  writeFileSync(
    join(dir, ".env"),
    [
      "CAPABILITY_SECRET=capability-secret-that-is-long-enough",
      `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
      `CORE_SIGNING_SECRET=${"core-signing".repeat(3)}`,
      "PORTAL_IDENTITY_SECRET=portal-identity-secret-that-is-long-enough",
      `SKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}`,
      "FLY_SANDBOX_API_TOKEN=fly",
    ].join("\n"),
  );
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("status -a")) console.log(JSON.stringify({ Machines: [] }));
else if (a.startsWith("secrets set ")) fs.readFileSync(0, "utf8");
`,
  );
  const log = console.log;
  const warnLog = console.warn;
  const warnings: string[] = [];
  console.log = (): void => {};
  console.warn = (msg: string): void => {
    warnings.push(msg);
  };
  try {
    await flySecretsPush(config, dir);
    assert.ok(!warnings.some((line) => line.includes("staged secrets are NOT live")), warnings.join("\n"));
  } finally {
    console.log = log;
    console.warn = warnLog;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push removes the disabled Fly app publisher token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-push-publisher-off-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: {},
    sandbox: { app: "acme-sb" },
  };
  writeFileSync(
    join(dir, ".env"),
    [
      "CAPABILITY_SECRET=capability-secret-that-is-long-enough",
      `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
      `CORE_SIGNING_SECRET=${"core-signing".repeat(3)}`,
      "PORTAL_IDENTITY_SECRET=portal-identity-secret-that-is-long-enough",
      `SKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}`,
      "FLY_SANDBOX_API_TOKEN=fly",
    ].join("\n"),
  );
  const fake = fakeFly(
    dir,
    `
if (a === "secrets list -a acme-core") console.log("FLY_DEPLOY_API_TOKEN digest");
else if (a.startsWith("secrets set ")) fs.readFileSync(0, "utf8");
`,
  );
  const log = console.log;
  console.log = (): void => {};
  try {
    await flySecretsPush(config, dir);
    assert.match(readFileSync(fake.log, "utf8"), /secrets unset --stage -a acme-core FLY_DEPLOY_API_TOKEN/);
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push falls back to an ambient secret when the scaffold entry is blank", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-push-blank-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: {},
  };
  writeFileSync(
    join(dir, ".env"),
    [
      "CAPABILITY_SECRET=cap",
      `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
      "CORE_SIGNING_SECRET=",
      "PORTAL_IDENTITY_SECRET=identity",
      `SKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}`,
      "FLY_SANDBOX_API_TOKEN=fly",
    ].join("\n"),
  );
  const fake = fakeFly(
    dir,
    `const v = fs.readFileSync(0, "utf8"); fs.appendFileSync(${JSON.stringify(join(dir, "fly.log"))}, "value:" + v + "\\n");`,
  );
  const prior = process.env.CORE_SIGNING_SECRET;
  process.env.CORE_SIGNING_SECRET = "ambient-signing-secret-that-is-long-enough";
  const log = console.log;
  console.log = (): void => {};
  try {
    await flySecretsPush(config, dir);
    assert.match(readFileSync(fake.log, "utf8"), /value:ambient-signing-secret-that-is-long-enough/);
  } finally {
    console.log = log;
    if (prior === undefined) delete process.env.CORE_SIGNING_SECRET;
    else process.env.CORE_SIGNING_SECRET = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live check requires deployed machines and a healthy public endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core", "web-ui", "portal"],
    plugins: [],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const liveEnvs = Object.fromEntries(
    ["core", "web-ui", "portal"].map((service) => [
      service,
      generatedEnv(derivedTomlFor(config, service as "core" | "web-ui" | "portal", repoRoot)),
    ]),
  );
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify(["core", "web-ui", "portal"].map((service) => ({ Name: "acme-" + service }))));
else if (a.startsWith("status")) {
  const app = process.argv[process.argv.indexOf("-a") + 1];
  const service = app.slice("acme-".length);
  console.log(JSON.stringify({ Machines: [{ id: "machine-" + service, state: "started", region: "sjc", config: { image: "registry.fly.io/app@sha256:abc", env: ${JSON.stringify(liveEnvs)}[service] } }] }));
}
else if (a.startsWith("checks list")) console.log(JSON.stringify({ machine: [{ status: "passing" }] }));
else console.log("ok");`,
  );
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]): void => void lines.push(args.join(" "));
  try {
    await flyCheckLive(config, dir, {
      fetchImpl: async (url) => {
        assert.equal(url, "https://qm.example.test/healthz");
        return new Response('{"ok":true}', { status: 200 });
      },
      report: false,
    });
    assert.deepEqual(lines, [], "JSON callers can suppress all human-readable live-check output");
    const calls = readFileSync(fake.log, "utf8");
    for (const app of ["acme-core", "acme-web-ui", "acme-portal"]) {
      assert.ok(calls.includes(`status -a ${app} --json`));
    }
    assert.match(
      calls,
      /ssh console -a acme-core --machine machine-core .* --quiet/,
      "live readiness proves S3 from the running core",
    );
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live readiness rejects the wrong organization identity, region, and rendered env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-identity-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }]));
else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{
  id: "machine-core", state: "started", region: "ord",
  config: { image: "registry.fly.io/app@sha256:abc", env: { QM_DEPLOYMENT_ID: "qm-v2:other-org:acme:acme" } }
}] }));
else if (a.startsWith("checks list")) console.log(JSON.stringify({ machine: [{ status: "passing" }] }));
else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok") }),
      (error: unknown) => {
        assert.match((error as Error).message, /lack deployment identity qm-v2:personal:acme:acme/);
        assert.equal((error as { clause?: string }).clause, "fly.live-readiness");
        return true;
      },
    );
    assert.doesNotMatch(
      readFileSync(fake.log, "utf8"),
      /ssh console/,
      "an unowned core never receives the storage probe",
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live readiness rejects the wrong region after deployment identity matches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-region-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const env = generatedEnv(derivedTomlFor(config, "core", repoRoot));
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }]));
else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{
  id: "machine-core", state: "started", region: "ord",
  config: { image: "registry.fly.io/app@sha256:abc", env: ${JSON.stringify(env)} }
}] }));
else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok") }),
      /machine region is ord instead of sjc/,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live readiness rejects rendered environment drift after identity and region match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-env-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const env = { ...generatedEnv(derivedTomlFor(config, "core", repoRoot)), S3_BUCKET: "wrong-bucket" };
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }]));
else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{
  id: "machine-core", state: "started", region: "sjc",
  config: { image: "registry.fly.io/app@sha256:abc", env: ${JSON.stringify(env)} }
}] }));
else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok") }),
      /rendered config drift \(machine 1 env S3_BUCKET\)/,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live readiness requires the generated TCP check for plugins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-plugin-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [{ name: "linear", image: "ghcr.io/example/linear:1" }],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const plugin: ResolvedPlugin = { name: "linear", kind: "image", image: "ghcr.io/example/linear:1", env: {} };
  const liveEnvs = {
    core: generatedEnv(derivedTomlFor(config, "core", repoRoot)),
    linear: generatedEnv(derivedPluginTomlFor(config, plugin)),
  };
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }, { Name: "acme-linear" }]));
else if (a.startsWith("status")) {
  const app = process.argv[process.argv.indexOf("-a") + 1];
  const service = app.slice("acme-".length);
  console.log(JSON.stringify({ Machines: [{ id: "machine-" + service, state: "started", region: "sjc", config: { image: "registry.fly.io/app@sha256:abc", env: ${JSON.stringify(liveEnvs)}[service] } }] }));
}
else if (a.startsWith("checks list")) console.log(JSON.stringify({ machine: [{ status: "passing" }] }));
else console.log("ok");`,
  );
  try {
    await assert.doesNotReject(() =>
      flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok"), report: false }),
    );
    assert.match(
      readFileSync(fake.log, "utf8"),
      /checks list -a acme-linear --json/,
      "plugin readiness is verified through its generated TCP check",
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live readiness rejects a plugin whose TCP check is not passing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-plugin-failed-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [{ name: "linear", image: "ghcr.io/example/linear:1" }],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const plugin: ResolvedPlugin = { name: "linear", kind: "image", image: "ghcr.io/example/linear:1", env: {} };
  const liveEnvs = {
    core: generatedEnv(derivedTomlFor(config, "core", repoRoot)),
    linear: generatedEnv(derivedPluginTomlFor(config, plugin)),
  };
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }, { Name: "acme-linear" }]));
else if (a.startsWith("status")) {
  const app = process.argv[process.argv.indexOf("-a") + 1];
  const service = app.slice("acme-".length);
  console.log(JSON.stringify({ Machines: [{ id: "machine-" + service, state: "started", region: "sjc", config: { image: "registry.fly.io/app@sha256:abc", env: ${JSON.stringify(liveEnvs)}[service] } }] }));
}
else if (a.startsWith("checks list") && a.includes("acme-linear")) console.log(JSON.stringify({ machine: [{ status: "failing" }] }));
else if (a.startsWith("checks list")) console.log(JSON.stringify({ machine: [{ status: "passing" }] }));
else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok") }),
      /acme-linear: 1 health check not passing/,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live readiness fails when core cannot round-trip durable object storage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-storage-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const env = generatedEnv(derivedTomlFor(config, "core", repoRoot));
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }]));
else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{ id: "machine-core", state: "started", region: "sjc", config: { image: "registry.fly.io/app@sha256:abc", env: ${JSON.stringify(env)} } }] }));
else if (a.startsWith("checks list")) console.log(JSON.stringify({ machine: [{ status: "passing" }] }));
else if (a.startsWith("ssh console")) { console.error("AccessDenied"); process.exit(1); }
else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok") }),
      /S3 put\/get\/delete probe failed.*AccessDenied/s,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live readiness rejects a healthy machine on the wrong configured image digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-image-"));
  const configured = `registry.fly.io/acme-core@sha256:${"a".repeat(64)}`;
  const running = `registry.fly.io/acme-core@sha256:${"b".repeat(64)}`;
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: { core: configured },
  };
  const env = generatedEnv(derivedTomlFor(config, "core", repoRoot));
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }]));
else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{ id: "machine-core", state: "started", region: "sjc", config: { image: ${JSON.stringify(running)}, env: ${JSON.stringify(env)} } }] }));
else if (a.startsWith("checks list")) console.log(JSON.stringify({ machine: [{ status: "passing" }] }));
else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok") }),
      /do not run configured image digest/,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live readiness resolves deployment tags to their immutable image digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-image-tag-"));
  const digest = `sha256:${"a".repeat(64)}`;
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: { core: `registry.fly.io/acme-core@${digest}` },
  };
  const env = generatedEnv(derivedTomlFor(config, "core", repoRoot));
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }]));
else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{ id: "machine-core", state: "started", region: "sjc", config: { image: "registry.fly.io/acme-core:deployment-123", env: ${JSON.stringify(env)} } }] }));
else if (a.startsWith("image show")) console.log(JSON.stringify([{ MachineID: "machine-core", Registry: "registry.fly.io", Repository: "acme-core", Tag: "deployment-123", Digest: ${JSON.stringify(digest)} }]));
else if (a.startsWith("checks list")) console.log(JSON.stringify({ machine: [{ status: "passing" }] }));
else console.log("ok");`,
  );
  try {
    await assert.doesNotReject(() =>
      flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok"), report: false }),
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live check rejects stopped workloads even when the public endpoint responds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const fake = fakeFly(
    dir,
    `if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }])); else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{ id: "machine-core", state: "stopped", region: "sjc", config: { image: "registry.fly.io/app@sha256:abc" } }] })); else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok") }),
      /machine state is stopped instead of started/,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly live check rejects a configured workload with no deployed machine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-live-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://qm.example.test",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
    imageOverrides: {},
  };
  const fake = fakeFly(
    dir,
    `if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }])); else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [] })); else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flyCheckLive(config, dir, { fetchImpl: async () => new Response("ok") }),
      /acme-core: no deployed machine/,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push rejects weak signing keys before staging anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-weak-secret-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: {},
  };
  writeFileSync(
    join(dir, ".env"),
    `CAPABILITY_SECRET=cap\nCONNECTOR_SECRET_KEY=${"connector".repeat(4)}\nPORTAL_IDENTITY_SECRET=identity\nCORE_SIGNING_SECRET=short\nSKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}\nFLY_SANDBOX_API_TOKEN=f\n`,
  );
  const fake = fakeFly(dir, "");
  try {
    await assert.rejects(() => flySecretsPush(config, dir), /CORE_SIGNING_SECRET.*too short/);
    assert.equal(readFileSync(fake.log, "utf8"), "");
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push refuses an unmarked pre-existing app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-owner-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: {},
    sandbox: { app: "acme-sb" },
  };
  writeFileSync(
    join(dir, ".env"),
    [
      `CAPABILITY_SECRET=${"capability".repeat(4)}`,
      `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
      `CORE_SIGNING_SECRET=${"core-signing".repeat(3)}`,
      `FLY_SANDBOX_API_TOKEN=FlyV1-scoped`,
      `PORTAL_IDENTITY_SECRET=${"identity".repeat(4)}`,
      `SKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}`,
    ].join("\n"),
  );
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps create")) console.log("already been taken");
else if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "acme-core" }]));
else if (a.startsWith("secrets list")) console.log("CORE_SIGNING_SECRET");
else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flySecretsPush(config, dir),
      /already exists but is not marked as owned by this deployment/,
    );
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /CAPABILITY_SECRET=-/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push refuses a same-named app outside the configured Fly organization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-wrong-org-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "operator-org",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: {},
    sandbox: { app: "acme-sb" },
  };
  writeFileSync(
    join(dir, ".env"),
    [
      `CAPABILITY_SECRET=${"capability".repeat(4)}`,
      `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
      `CORE_SIGNING_SECRET=${"core-signing".repeat(3)}`,
      `FLY_SANDBOX_API_TOKEN=FlyV1-scoped`,
      `PORTAL_IDENTITY_SECRET=${"identity".repeat(4)}`,
      `SKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}`,
    ].join("\n"),
  );
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps create")) console.log("already been taken");
else if (a.startsWith("apps list")) console.log("[]");
else console.log("ok");`,
  );
  try {
    await assert.rejects(
      () => flySecretsPush(config, dir),
      /app acme-core exists outside configured Fly organization operator-org/,
    );
    assert.doesNotMatch(
      readFileSync(fake.log, "utf8"),
      /secrets set --stage/,
      "no credential is delivered across the organization boundary",
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly rollback joins a bare digest with @ and records the pin in the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-rollback-"));
  const appPrefix = "qmrbtest";
  const digest = `sha256:${"d".repeat(64)}`;
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    appPrefix,
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    sandbox: { app: `${appPrefix}-sb` },
  };
  const configPath = join(dir, "qm.config.jsonc");
  writeFileSync(
    configPath,
    `${JSON.stringify({ contract: 1, orgId: "acme", sandbox: { app: `${appPrefix}-sb` } }, null, 2)}\n`,
  );
  const marker = `QM_OWNER_${createHash("sha256").update(`qm-v2:personal:acme:${appPrefix}`).digest("hex").slice(0, 16).toUpperCase()}`;
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "${appPrefix}-core" }]));
else if (a.startsWith("secrets list")) console.log("NAME  DIGEST  CREATED AT\\n${marker}  abc123  1m ago");
else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{ id: "machine-core", config: { image: "registry.fly.io/${appPrefix}-core:cur" } }] }));
else if (a.startsWith("image show")) console.log(JSON.stringify([{ MachineID: "machine-core", Registry: "registry.fly.io", Repository: "${appPrefix}-core", Tag: "cur", Digest: "sha256:${"a".repeat(64)}" }]));
else console.log("");`,
  );
  const resolved = `sha256:${"e".repeat(64)}`;
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!/usr/bin/env bash\necho "Digest: ${resolved}"\n`);
  chmodSync(docker, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath ?? ""}`;
  const generated = join(dir, ".generated", "fly", appPrefix);
  const log = console.log;
  console.log = (): void => {};
  try {
    flyRollback(config, configPath, digest);
    const toml = readFileSync(join(generated, "core.fly.toml"), "utf8");
    assert.ok(
      toml.includes(`FLY_BASE_IMAGE = "registry.fly.io/${appPrefix}-sb@${digest}"`),
      "digest joins the repository with @, not :",
    );
    const pinned = JSON.parse(readFileSync(configPath, "utf8")) as { sandbox?: { image?: string } };
    assert.equal(
      pinned.sandbox?.image,
      `registry.fly.io/${appPrefix}-sb@${digest}`,
      "the pin is durable in the config file",
    );

    flyRollback(config, configPath, "v12");
    const tagged = readFileSync(join(generated, "core.fly.toml"), "utf8");
    assert.ok(
      tagged.includes(`FLY_BASE_IMAGE = "registry.fly.io/${appPrefix}-sb:v12@${resolved}"`),
      "a tag is resolved to its immutable digest",
    );
    const repinned = JSON.parse(readFileSync(configPath, "utf8")) as { sandbox?: { image?: string } };
    assert.equal(
      repinned.sandbox?.image,
      `registry.fly.io/${appPrefix}-sb:v12@${resolved}`,
      "a tag pin would never compare stale; only a digest may land in the config",
    );
  } finally {
    console.log = log;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
    if (existsSync(generated)) rmSync(generated, { recursive: true, force: true });
  }
});

test("fly rollback with no sandbox config fails cleanly instead of deriving a garbage ref", () => {
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
  };
  assert.throws(
    () => flyRollback(config, "/nonexistent/config.json", `sha256:${"e".repeat(64)}`),
    /cannot derive an image repository/,
  );
});

test("fly rollback validates an image pin before changing the committed config", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-rollback-invalid-"));
  const configPath = join(dir, "qm.config.jsonc");
  const raw = JSON.stringify({ contract: 1, orgId: "acme", sandbox: { app: "acme-sb" } }, null, 2) + "\n";
  writeFileSync(configPath, raw);
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    sandbox: { app: "acme-sb" },
  };
  try {
    assert.throws(
      () => flyRollback(config, configPath, "sha256:not-a-digest"),
      /must resolve to an image tag or sha256 digest/,
    );
    assert.equal(readFileSync(configPath, "utf8"), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly rollback refuses to change the committed config when the image cannot be resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-rollback-missing-"));
  const configPath = join(dir, "qm.config.jsonc");
  const raw = JSON.stringify({ contract: 1, orgId: "acme", sandbox: { app: "acme-sb" } }, null, 2) + "\n";
  writeFileSync(configPath, raw);
  const docker = join(dir, "docker");
  writeFileSync(docker, "#!/usr/bin/env bash\necho missing >&2\nexit 1\n");
  chmodSync(docker, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath ?? ""}`;
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    sandbox: { app: "acme-sb" },
  };
  try {
    assert.throws(() => flyRollback(config, configPath, "v12"), /could not resolve an immutable digest/);
    assert.equal(readFileSync(configPath, "utf8"), raw);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly sandbox pin re-derives the core [env] and unsets any stale FLY_BASE_IMAGE secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-pin-"));
  const appPrefix = "qmpintest";
  const pin = `registry.fly.io/${appPrefix}-sb@sha256:${"c".repeat(64)}`;
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    appPrefix,
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    sandbox: { app: `${appPrefix}-sb`, image: pin },
  };
  const marker = `QM_OWNER_${createHash("sha256").update(`qm-v2:personal:acme:${appPrefix}`).digest("hex").slice(0, 16).toUpperCase()}`;
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "${appPrefix}-core" }]));
else if (a.startsWith("status")) console.log(JSON.stringify({ Machines: [{ id: "machine-core", config: { image: "registry.fly.io/${appPrefix}-core:cur" } }] }));
else if (a.startsWith("image show")) console.log(JSON.stringify([{ MachineID: "machine-core", Registry: "registry.fly.io", Repository: "${appPrefix}-core", Tag: "cur", Digest: "sha256:${"a".repeat(64)}" }]));
else if (a.startsWith("secrets list")) console.log("NAME            DIGEST  CREATED AT\\n${marker}  abc123  1m ago\\nFLY_BASE_IMAGE  abc123  1m ago");
else console.log("");`,
  );
  const generated = join(dir, ".generated", "fly", appPrefix);
  const log = console.log;
  console.log = (): void => {};
  try {
    flyPinSandbox(config, pin, dir);
    const calls = readFileSync(fake.log, "utf8");
    assert.ok(
      calls.includes(`secrets unset --stage -a ${appPrefix}-core FLY_BASE_IMAGE`),
      "the stale shadowing secret is removed",
    );
    assert.ok(!/secrets set/.test(calls), "the pin is never staged as a Fly secret");
    const deploy = calls.split("\n").find((line) => line.startsWith("deploy"));
    assert.ok(
      deploy?.includes(`--image registry.fly.io/${appPrefix}-core@sha256:${"a".repeat(64)}`),
      `rolls the current immutable image: ${deploy}`,
    );
    const toml = readFileSync(join(generated, "core.fly.toml"), "utf8");
    assert.ok(toml.includes(`FLY_BASE_IMAGE = "${pin}"`), "the pin lands in the derived [env], owned by the config");
    assert.ok(deploy?.includes(join(generated, "core.fly.toml")), "deploy uses the derived config");
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
    if (existsSync(generated)) rmSync(generated, { recursive: true, force: true });
  }
});

test("fly sandbox pin refuses to mutate an unmarked app with the configured name", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-pin-unowned-"));
  const appPrefix = "qmpinunowned";
  const pin = `registry.fly.io/${appPrefix}-sb@sha256:${"d".repeat(64)}`;
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    appPrefix,
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    sandbox: { app: `${appPrefix}-sb`, image: pin },
  };
  const fake = fakeFly(
    dir,
    `
if (a.startsWith("apps list")) console.log(JSON.stringify([{ Name: "${appPrefix}-core" }]));
else if (a.startsWith("secrets list")) console.log("NAME  DIGEST  CREATED AT");
else console.log("");`,
  );
  const log = console.log;
  console.log = (): void => {};
  try {
    assert.throws(
      () => flyPinSandbox(config, pin),
      /not marked as owned by deployment qm-v2:personal:acme:qmpinunowned/,
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /secrets unset|deploy/, "an unowned app is never mutated");
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fly secrets push stages a secretEnv alias under its declared env name on its service's app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-alias-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core", "portal"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock" } },
    imageOverrides: {},
    secretEnv: { core: { DEPLOY_APPS_SESSION_SECRET: "PORTAL_SESSION_SECRET", EXTRA_API_KEY: "EXTRA_API_KEY" } },
  };
  writeFileSync(
    join(dir, ".env"),
    [
      "CAPABILITY_SECRET=cap",
      `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
      `CORE_SIGNING_SECRET=${"core-signing".repeat(3)}`,
      "FLY_SANDBOX_API_TOKEN=fly",
      "PORTAL_IDENTITY_SECRET=identity",
      `SKILL_SIGNING_SECRET=${"skill-signing".repeat(3)}`,
      "ADMIN_GRANTS=admin@example.com:org_admin",
      "OIDC_CLIENT_ID=client",
      "OIDC_CLIENT_SECRET=oidc",
      "PORTAL_EXPECTED_TEAM_ID=T1",
      `PORTAL_SESSION_SECRET=${"portal-session".repeat(3)}`,
      "EXTRA_API_KEY=extra-value",
    ].join("\n"),
  );
  const fake = fakeFly(
    dir,
    `const v = fs.readFileSync(0, "utf8"); fs.appendFileSync(${JSON.stringify(join(dir, "fly.log"))}, "value:" + v + "\\n");`,
  );
  const log = console.log;
  console.log = (): void => {};
  try {
    await flySecretsPush(config, dir);
    const calls = readFileSync(fake.log, "utf8");
    assert.ok(
      calls.includes("secrets set --stage -a acme-portal PORTAL_SESSION_SECRET=-"),
      "the portal keeps its plain delivery",
    );
    assert.ok(
      calls.includes("secrets set --stage -a acme-core DEPLOY_APPS_SESSION_SECRET=-"),
      "the alias delivers the stored value under its declared env name on core",
    );
    assert.ok(!calls.includes("-a acme-core PORTAL_SESSION_SECRET"), "the alias adds no plain-name delivery on core");
    assert.ok(
      calls.includes("secrets set --stage -a acme-core EXTRA_API_KEY=-"),
      "config secretEnv extras stage on their service",
    );
    assert.ok(
      calls.includes(`value:${"portal-session".repeat(3)}`),
      "the aliased delivery pushes the store secret's value",
    );
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
