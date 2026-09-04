import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QmConfig } from "../src/config.ts";
import { flyUp, mpgClusterId, mpgDirectUrl } from "../src/backends/fly.ts";

test("mpgClusterId matches a whole field regardless of column position or spacing", () => {
  const header = "ID              NAME          REGION  STATUS";
  assert.equal(
    mpgClusterId(`${header}\npg-abc123       acme-pg       sjc     ready`, "acme-pg"),
    "pg-abc123",
    "name padded with spaces on both sides",
  );
  assert.equal(
    mpgClusterId(`ID       REGION  NAME\npg-abc123  sjc   acme-pg`, "acme-pg"),
    "pg-abc123",
    "name in the last column (no trailing space)",
  );
  assert.equal(mpgClusterId(`${header}\npg-abc123 acme-pg-2 sjc ready`, "acme-pg"), undefined, "no substring matches");
  assert.equal(mpgClusterId("", "acme-pg"), undefined);
});

test("mpgDirectUrl selects the direct Managed Postgres endpoint without exposing credentials", () => {
  assert.equal(
    mpgDirectUrl(
      JSON.stringify({
        credentials: {
          pgbouncer_uri: "postgresql://fly-user:p%40ss@pgbouncer.pg-123.flympg.net/fly-db",
        },
      }),
      "pg-123",
    ),
    "postgresql://fly-user:p%40ss@direct.pg-123.flympg.net/fly-db",
  );
  assert.equal(
    mpgDirectUrl(
      JSON.stringify({
        credentials: {
          direct_uri: "postgresql://fly-user:p%40ss@direct.pg-123.flympg.net/fly-db",
        },
      }),
      "pg-123",
    ),
    "postgresql://fly-user:p%40ss@direct.pg-123.flympg.net/fly-db",
  );
  assert.throws(() => mpgDirectUrl("{", "pg-123"), /invalid JSON/);
  assert.throws(
    () =>
      mpgDirectUrl(
        JSON.stringify({ credentials: { pgbouncer_uri: "postgresql://direct.pg-456.flympg.net/db" } }),
        "pg-123",
      ),
    /unrecognized database hostname/,
  );
  assert.throws(
    () =>
      mpgDirectUrl(JSON.stringify({ credentials: { direct_uri: "https://direct.pg-123.flympg.net/db" } }), "pg-123"),
    /invalid database connection scheme/,
  );
});

test("fly up provisions private object storage before enforcing provider secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-storage-"));
  const fly = join(dir, "fly");
  const log = join(dir, "fly.log");
  const state = join(dir, "storage-created");
  const marker = "QM_OWNER_CD83933C6C53374D";
  writeFileSync(
    fly,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
if (a[0] === "apps" && a[1] === "create") console.log("already been taken");
else if (a[0] === "apps" && a[1] === "list") console.log(JSON.stringify([{ Name: "acme-core" }]));
else if (a[0] === "secrets" && a[1] === "list") {
  console.log(${JSON.stringify(
    [
      marker,
      "CAPABILITY_SECRET",
      "CONNECTOR_SECRET_KEY",
      "CORE_SIGNING_SECRET",
      "FLY_DEPLOY_API_TOKEN",
      "FLY_API_TOKEN",
      "PORTAL_IDENTITY_SECRET",
      "SECURITY_SCREEN_PROXY_TOKEN",
      "SKILL_SIGNING_SECRET",
    ]
      .map((name) => `${name} digest`)
      .join("\n"),
  )});
  if (fs.existsSync(${JSON.stringify(state)})) console.log("AWS_ACCESS_KEY_ID digest\\nAWS_ENDPOINT_URL_S3 digest\\nAWS_SECRET_ACCESS_KEY digest");
} else if (a[0] === "storage" && a[1] === "create") fs.writeFileSync(${JSON.stringify(state)}, "1");
else if (a[0] === "status") console.log(JSON.stringify({ Machines: [{ config: { image: "registry.fly.io/acme-core:deployment-123" } }] }));
else if (a[0] === "image" && a[1] === "show") console.log(JSON.stringify([{ Registry: "registry.fly.io", Repository: "acme-core", Tag: "deployment-123", Digest: "sha256:${"b".repeat(64)}" }]));
else if (a[0] === "mpg" && a[1] === "list") console.log("pg-1 acme-pg");
else if (a[0] === "mpg" && a[1] === "status") console.log(JSON.stringify({ credentials: { direct_uri: "postgresql://u:p@direct.pg-1.flympg.net/db" } }));
else console.log("ok");
`,
  );
  chmodSync(fly, 0o755);
  const prior = process.env.FLY_BIN;
  process.env.FLY_BIN = fly;
  const config: QmConfig = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.fly.dev",
    target: "fly",
    appPrefix: "acme",
    region: "sjc",
    flyOrg: "personal",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {
      core: { HARNESS: "mock", SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" },
    },
    imageOverrides: {},
    sandbox: { app: "acme-sandboxes", image: `registry.fly.io/acme-sandboxes@sha256:${"a".repeat(64)}` },
  };
  const configPath = join(dir, "custom-deployment.jsonc");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  try {
    await flyUp(config, dir, { buildFrom: true, configPath });
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /storage create --name acme-data --app acme-core --org personal --yes/);
    assert.match(calls, /secrets unset --stage -a acme-core SECURITY_SCREEN_PROXY_TOKEN/);
    assert.match(calls, /secrets unset --stage -a acme-core FLY_DEPLOY_API_TOKEN/);
    assert.ok(calls.indexOf("secrets unset") < calls.indexOf("deploy"));
    assert.ok(calls.indexOf("storage create") < calls.indexOf("deploy"));
    assert.equal(
      JSON.parse(readFileSync(configPath, "utf8")).imageOverrides.core,
      `registry.fly.io/acme-core@sha256:${"b".repeat(64)}`,
    );
    assert.equal(existsSync(join(dir, "qm.config.jsonc")), false);
  } finally {
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--only "slack" explains the virtual service runs in-process on the core', async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-up-"));
  const config: QmConfig = {
    contract: 1,
    orgId: "acme2",
    publicUrl: "https://acme2-portal.fly.dev",
    target: "fly",
    region: "sjc",
    flyOrg: "personal",
    services: ["core", "slack"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    sandbox: { app: "acme2-sandboxes" },
  };
  try {
    await assert.rejects(
      flyUp(config, dir, { only: ["slack"] }),
      /--only "slack": slack is a virtual service — it runs in-process on the core, so deploy it with --only core/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
