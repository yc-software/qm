import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { sealTenantSecret } from "../../plugins/chassis/src/tenant-settings.ts";
import { configurePgTenancy, createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { registerTenantSettings, tenant, tenantFor, tenantSettings, withTenant } from "../../src/tenant.ts";
import { applyTenancy } from "../../src/persistence/tenancy.ts";
import { listTenants, upsertTenant, type TenantRecord } from "../../src/tenants/registry.ts";

const ADMIN_URL = process.env.DATABASE_URL!;
const DB = `qm_tenant_settings_${process.pid}`;
const key = randomBytes(32);

let admin: pg.Client;
let pool: PgPool;

function databaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB}`;
  return url.toString();
}

before(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  const seed = new pg.Client({ connectionString: databaseUrl() });
  await seed.connect();
  await seed.query(`CREATE TABLE tenants(
     id UUID PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     org_id TEXT NOT NULL,
     hosts TEXT[] NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
     env JSONB NOT NULL DEFAULT '{}',
     secret_env BYTEA,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`);
  const trusted = JSON.stringify({ issuer: "https://auth.example.test", clientId: "closedai" });
  await seed.query(
    `INSERT INTO tenants(id, slug, org_id, hosts, env, secret_env) VALUES ($1, 'closedai', 'closedai', $2, $3, $4)`,
    [
      "5b0c7e44-1f1a-4c6e-9d2a-0000000000c1",
      ["closedai.example.test"],
      {
        core: {
          ORG_ID: "closedai",
          S3_BUCKET: "qm-closedai-bucket",
          SANDBOX_NAME_PREFIX: "qm-closedai",
          MODAL_APP_NAME: "qm-closedai",
          MODAL_ENVIRONMENT: "closedai",
          MODAL_SNAPSHOT_S3_BUCKET: "qm-closedai-snapshots",
          AWS_SANDBOX_S3_BUCKET: "qm-closedai-sandbox",
          SENTRY_DEPLOYMENT: "closedai",
          DEPLOY_APPS_DOMAIN: "apps.closedai.example.test",
          PUBLIC_WEB_URL: "https://closedai.example.test",
          POSTHOG_API_KEY: "phc_deployment",
        },
        portal: {
          PORTAL_TRUSTED_OIDC: trusted,
          PORTAL_TRUSTED_OIDC_LABEL: "Example SSO",
          PORTAL_TRUSTED_OIDC_ADMIN: "1",
          PORTAL_FAVICON_SVG: "<svg>portal</svg>",
        },
        "web-ui": { WEB_UI_FAVICON_SVG: "<svg>web</svg>", WEB_UI_WELCOME_COHORT: "cohort-a" },
      },
      sealTenantSecret(
        {
          core: {
            MODEL_GATEWAY_API_KEY: "closedai-gateway",
            QM_SLACK_SERVICE_TOKEN: "closedai-slack",
            ADMIN_GRANTS: "a@closedai.example:org_admin",
            CONNECTOR_SECRET_KEY: "closedai-connector",
            CORE_SIGNING_SECRET: "closedai-signing",
          },
          portal: { PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "closedai-trusted-secret", PORTAL_SESSION_SECRET: "s" },
        },
        key,
      ),
    ],
  );
  await seed.query(
    `INSERT INTO tenants(id, slug, org_id, hosts, env, secret_env) VALUES ($1, 'mt-fake-1', 'mt-fake-1', $2, $3, $4)`,
    [
      "5b0c7e44-1f1a-4c6e-9d2a-0000000000f1",
      ["mt-fake-1.example.test"],
      {
        core: { ORG_ID: "mt-fake-1", SANDBOX_NAME_PREFIX: "qm-mt-fake-1", MODAL_APP_NAME: "qm-mt-fake-1" },
        portal: { PORTAL_TRUSTED_OIDC: "", PORTAL_TRUSTED_OIDC_ADMIN: "" },
      },
      sealTenantSecret({ portal: { PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "", AUTH_TOKEN_SECRET: "t" } }, key),
    ],
  );
  await seed.query(`INSERT INTO tenants(id, slug, org_id) VALUES ($1, 'styleup', 'styleup')`, [
    "5b0c7e44-1f1a-4c6e-9d2a-0000000000a1",
  ]);
  await seed.end();
  configurePgTenancy(true, key);
  pool = createPgPool(databaseUrl());
  await pool.pool();
});

after(async () => {
  await pool?.close();
  configurePgTenancy(false);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

test("applying tenancy folds each tenant's env bags into its settings once, keeping only per-tenant secrets", async () => {
  const bags = await pool.q(`SELECT slug FROM tenants WHERE env <> '{}' OR secret_env IS NOT NULL ORDER BY slug`);
  assert.deepEqual(bags, [{ slug: "closedai" }, { slug: "mt-fake-1" }]);
  const [closedai, fake, styleup] = await listTenants(pool, key);
  assert.deepEqual(closedai, {
    id: "5b0c7e44-1f1a-4c6e-9d2a-0000000000c1",
    slug: "closedai",
    orgId: "closedai",
    hosts: ["closedai.example.test"],
    status: "active",
    appsDomain: "apps.closedai.example.test",
    s3Bucket: "qm-closedai-bucket",
    sandboxNamePrefix: "qm-closedai",
    modalAppName: "qm-closedai",
    modalEnvironment: "closedai",
    modalSnapshotBucket: "qm-closedai-snapshots",
    awsSandboxBucket: "qm-closedai-sandbox",
    sentryDeployment: "closedai",
    faviconSvg: "<svg>web</svg>",
    oidcClientId: "closedai",
    oidcLabel: "Example SSO",
    oidcAdmin: true,
    secrets: {
      oidcClientSecret: "closedai-trusted-secret",
      modelGatewayApiKey: "closedai-gateway",
      slackServiceToken: "closedai-slack",
      adminGrants: "a@closedai.example:org_admin",
      connectorSecretKey: "closedai-connector",
    },
  });
  assert.deepEqual(fake, {
    id: "5b0c7e44-1f1a-4c6e-9d2a-0000000000f1",
    slug: "mt-fake-1",
    orgId: "mt-fake-1",
    hosts: ["mt-fake-1.example.test"],
    status: "active",
    sandboxNamePrefix: "qm-mt-fake-1",
    modalAppName: "qm-mt-fake-1",
    oidcAdmin: false,
    secrets: {},
  });
  assert.deepEqual(styleup, {
    id: "5b0c7e44-1f1a-4c6e-9d2a-0000000000a1",
    slug: "styleup",
    orgId: "styleup",
    hosts: [],
    status: "active",
    oidcAdmin: false,
    secrets: {},
  });
});

test("the fold leaves rows that already have settings alone and changes nothing without the secrets key", async () => {
  await pool.q(`UPDATE tenants SET s3_bucket = NULL WHERE slug = 'closedai'`);
  await pool.q(`INSERT INTO tenants(id, slug, org_id, env, secret_env) VALUES ($1, 'openaguy', 'openaguy', $2, $3)`, [
    "5b0c7e44-1f1a-4c6e-9d2a-0000000000e1",
    { core: { S3_BUCKET: "qm-openaguy" } },
    sealTenantSecret({ core: { QM_SLACK_SERVICE_TOKEN: "openaguy-slack" } }, key),
  ]);
  await assert.rejects(
    applyTenancy(await pool.pool(), undefined),
    /openaguy has secrets but QM_TENANT_SECRETS_KEY is unset/,
  );
  assert.equal((await listTenants(pool, key)).find((t) => t.slug === "openaguy")?.s3Bucket, undefined);
  await applyTenancy(await pool.pool(), key);
  const after = await listTenants(pool, key);
  assert.equal(after.find((t) => t.slug === "closedai")?.s3Bucket, undefined);
  const openaguy = after.find((t) => t.slug === "openaguy")!;
  assert.equal(openaguy.s3Bucket, "qm-openaguy");
  assert.deepEqual(openaguy.secrets, { slackServiceToken: "openaguy-slack" });
});

test("a tenant record round-trips through its row with secrets sealed at rest", async () => {
  const record: TenantRecord = {
    id: randomUUID(),
    slug: "kittenmittens",
    orgId: "kittenmittens",
    hosts: ["kittenmittens.example.test", "km.example.test"],
    status: "suspended",
    appsDomain: "apps.km.example.test",
    s3Bucket: "qm-km",
    oidcClientId: "kittenmittens",
    oidcAdmin: true,
    secrets: { oidcClientSecret: "km-trusted-secret", slackServiceToken: "km-slack" },
  };
  await upsertTenant(pool, record, key);
  const stored = await pool.q(`SELECT encode(secrets, 'escape') AS raw FROM tenants WHERE id = $1`, [record.id]);
  assert.doesNotMatch(String(stored[0]!.raw), /km-slack|km-trusted-secret/);
  assert.deepEqual(
    (await listTenants(pool, key)).find((t) => t.id === record.id),
    record,
  );
  await upsertTenant(pool, { ...record, s3Bucket: undefined, secrets: {} }, undefined);
  const cleared = (await listTenants(pool, key)).find((t) => t.id === record.id)!;
  assert.equal(cleared.s3Bucket, undefined);
  assert.deepEqual(cleared.secrets, {});
  await assert.rejects(upsertTenant(pool, record, undefined), /QM_TENANT_SECRETS_KEY/);
  await assert.rejects(listTenants(pool, randomBytes(32)), /unable to authenticate|Unsupported state/);
});

test("tenantSettings() answers from the registry for a registered tenant and from process env for the home tenant", () => {
  const acme: TenantRecord = {
    id: randomUUID(),
    slug: "acme",
    orgId: "acme",
    hosts: ["acme.example.test"],
    status: "active",
    s3Bucket: "acme-bucket",
    oidcAdmin: false,
    secrets: {},
  };
  registerTenantSettings([acme]);
  const saved = { ...process.env };
  try {
    for (const name of ["PORTAL_PUBLIC_URL", "PUBLIC_API_URL", "AGENT_API_URL"]) delete process.env[name];
    process.env.S3_BUCKET = "home-bucket";
    process.env.PUBLIC_WEB_URL = "https://home.example.test";
    process.env.MODEL_GATEWAY_API_KEY = "home-gateway";
    assert.equal(
      withTenant(tenantFor("acme", acme.id, "acme"), () => tenantSettings()),
      acme,
    );
    const home = tenantSettings();
    assert.equal(home.orgId, tenant().orgId);
    assert.equal(home.s3Bucket, "home-bucket");
    assert.deepEqual(home.hosts, ["home.example.test"]);
    assert.equal(home.secrets.modelGatewayApiKey, "home-gateway");
    assert.throws(() => tenantSettings(tenantFor("ghost", randomUUID(), "ghost")), /ghost has no registered settings/);
  } finally {
    process.env = saved;
    registerTenantSettings([]);
  }
});
