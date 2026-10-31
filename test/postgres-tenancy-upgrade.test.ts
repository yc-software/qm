import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, migrateRegisteredPgSchemas, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { withTenant } from "../src/tenants/context.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the tenancy upgrade test";
const TENANCY = /^0000-tenancy\/|-tenants$|^sessions\/store\/(0048|0049|0050)-/;

async function withSchema(fn: (url: string, db: pg.Pool) => Promise<void>): Promise<void> {
  const schema = `upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: url.toString() });
  try {
    await fn(url.toString(), db);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test(
  "a populated pre-tenancy database keeps its instance uuid as its one tenant and gets every row assigned",
  { skip },
  async () => {
    await withSchema(async (url, db) => {
      createPostgresSessionStore(url);
      createPostgresRunStore(url);
      createPostgresGrantStore(url);
      await applyPgMigrations(
        db,
        registeredPgMigrations(url).filter((m) => !TENANCY.test(m.id)),
      );
      const instance = String((await db.query("SELECT id FROM qm_tenant")).rows[0].id);
      await db.query(
        `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, last_activity, messages, turns)
       VALUES ('s1', 'dm', 'personal:a', 'web:t1', 1, 1, 0, 0)`,
      );
      await db.query(
        `INSERT INTO items(tenant_id, session_id, seq, kind, body, created_at) VALUES ($1, 's1', 0, 'UserMessage', '{}', now())`,
        [instance],
      );
      await db.query(
        `INSERT INTO runs(id, session_id, status, request, idempotency_key, created_at) VALUES ('r1', 's1', 'done', '{}', 'k', 1)`,
      );
      await db.query(`INSERT INTO acl_grants VALUES ('personal:a', 'p', 'personal:b', 'read', 'a')`);
      await db.query(
        `INSERT INTO directory_members(org_id, principal_id, display_name, display_name_lc, type)
       VALUES ('org', 'a', 'A', 'a', 'internal'), ('org', 'b', 'B', 'b', 'internal'), ('old', 'a', 'Old', 'old', 'internal')`,
      );
      await migrateRegisteredPgSchemas(url);
      assert.deepEqual((await db.query("SELECT id::text AS id FROM tenants")).rows, [{ id: instance }]);
      for (const table of ["sessions", "items", "runs", "acl_grants", "directory_members"]) {
        const { rows } = await db.query(`SELECT DISTINCT tenant_id::text AS tenant FROM ${table}`);
        assert.deepEqual(rows, [{ tenant: instance }], table);
      }
      assert.deepEqual((await db.query("SELECT display_name FROM directory_members ORDER BY 1")).rows, [
        { display_name: "A" },
        { display_name: "B" },
      ]);
      assert.equal((await db.query("SELECT to_regclass('qm_tenant') AS t")).rows[0].t, null);
      const grants = createPostgresGrantStore(url);
      assert.equal((await withTenant(instance, () => grants.all())).length, 1);
    });
  },
);

test("a fresh database ends with no tenant row", { skip }, async () => {
  await withSchema(async (url, db) => {
    createPostgresSessionStore(url);
    createPostgresRunStore(url);
    createPostgresGrantStore(url);
    await migrateRegisteredPgSchemas(url);
    assert.deepEqual((await db.query("SELECT count(*)::int AS n FROM tenants")).rows, [{ n: 0 }]);
  });
});

test("a booted database without rows keeps its instance uuid as its one tenant", { skip }, async () => {
  await withSchema(async (url, db) => {
    createPostgresSessionStore(url);
    createPostgresRunStore(url);
    createPostgresGrantStore(url);
    await applyPgMigrations(
      db,
      registeredPgMigrations(url).filter((m) => !TENANCY.test(m.id)),
    );
    const instance = String((await db.query("SELECT id FROM qm_tenant")).rows[0].id);
    await migrateRegisteredPgSchemas(url);
    assert.deepEqual((await db.query("SELECT id::text AS id FROM tenants")).rows, [{ id: instance }]);
  });
});
