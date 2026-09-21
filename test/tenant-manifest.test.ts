import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostConfig } from "../src/tenancy/manifest.ts";
import { SpritesClient } from "@fly/sprites";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";

const providerPrefixes = [
  "SPRITES_NAME_PREFIX",
  "SMOLMACHINES_NAME_PREFIX",
  "E2B_NAME_PREFIX",
  "MODAL_NAME_PREFIX",
  "PORTER_SANDBOX_NAME_PREFIX",
  "AGENT37_NAME_PREFIX",
  "SUPERSERVE_NAME_PREFIX",
  "FLY_DEPLOY_APP_PREFIX",
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "qm-tenants-"));
  const env: NodeJS.ProcessEnv = {
    QM_TENANTS_FILE: join(dir, "tenants.json"),
    DATA_DIR: join(dir, "data"),
    PORT: "18080",
  };
  const entries = ["alpha", "beta"].map((id) => ({ id, hosts: [`${id}.example.test`], envFile: `${id}.env` }));
  const values = (id: string) => ({
    DATABASE_URL: `postgres://qm:password@localhost/${id}`,
    CORE_SIGNING_SECRET: `${id}-source-${"s".repeat(32)}`,
    CAPABILITY_SECRET: `${id}-capability-${"c".repeat(32)}`,
    PORTAL_IDENTITY_SECRET: `${id}-identity-${"i".repeat(32)}`,
    CONNECTOR_SECRET_KEY: `${id}-connector-${"e".repeat(32)}`,
    HARNESS: "mock",
    SANDBOX_BACKEND: "local",
  });
  const write = (id: string, overrides: Record<string, string> = {}) =>
    writeFileSync(
      join(dir, `${id}.env`),
      Object.entries({ ...values(id), ...overrides })
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
  for (const { id } of entries) write(id);
  writeFileSync(env.QM_TENANTS_FILE!, JSON.stringify({ tenants: entries }));
  return { dir, env, entries, write, values, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("pooled config scopes storage and does not inherit host credentials or another company's configuration", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("alpha", { ANTHROPIC_API_KEY: "only-alpha", WORKERS: "3" });
  const host = loadHostConfig({
    ...f.env,
    ANTHROPIC_API_KEY: "host-secret",
    SLACK_BOT_TOKEN: "host-bot",
    QM_WORKER_CONCURRENCY: "7",
  });
  assert.equal(host.concurrency, 7);
  assert.equal(host.port, 18080);
  const [alpha, beta] = host.tenants;
  assert.equal(alpha!.config.anthropicApiKey, "only-alpha");
  assert.equal(beta!.config.anthropicApiKey, undefined);
  assert.equal(beta!.context.env.SLACK_BOT_TOKEN, undefined);
  assert.equal(alpha!.config.workers, 3);
  assert.equal(beta!.config.workers, 2);
  assert.equal(alpha!.config.sessionStore, "postgres");
  assert.equal(beta!.config.runStore, "postgres");
  assert.notEqual(alpha!.config.dataDir, beta!.config.dataDir);
  assert.notEqual(alpha!.config.s3Prefix, beta!.config.s3Prefix);
  assert.notEqual(alpha!.config.awsSandbox.s3Prefix, beta!.config.awsSandbox.s3Prefix);
  assert.notEqual(alpha!.config.modalSandbox.namePrefix, beta!.config.modalSandbox.namePrefix);
});

test("different PostgreSQL users cannot disguise a shared tenant database", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("beta", { DATABASE_URL: "postgresql://different:secret@localhost:5432/alpha?sslmode=disable" });
  assert.throws(() => loadHostConfig(f.env), /separate databases/);
});

test("PostgreSQL query overrides and ambient connection defaults cannot defeat database isolation", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const url of [
    "postgres://qm:password@localhost:5433/alpha?port=5432",
    "postgres:///alpha",
    "postgres://localhost/alpha",
    "postgres://qm:password@localhost/beta?host=127.0.0.1",
  ]) {
    f.write("beta", { DATABASE_URL: url });
    assert.throws(() => loadHostConfig(f.env), /Tenant database URLs/);
  }
  f.write("beta", { DATABASE_POOL_URL: "postgres://qm:password@localhost/beta?port=5432" });
  assert.throws(() => loadHostConfig(f.env), /Tenant database URLs/);
});

test("tenant startup rejects shared secrets and overlapping local or S3 storage", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("beta", { CAPABILITY_SECRET: f.values("alpha").CAPABILITY_SECRET });
  assert.throws(() => loadHostConfig(f.env), /distinct/);
  f.write("beta", { DATA_DIR: join(f.dir, "data", "alpha", "nested") });
  assert.throws(() => loadHostConfig(f.env), /directories overlap/);
  f.write("alpha", { S3_BUCKET: "shared", S3_PREFIX: "common/" });
  f.write("beta", { S3_BUCKET: "shared", S3_PREFIX: "common/nested/" });
  assert.throws(() => loadHostConfig(f.env), /storage prefixes overlap/);
});

test("pooled ingress cannot fall back to an unsigned core or a conflicting tenant identity", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("alpha", { ALLOW_UNAUTHENTICATED_CORE: "1" });
  assert.throws(() => loadHostConfig(f.env), /authenticated ingress/);
  f.write("alpha", { ORG_ID: "beta" });
  assert.throws(() => loadHostConfig(f.env), /ORG_ID must match/);
});

test("dedicated deployment uses one tenant context without changing its resource names", () => {
  const host = loadHostConfig({
    ORG_ID: "existing-org",
    HARNESS: "mock",
    SANDBOX_BACKEND: "local",
    DATA_DIR: "/tmp/qm-existing",
  });
  assert.equal(host.pooled, false);
  assert.equal(host.tenants[0]!.context.id, "existing-org");
  assert.equal(host.tenants[0]!.context.pooled, false);
  assert.equal(host.tenants[0]!.config.dataDir, "/tmp/qm-existing");
  assert.equal(host.tenants[0]!.config.spritesSandbox.namePrefix, undefined);
});

test("tenant database isolation covers direct and transaction-pool targets in either order", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const pairs: Array<[Record<string, string>, Record<string, string>]> = [
    [
      {
        DATABASE_URL: "postgres://qm:password@direct.example/shared",
        DATABASE_POOL_URL: "postgres://qm:password@pooled.example/shared",
      },
      { DATABASE_URL: "postgresql://different:secret@POOLED.example.:5432/%73hared" },
    ],
    [
      { DATABASE_URL: "postgres://qm:password@direct.example/shared" },
      {
        DATABASE_URL: "postgres://qm:password@other.example/shared",
        DATABASE_POOL_URL: "postgresql://qm:password@DIRECT.example:5432/shared",
      },
    ],
    [
      {
        DATABASE_URL: "postgres://qm:password@first.example/company",
        DATABASE_POOL_URL: "postgres://qm:password@pooled.example/company",
      },
      {
        DATABASE_URL: "postgres://qm:password@second.example/company",
        DATABASE_POOL_URL: "postgresql://qm:password@POOLED.example:5432/company?sslmode=disable",
      },
    ],
  ];
  for (const [alpha, beta] of pairs) {
    f.write("alpha", alpha);
    f.write("beta", beta);
    assert.throws(() => loadHostConfig(f.env), /separate databases/);
  }
});

test("one tenant may use the same canonical database target for direct and pooled connections", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("alpha", { DATABASE_POOL_URL: "postgresql://qm:password@LOCALHOST:5432/alpha" });
  assert.equal(loadHostConfig(f.env).tenants.length, 2);
});

test("empty provider name prefixes cannot fall back to a shared provider namespace", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const key of providerPrefixes) {
    for (const value of ["", '"   "']) {
      f.write("alpha", { [key]: value });
      f.write("beta", { [key]: value });
      assert.throws(() => loadHostConfig(f.env), new RegExp(`${key} must not be empty`));
    }
  }
});

test("pooled provider prefixes reject URL aliases and non-slug characters", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const key of providerPrefixes) {
    for (const value of [
      "ignored/../qm-alpha",
      "ignored/%2e%2e/qm-alpha",
      "qm-alpha?ignored",
      '"qm-alpha#ignored"',
      "qm%2dalpha",
      "QM-alpha",
      "qm_alpha",
      "qm.alpha",
      '"qm alpha"',
      "-qm-alpha",
      "qm-alpha-",
    ]) {
      f.write("beta", { [key]: value });
      assert.throws(() => loadHostConfig(f.env), new RegExp(`${key} must be a lowercase slug`), `${key}=${value}`);
    }
    f.write("beta", { [key]: "valid-prefix-123" });
    assert.equal(loadHostConfig(f.env).tenants[1]!.context.env[key], "valid-prefix-123");
  }
});

test("pooled prefixes reject names that the actual Sprites SDK resolves to another tenant's resource", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init).url);
    return new Response(null, { status: 204 });
  });
  const client = new SpritesClient("fake-token", { baseURL: "https://sprites.example.test" });
  const actor = "personal:same@example.test";
  const alpha = sandboxScopeName("qm-alpha", actor);
  const aliased = sandboxScopeName("ignored/../qm-alpha", actor);
  assert.notEqual(alpha, aliased);
  await client.deleteSprite(alpha);
  await client.deleteSprite(aliased);
  assert.equal(requests[0], requests[1]);
  assert.equal(requests[0], `https://sprites.example.test/v1/sprites/${alpha}`);
  f.write("beta", { SPRITES_NAME_PREFIX: "ignored/../qm-alpha" });
  assert.throws(() => loadHostConfig(f.env), /SPRITES_NAME_PREFIX must be a lowercase slug/);
});

test("tenant ids keep generated provider prefixes within the same slug grammar", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.entries[0]!.id = "alpha-";
  writeFileSync(f.env.QM_TENANTS_FILE!, JSON.stringify({ tenants: f.entries }));
  assert.throws(() => loadHostConfig(f.env), /Tenant id must be a lowercase slug/);
});

test("pooled Fly prefixes respect the provider's existing length limit", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("beta", { FLY_DEPLOY_APP_PREFIX: "a".repeat(27) });
  assert.throws(() => loadHostConfig(f.env), /FLY_DEPLOY_APP_PREFIX must be no longer than 26 characters/);
  f.write("beta", { FLY_DEPLOY_APP_PREFIX: "a".repeat(26) });
  assert.equal(loadHostConfig(f.env).tenants[1]!.config.flyDeploy.appPrefix.length, 26);
});

test("provider namespace comparisons use the normalized effective prefix", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("alpha", { E2B_NAME_PREFIX: '" shared-company "' });
  f.write("beta", { E2B_NAME_PREFIX: "shared-company" });
  assert.throws(() => loadHostConfig(f.env), /E2B_NAME_PREFIX must be unique/);
});

test("worker admission rejects invalid local limits in both dedicated and pooled hosts", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  for (const value of ["0", "-1", "1.5", "1025", ""]) {
    f.write("alpha", { WORKERS: value });
    assert.throws(() => loadHostConfig(f.env), /WORKERS must be between 1 and 1024/);
    assert.throws(
      () => loadHostConfig({ HARNESS: "mock", SANDBOX_BACKEND: "local", WORKERS: value }),
      /WORKERS must be between 1 and 1024/,
    );
  }
  f.write("alpha", { WORKERS: "1" });
  assert.equal(loadHostConfig(f.env).tenants[0]!.config.workers, 1);
});

test("AWS Secrets Manager namespaces cannot overlap across tenants", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("alpha", { SECRETS_BACKEND: "aws", SECRETS_PREFIX: "company/" });
  for (const prefix of ["company/", "company/nested/"]) {
    f.write("beta", { SECRETS_BACKEND: "aws", SECRETS_PREFIX: prefix });
    assert.throws(() => loadHostConfig(f.env), /secret prefixes overlap/);
  }
  f.write("beta", { SECRETS_BACKEND: "aws", SECRETS_PREFIX: "another-company/" });
  assert.equal(loadHostConfig(f.env).tenants.length, 2);
});

test("AWS deployment storage validates the effective fallback sandbox bucket", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("alpha", { AWS_SANDBOX_S3_BUCKET: "shared-bucket", AWS_DEPLOY_DATA_PREFIX: "deployments/" });
  f.write("beta", { S3_BUCKET: "shared-bucket", S3_PREFIX: "deployments/nested/" });
  assert.throws(() => loadHostConfig(f.env), /storage prefixes overlap/);
  f.write("beta", { AWS_SANDBOX_S3_BUCKET: "shared-bucket" });
  assert.equal(loadHostConfig(f.env).tenants.length, 2);
});

test("Fly peer isolation compares cryptographic identities despite different display ids", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const peers = (name: string, bytes: number[]) =>
    JSON.stringify(
      bytes.map((byte, index) => ({
        id: `${name}-${index}`,
        config: `[Interface]\nPrivateKey = ${Buffer.alloc(32, byte).toString("base64")}\n`,
      })),
    );
  f.write("alpha", { FLY_DEPLOY_WIREGUARD_PEERS: peers("alpha", [1, 2]) });
  f.write("beta", { FLY_DEPLOY_WIREGUARD_PEERS: peers("beta", [1, 3]) });
  assert.throws(() => loadHostConfig(f.env), /WireGuard peer identities must be unique/);
  f.write("beta", { FLY_DEPLOY_WIREGUARD_PEERS: peers("beta", [3, 4]) });
  assert.equal(loadHostConfig(f.env).tenants.length, 2);
});

test("tenant app domains cannot shadow another app domain or an assigned tenant host", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.write("alpha", { DEPLOY_APPS_DOMAIN: "apps.example.test", AWS_DEPLOY_GATE_SECRET: "alpha-gate-" + "a".repeat(32) });
  for (const domain of ["APPS.EXAMPLE.TEST.", "nested.apps.example.test", "example.test"]) {
    f.write("beta", { DEPLOY_APPS_DOMAIN: domain, AWS_DEPLOY_GATE_SECRET: "beta-gate-" + "b".repeat(32) });
    assert.throws(() => loadHostConfig(f.env), /app domains overlap/);
  }
  f.write("beta");
  f.entries[1]!.hosts = ["beta.apps.example.test"];
  writeFileSync(f.env.QM_TENANTS_FILE!, JSON.stringify({ tenants: f.entries }));
  assert.throws(() => loadHostConfig(f.env), /host overlaps another tenant's app domain/);
});

test("Slack bot and app tokens cannot be shared between primary and additional tenant accounts", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const primary = (botToken: string, appToken: string) => ({ SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken });
  const additional = (botToken: string, appToken: string) => ({
    SLACK_ACCOUNTS: JSON.stringify([{ id: "other-account", botToken, appToken }]),
  });
  for (const a of [primary, additional]) {
    for (const b of [primary, additional]) {
      f.write("alpha", a("xoxb-alpha", "xapp-alpha"));
      f.write("beta", b("xoxb-alpha", "xapp-beta"));
      assert.throws(() => loadHostConfig(f.env), /SLACK_BOT_TOKEN must be unique across tenants/);
      f.write("beta", b("xoxb-beta", "xapp-alpha"));
      assert.throws(() => loadHostConfig(f.env), /SLACK_APP_TOKEN must be unique across tenants/);
      f.write("beta", b("xoxb-beta", "xapp-beta"));
      assert.equal(loadHostConfig(f.env).tenants.length, 2);
    }
  }
});

test("repeated Slack credentials remain within one tenant and errors never disclose the token", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const token = "xoxb-sensitive-tenant-token";
  const appToken = "xapp-sensitive-app-token";
  f.write("alpha", {
    SLACK_BOT_TOKEN: token,
    SLACK_APP_TOKEN: appToken,
    SLACK_ACCOUNTS: JSON.stringify([{ id: "same-tenant", botToken: token, appToken }]),
  });
  assert.equal(loadHostConfig(f.env).tenants.length, 2);
  f.write("beta", { SLACK_BOT_TOKEN: token, SLACK_APP_TOKEN: "xapp-beta" });
  assert.throws(
    () => loadHostConfig(f.env),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /SLACK_BOT_TOKEN must be unique across tenants/);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes(appToken), false);
      return true;
    },
  );
});

test("long tenant ids receive stable distinct Fly prefixes within the provider's length limit", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const ids = ["a", "b"].map((suffix) => `tenant-${"x".repeat(40)}${suffix}`);
  const entries = ids.map((id) => ({ id, hosts: [`${id}.example.test`], envFile: `${id}.env` }));
  for (const id of ids) {
    assert.equal(id.length, 48);
    f.write(id);
  }
  writeFileSync(f.env.QM_TENANTS_FILE!, JSON.stringify({ tenants: entries }));
  const prefixes = () => loadHostConfig(f.env).tenants.map((tenant) => tenant.config.flyDeploy.appPrefix);
  const first = prefixes();
  assert.deepEqual(first, prefixes());
  assert.notEqual(first[0], first[1]);
  for (const prefix of first) {
    assert.ok(prefix.length <= 26);
    assert.match(prefix, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  }
});
