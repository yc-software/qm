import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPgPool, migrateRegisteredPgSchemas, withPgTransaction } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the tenant isolation test";

async function asAppRole(
  fn: (ctx: {
    app: ReturnType<typeof createPgPool>;
    admin: pg.Pool;
    sessionId: string;
    tenant: string;
  }) => Promise<void>,
): Promise<void> {
  const schema = `tenancy_${randomUUID().replaceAll("-", "")}`;
  const role = `app_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = new globalThis.URL(URL!);
  schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: schemaUrl.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS`);
  const store = createPostgresSessionStore(schemaUrl.toString());
  try {
    await migrateRegisteredPgSchemas(schemaUrl.toString());
    const tenant = String((await admin.query(`SELECT id::text AS id FROM tenants`)).rows[0].id);
    const session = await withTenant(tenant, () =>
      store.getOrCreateByThread(`tenancy-${randomUUID()}`, "channel", scopeId("channel", "tenancy")),
    );
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await admin.query(`ALTER TABLE ${schema}.items OWNER TO ${role}`);
    const appUrl = new globalThis.URL(schemaUrl);
    appUrl.username = role;
    appUrl.password = "app";
    const app = createPgPool(appUrl.toString());
    try {
      await fn({ app, admin, sessionId: session.id, tenant });
    } finally {
      await app.close();
    }
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
}

const insertItem = `INSERT INTO items(session_id, seq, kind, body, created_at)
  VALUES ($1, $2, 'UserMessage', '{"text":"tenant fixture"}', now())`;
const countItems = "SELECT count(*)::int AS n FROM items WHERE session_id = $1";

test("the tenants migration carries the instance tenant over and forces row security on items", { skip }, async () => {
  await asAppRole(async ({ admin, tenant }) => {
    const { rows } = await admin.query(
      `SELECT to_regclass('qm_tenant') IS NULL AS dropped,
              (SELECT array_agg(id::text) FROM tenants) AS tenants,
              c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c WHERE c.oid = 'items'::regclass`,
    );
    assert.deepEqual(rows[0], { dropped: true, tenants: [tenant], relrowsecurity: true, relforcerowsecurity: true });
  });
});

test("a tenant sees and writes only its own items, even as the table owner", { skip }, async () => {
  await asAppRole(async ({ app, sessionId, tenant }) => {
    const other = randomUUID();
    await withTenant(tenant, () => app.q(insertItem, [sessionId, 0]));
    assert.deepEqual(await withTenant(tenant, () => app.q(countItems, [sessionId])), [{ n: 1 }]);
    assert.deepEqual(await withTenant(other, () => app.q(countItems, [sessionId])), [{ n: 0 }]);
    await assert.rejects(
      withTenant(other, () =>
        app.q(
          `INSERT INTO items(tenant_id, session_id, seq, kind, body, created_at)
           VALUES ($1, $2, 1, 'UserMessage', '{}', now())`,
          [tenant, sessionId],
        ),
      ),
      /row-level security policy/,
    );
    await withTenant(other, () => app.q(insertItem, [sessionId, 1]));
    assert.deepEqual(await withTenant(tenant, () => app.q(countItems, [sessionId])), [{ n: 1 }]);
    assert.deepEqual(await withTenant(other, () => app.q(countItems, [sessionId])), [{ n: 1 }]);
  });
});

test("items fail closed when no tenant is bound, including on a connection a tenant just used", { skip }, async () => {
  await asAppRole(async ({ app, sessionId, tenant }) => {
    await withTenant(tenant, () => app.q(insertItem, [sessionId, 0]));
    const pool = await app.pool();
    const client = await pool.connect();
    try {
      await withTenant(tenant, () => client.query(countItems, [sessionId]));
      await assert.rejects(client.query(countItems, [sessionId]), /No tenant is bound to this transaction/);
      await assert.rejects(client.query(insertItem, [sessionId, 5]), /No tenant is bound to this transaction/);
    } finally {
      client.release();
    }
    await assert.rejects(app.q("SELECT count(*) FROM items"), /No tenant is bound to this transaction/);
  });
});

test("transactions and queued pool queries keep the tenant of the caller that issued them", { skip }, async () => {
  await asAppRole(async ({ app, sessionId, tenant }) => {
    const other = randomUUID();
    await withTenant(tenant, () => app.q(insertItem, [sessionId, 0]));
    const inTransaction = await withTenant(tenant, async () =>
      withPgTransaction(await app.pool(), async (client) => {
        await client.query(insertItem, [sessionId, 1]);
        return (await client.query(countItems, [sessionId])).rows;
      }),
    );
    assert.deepEqual(inTransaction, [{ n: 2 }]);
    const pool = await app.pool();
    const callers = [tenant, other, undefined];
    const counts = await Promise.allSettled(
      Array.from({ length: 30 }, (_, index) => {
        const caller = callers[index % 3];
        const count = () => pool.query(countItems, [sessionId]).then((result) => result.rows[0].n as number);
        return caller ? withTenant(caller, count) : count();
      }),
    );
    assert.deepEqual(
      counts.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : "rejected")),
      counts.map((_, index) => [2, 0, "rejected"][index % 3]),
    );
    const client = await pool.connect();
    try {
      await withTenant(tenant, () => client.query("BEGIN"));
      await assert.rejects(
        withTenant(other, () => client.query(countItems, [sessionId])),
        /This transaction is bound to another tenant/,
      );
      assert.deepEqual((await withTenant(tenant, () => client.query(countItems, [sessionId]))).rows, [{ n: 2 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const simple = await withTenant(tenant, () => pool.query("SELECT count(*)::int AS n FROM items"));
    assert.deepEqual(simple.rows, [{ n: 2 }]);
  });
});

test(
  "row-limited queries, queries in a transaction opened unbound, and streams all bind or refuse",
  { skip },
  async () => {
    await asAppRole(async ({ app, sessionId, tenant }) => {
      const other = randomUUID();
      await withTenant(tenant, () => app.q(insertItem, [sessionId, 0]));
      const pool = await app.pool();
      const limited = await withTenant(tenant, () =>
        pool.query({
          text: "SELECT seq::int AS seq FROM items WHERE session_id = $1",
          values: [sessionId],
          rows: 1,
        } as pg.QueryConfig),
      );
      assert.deepEqual(limited.rows, [{ seq: 0 }]);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        assert.deepEqual((await withTenant(tenant, () => client.query(countItems, [sessionId]))).rows, [{ n: 1 }]);
        await assert.rejects(
          withTenant(other, () => client.query(countItems, [sessionId])),
          /This transaction is bound to another tenant/,
        );
        await client.query("ROLLBACK");
        const stream = () =>
          new Promise<number>((resolve, reject) => {
            const query = new pg.Query(countItems, [sessionId]);
            query.on("row", (row: { n: number }) => resolve(row.n));
            query.on("error", reject);
            query.on("end", () => resolve(-1));
            client.query(query);
          });
        await assert.rejects(
          withTenant(tenant, () => stream()),
          /Streaming queries for a tenant must run inside a transaction bound to that tenant/,
        );
        await withTenant(tenant, () => client.query("BEGIN"));
        assert.equal(await withTenant(tenant, () => stream()), 1);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  },
);
