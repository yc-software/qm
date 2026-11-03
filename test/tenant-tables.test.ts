import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createPostgresEgressAuditSink } from "../src/admin/postgres-egress-audit-sink.ts";
import { createPostgresErrorLog } from "../src/admin/postgres-error-log.ts";
import { createPostgresAppPageViewLog } from "../src/deploy/page-views.ts";
import { createPostgresFileUploadStore } from "../src/files/file-upload-store.ts";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { createPgPool, migrateRegisteredPgSchemas, type PgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresBudgetTracker } from "../src/ratelimit/postgres-budget.ts";
import { createPostgresInstanceRegistry } from "../src/runs/instance-registry.ts";
import { withTenant } from "../src/tenants/context.ts";
import { workTenant } from "../src/tenants/work-tenant.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";

const UNTENANTED: Record<string, string> = {
  qm_schema_migrations: "records which migrations the whole database has applied",
  tenants: "is the tenant registry itself",
  tenant_hosts: "maps hostnames to tenants before any tenant is bound",
  qm_tenant: "names the install's own tenant, one row per database",
  qm_settings: "holds install-level settings the process reads, no tenant data",
  source_auth_replay: "holds random replay nonces for signed internal calls",
  instance_heartbeats: "records the liveness of core processes",
  surface_origin_settled_candidates: "is bookkeeping for a one-off origin rewrite",
  surface_origin_settled_collected: "is bookkeeping for a one-off origin rewrite",
};

async function asAdmin<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createAppLogin(databaseUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const role = `qm_app_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);
  await asAdmin(databaseUrl, async (client) => {
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  });
  url.username = role;
  url.password = password;
  return {
    url: url.toString(),
    drop: () =>
      asAdmin(databaseUrl, async (client) => {
        await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [role]);
        await client.query(`DROP OWNED BY ${role}`);
        await client.query(`DROP ROLE ${role}`);
      }),
  };
}

describe("tenant tables", () => {
  let owner: PgPool;
  let app: PgPool;
  let dropLogin = async (): Promise<void> => {};
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let install = "";

  before(async () => {
    const databaseUrl = testMigratedDatabaseUrl();
    createPostgresVectorStore(databaseUrl);
    createPostgresAppPageViewLog(databaseUrl);
    createPostgresFileUploadStore(databaseUrl);
    createPostgresBudgetTracker(databaseUrl);
    createPostgresEgressAuditSink(databaseUrl);
    createPostgresErrorLog(databaseUrl);
    owner = createPgPool(databaseUrl);
    await createPostgresInstanceRegistry(owner, { instanceId: "i", buildSha: "b", startedAt: 0 }).beat();
    await migrateRegisteredPgSchemas(databaseUrl);
    await createPostgresMap<{ n: number }>(owner, "tenant_probe").get("none");
    await createPostgresMap<{ who: string }>(owner, "tenant_probe_pair").get("none");
    install = String((await owner.q("SELECT id::text AS id FROM tenants"))[0]?.id);
    const login = await createAppLogin(databaseUrl);
    dropLogin = login.drop;
    app = createPgPool(login.url);
  });

  after(async () => {
    await app?.close();
    await owner?.close();
    await dropLogin();
  });

  it("gives every table a tenant column, a tenant-first key and the tenant_isolation policy unless listed", async () => {
    const rows = await owner.q(
      `SELECT c.relname AS name,
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnotnull) AS has_column,
              c.relrowsecurity AS rls,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
              NOT EXISTS (SELECT 1 FROM pg_index i
                           WHERE i.indrelid = c.oid AND i.indisunique
                             AND i.indkey[0] <> (SELECT attnum FROM pg_attribute
                                                  WHERE attrelid = c.oid AND attname = 'tenant_id')) AS tenant_first
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    const names = rows.map((row) => String(row.name));
    for (const table of ["sessions", "items", "runs", "crons", "memory_fact_vectors", "budget_spend", "file_uploads"])
      assert.ok(names.includes(table), `${table} was not created`);
    const gaps = rows
      .filter((row) => !Object.hasOwn(UNTENANTED, String(row.name)))
      .filter((row) => !(row.has_column && row.rls && row.policy && row.tenant_first))
      .map((row) => String(row.name));
    assert.deepEqual(gaps, []);
  });

  it("binds unbound work to the only tenant, and fails closed once a second tenant exists", async () => {
    const owned = createPostgresMap<{ n: number }>(owner, "tenant_probe");
    const appMap = createPostgresMap<{ n: number }>(app, "tenant_probe");
    await owned.put("solo", { n: 1 });
    assert.deepEqual(await appMap.get("solo"), { n: 1 });
    assert.deepEqual(await appMap.all(), [{ n: 1 }]);
    assert.equal(await workTenant(app), install);
    const stored = await owner.q("SELECT tenant_id::text AS tenant FROM tenant_probe WHERE id = 'solo'");
    assert.equal(stored[0]?.tenant, install);

    await owner.q("INSERT INTO tenants(id) VALUES ($1), ($2)", [tenantA, tenantB]);
    await assert.rejects(appMap.get("solo"), /No tenant is bound to this query/);
    await assert.rejects(appMap.all(), /No tenant is bound to this query/);
    await assert.rejects(owned.put("late", { n: 2 }), /No tenant is bound to this query/);
    assert.deepEqual(await withTenant(install, () => appMap.get("solo")), { n: 1 });
    assert.equal(await withTenant(tenantA, () => appMap.get("solo")), null);
  });

  it("keeps two tenants' key-value rows and snapshots apart under the app login", async () => {
    const appMap = createPostgresMap<{ who: string }>(app, "tenant_probe_pair");
    await withTenant(tenantA, () => appMap.put("same-id", { who: "a" }));
    await withTenant(tenantB, () => appMap.put("same-id", { who: "b" }));
    assert.deepEqual(await withTenant(tenantA, () => appMap.all()), [{ who: "a" }]);
    assert.deepEqual(await withTenant(tenantB, () => appMap.all()), [{ who: "b" }]);
    await withTenant(tenantA, () => appMap.put("only-a", { who: "a" }));
    assert.deepEqual(await withTenant(tenantB, () => appMap.entries()), [["same-id", { who: "b" }]]);
    assert.equal(await withTenant(tenantB, () => appMap.get("only-a")), null);
    await withTenant(tenantB, () => appMap.delete("same-id"));
    assert.deepEqual(await withTenant(tenantA, () => appMap.get("same-id")), { who: "a" });
  });

  it("keeps two tenants' typed rows apart and rejects writes into another tenant", async () => {
    const insert = (tenant: string) =>
      withTenant(tenant, () =>
        app.q(
          `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at)
           VALUES ('shared-session', 'dm', 'personal:u', 'shared-thread', 0)`,
        ),
      );
    await insert(tenantA);
    await insert(tenantB);
    const seen = (tenant: string) =>
      withTenant(tenant, () => app.q("SELECT tenant_id::text AS tenant FROM sessions WHERE id = 'shared-session'"));
    assert.deepEqual(await seen(tenantA), [{ tenant: tenantA }]);
    assert.deepEqual(await seen(tenantB), [{ tenant: tenantB }]);
    await assert.rejects(
      withTenant(tenantA, () =>
        app.q(
          `INSERT INTO sessions(tenant_id, id, type, scope_id, thread_ref, created_at)
           VALUES ($1, 'forged', 'dm', 'personal:u', 'forged', 0)`,
          [tenantB],
        ),
      ),
      /row-level security/,
    );
    const updated = await withTenant(tenantA, () =>
      app.query("UPDATE sessions SET title = 'a' WHERE id = 'shared-session'"),
    );
    assert.equal(updated.rowCount, 1);
    const titles = await owner.q(
      "SELECT tenant_id::text AS tenant, title FROM sessions WHERE id = 'shared-session' AND tenant_id = ANY($1::uuid[])",
      [[tenantA, tenantB]],
    );
    assert.deepEqual(Object.fromEntries(titles.map((row) => [String(row.tenant), row.title])), {
      [tenantA]: "a",
      [tenantB]: null,
    });
  });
});
