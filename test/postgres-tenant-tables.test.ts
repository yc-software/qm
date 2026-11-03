import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { scopeId } from "../src/types.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { testTenants } from "./support/test-tenants.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenant table tests";
const [a, b] = process.env.DATABASE_URL ? testTenants() : ["", ""];
const UNTENANTED = ["durable_map_versions", "qm_schema_migrations", "source_auth_replay", "tenants"];
const TABLES = ["sessions", "runs", "deliveries", "acl_grants", "audit_log", "memory_facts"];

function asRole(databaseUrl: string, role: "qm_app" | "qm_reader"): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

async function inTenant<T>(pool: pg.Pool, tenant: string | null, fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenant) await client.query("SELECT set_config('qm.tenant_id', $1, true)", [tenant]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

let url = "";
let owner: pg.Pool;
let app: pg.Pool;
let reader: pg.Pool;

before(async () => {
  if (skip) return;
  url = testMigratedDatabaseUrl();
  owner = new pg.Pool({ connectionString: url });
  app = new pg.Pool({ connectionString: asRole(url, "qm_app") });
  reader = new pg.Pool({ connectionString: asRole(url, "qm_reader") });
  const store = createPostgresSessionStore(url);
  const session = await store.getOrCreateByThread(`tables-${randomUUID()}`, "dm", scopeId("personal", "t"));
  await inTenant(app, a, async (c) => {
    await c.query(
      "INSERT INTO runs(id, session_id, status, request, idempotency_key, created_at) VALUES ('r1', $1, 'pending', '{}', 'k', 1)",
      [session.id],
    );
    await c.query(
      "INSERT INTO deliveries(id, idempotency_key, destination, text, created_at) VALUES ('d1', 'k', '{}', 't', 1)",
    );
    await c.query("INSERT INTO acl_grants VALUES ('personal:a', 'p', 'personal:b', 'read', 'a')");
    await c.query(
      "INSERT INTO audit_log(at, principal_id, action, resource, scope_label) VALUES (1, 'a', 'x', 'y', 'z')",
    );
    await c.query(
      "INSERT INTO memory_facts(scope_id, text, sensitivity, source_unknown, created_at, updated_at) VALUES ('s', 't', 'normal', false, 1, 1)",
    );
  });
});

after(async () => {
  await owner?.end();
  await app?.end();
  await reader?.end();
});

test("every typed table carries a tenant with row security enabled but not forced", { skip }, async () => {
  const { rows } = await owner.query(
    `SELECT c.relname AS table, bool_or(a.attname = 'tenant_id') AS tenanted,
            c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            (SELECT array_agg(p.polname::text ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f'
                      AND k.confrelid = 'tenants'::regclass) AS tenant_key,
            array_agg(a.attname::text ORDER BY a.attnum) AS columns
       FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
      GROUP BY c.oid, c.relname`,
  );
  const typed = rows.filter((row) => !UNTENANTED.includes(row.table) && row.columns.join() !== "id,json");
  assert.ok(typed.length > 40);
  assert.deepEqual(
    typed.filter(
      (row) =>
        !row.tenanted ||
        !row.enabled ||
        row.forced ||
        row.policies?.join() !== "tenant_app,tenant_reader" ||
        !row.tenant_key,
    ),
    [],
  );
});

test("the app login cannot read, change or delete another tenant's rows", { skip }, async () => {
  for (const table of TABLES) {
    const count = `SELECT count(*)::int AS n FROM ${table}`;
    assert.deepEqual((await inTenant(app, a, (c) => c.query(count))).rows, [{ n: 1 }], table);
    assert.deepEqual((await inTenant(app, b, (c) => c.query(count))).rows, [{ n: 0 }], table);
    const touched = await inTenant(app, b, (c) => c.query(`UPDATE ${table} SET tenant_id = tenant_id`));
    assert.equal(touched.rowCount, 0, table);
    const removed = await inTenant(app, b, (c) => c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [a]));
    assert.equal(removed.rowCount, 0, table);
  }
  await assert.rejects(
    inTenant(app, b, (c) =>
      c.query(
        "INSERT INTO deliveries(tenant_id, id, idempotency_key, destination, text, created_at) VALUES ($1, 'd2', 'k2', '{}', 't', 1)",
        [a],
      ),
    ),
    /row-level security policy/,
  );
  await assert.rejects(
    inTenant(app, a, (c) => c.query("UPDATE runs SET tenant_id = $1", [b])),
    /row-level security policy/,
  );
});

test("a tenant reuses another tenant's natural keys without colliding", { skip }, async () => {
  await inTenant(app, b, (c) =>
    c.query(
      "INSERT INTO runs(id, session_id, status, request, idempotency_key, created_at) VALUES ('r1', 's', 'pending', '{}', 'k', 1)",
    ),
  );
  const both = await owner.query("SELECT tenant_id::text AS tenant FROM runs WHERE id = 'r1' ORDER BY 1");
  assert.deepEqual(both.rows.map((row) => row.tenant).sort(), [a, b].sort());
  await inTenant(app, b, (c) => c.query("DELETE FROM runs WHERE id = 'r1'"));
});

test("unbound app queries on typed tables fail closed", { skip }, async () => {
  for (const table of TABLES) {
    await assert.rejects(
      inTenant(app, null, (c) => c.query(`SELECT count(*) FROM ${table}`)),
      /No tenant is bound/,
      table,
    );
  }
});

test("the reader login sees only its tenant's rows and cannot write", { skip }, async () => {
  for (const table of TABLES) {
    const count = `SELECT count(*)::int AS n FROM ${table}`;
    assert.deepEqual((await inTenant(reader, a, (c) => c.query(count))).rows, [{ n: 1 }], table);
    assert.deepEqual((await inTenant(reader, b, (c) => c.query(count))).rows, [{ n: 0 }], table);
  }
  await assert.rejects(
    inTenant(reader, a, (c) => c.query("DELETE FROM runs")),
    /permission denied/,
  );
});
