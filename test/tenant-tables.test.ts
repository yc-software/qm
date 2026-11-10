import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "./support/unbound-test.ts";
import { createPostgresAdminGrantStore } from "../src/admin/postgres-admin-grant-store.ts";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { createPgPool, type PgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresInstanceRegistry } from "../src/runs/instance-registry.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { appUrl, ownerUrl } from "./support/test-tenant.ts";

const UNTENANTED: Record<string, string> = {
  qm_schema_migrations: "records which migrations the whole database has applied",
  tenants: "is the tenant registry, keyed by the tenant id itself and read through its own policy",
  qm_settings: "holds install-level settings the process reads, no tenant data",
  source_auth_replay: "holds random replay nonces for signed internal calls",
  instance_heartbeats: "records the liveness of core processes",
  auth_broker_sessions: "holds identity-provider sign-in sessions, which exist before a tenant is chosen",
  deployment_layer: "describes the installation's deployment layer, which the process reads before any tenant binds",
  render_sandbox_bases: "records the golden snapshot of the release's sandbox image, shared by every tenant",
  superserve_config_epochs: "numbers the installation's sandbox configuration generations, shared by every tenant",
  fly_peer_claims: "assigns the installation's WireGuard peers to core processes",
  fly_deploy_ports: "allocates ports inside the installation's shared Fly app across every tenant's deployments",
};

describe("tenant tables", () => {
  let owner: PgPool;
  let app: PgPool;
  let appDatabaseUrl = "";
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  before(async () => {
    const databaseUrl = testMigratedDatabaseUrl();
    owner = createPgPool(ownerUrl(databaseUrl).toString());
    appDatabaseUrl = appUrl(databaseUrl);
    app = createPgPool(appDatabaseUrl);
    await createPostgresInstanceRegistry(owner, { instanceId: "i", deploymentKey: "k", startedAt: 0 }).beat(false);
    await createPostgresMap<{ who: string }>(owner, "tenant_probe").get("none");
    await owner.q("INSERT INTO tenants(id) VALUES ($1), ($2)", [tenantA, tenantB]);
  });

  after(async () => {
    await app?.close();
    await owner?.close();
  });

  it("gives every table a tenant column, tenant-first keys and the tenant_isolation policy unless listed", async () => {
    const rows = await owner.q(
      `SELECT c.relname AS name,
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnotnull) AS has_column,
              c.relrowsecurity AS rls,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
              NOT EXISTS (SELECT 1 FROM pg_index i
                           WHERE i.indrelid = c.oid AND i.indisunique
                             AND i.indkey[0] IS DISTINCT FROM (SELECT attnum FROM pg_attribute
                                                  WHERE attrelid = c.oid AND attname = 'tenant_id')) AS tenant_first
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')`,
    );
    const names = rows.map((row) => String(row.name));
    for (const table of ["sessions", "items", "runs", "crons", "budget_spend", "file_uploads", "app_page_views"])
      assert.ok(names.includes(table), `${table} was not created`);
    const gaps = rows
      .filter((row) => !Object.hasOwn(UNTENANTED, String(row.name)))
      .filter((row) => !(row.has_column && row.rls && row.policy && row.tenant_first))
      .map((row) => String(row.name));
    assert.deepEqual(gaps, []);
    const tenantedListed = rows
      .filter((row) => Object.hasOwn(UNTENANTED, String(row.name)) && row.has_column)
      .filter((row) => String(row.name) !== "tenants")
      .map((row) => String(row.name));
    assert.deepEqual(tenantedListed, []);
    assert.ok(names.includes("superserve_config_epochs"));
    const tenants = rows.find((row) => row.name === "tenants");
    assert.ok(tenants?.rls && tenants.policy);
  });

  it("keeps two tenants' rows apart under a login that does not own the tables", async () => {
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
    await withTenant(tenantA, () => app.q("UPDATE sessions SET title = 'a' WHERE id = 'shared-session'"));
    const titles = await owner.q(
      "SELECT tenant_id::text AS tenant, title FROM sessions WHERE tenant_id = ANY($1::uuid[])",
      [[tenantA, tenantB]],
    );
    assert.deepEqual(Object.fromEntries(titles.map((row) => [String(row.tenant), row.title])), {
      [tenantA]: "a",
      [tenantB]: null,
    });
  });

  it("rejects a write into another tenant and a read with no tenant bound", async () => {
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
    await assert.rejects(
      withoutTenant(() => app.q("SELECT id FROM sessions")),
      /No tenant is bound to this query/,
    );
    await assert.rejects(
      withoutTenant(() => app.q("INSERT INTO teams(team_id, name) VALUES ('t', 't')")),
      /No tenant is bound/,
    );
  });

  it("shows a tenant only its own tenants row and denies the login writes to it", async () => {
    assert.deepEqual(await withTenant(tenantA, () => app.q("SELECT id::text AS id FROM tenants")), [{ id: tenantA }]);
    await assert.rejects(
      withTenant(tenantA, () => app.q("INSERT INTO tenants(id) VALUES ($1)", [randomUUID()])),
      /permission denied/,
    );
  });

  it("keeps two tenants' key-value rows apart", async () => {
    const map = createPostgresMap<{ who: string }>(app, "tenant_probe");
    await withTenant(tenantA, () => map.put("same-id", { who: "a" }));
    await withTenant(tenantB, () => map.put("same-id", { who: "b" }));
    await withTenant(tenantA, () => map.put("only-a", { who: "a" }));
    assert.deepEqual(await withTenant(tenantA, () => map.get("same-id")), { who: "a" });
    assert.deepEqual(await withTenant(tenantB, () => map.get("same-id")), { who: "b" });
    assert.equal(await withTenant(tenantB, () => map.get("only-a")), null);
    await withTenant(tenantB, () => map.delete("same-id"));
    assert.deepEqual(await withTenant(tenantA, () => map.get("same-id")), { who: "a" });
  });

  it("upserts on tenant-first keys, so the same natural key lives once per tenant", async () => {
    const grants = createPostgresAdminGrantStore(appDatabaseUrl);
    const grant = { principalId: "p", scopeId: scopeId("org", "o"), role: "org_admin" as const, grantedBy: "x" };
    for (const id of [tenantA, tenantB]) {
      await withTenant(id, (tenant) => grants.put(tenant, grant));
      await withTenant(id, (tenant) => grants.put(tenant, { ...grant, grantedBy: id }));
    }
    assert.deepEqual(
      (await withTenant(tenantA, (tenant) => grants.all(tenant))).map((g) => g.grantedBy),
      [tenantA],
    );
    assert.deepEqual(
      (await withTenant(tenantB, (tenant) => grants.all(tenant))).map((g) => g.grantedBy),
      [tenantB],
    );
  });
});
