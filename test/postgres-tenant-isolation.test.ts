import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPgPool, migrateRegisteredPgSchemas, withPgTransaction } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { seedTenant } from "./support/tenant.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the tenant isolation test";
const APP_PASSWORD = "qm-app-test";

interface Tenancy {
  app: ReturnType<typeof createPgPool>;
  admin: pg.Pool;
  url: string;
  schema: string;
  a: string;
  b: string;
  sessionId: string;
}

async function withTenancy(fn: (ctx: Tenancy) => Promise<void>): Promise<void> {
  const schema = `tenancy_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = new globalThis.URL(URL!);
  schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
  const url = schemaUrl.toString();
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = createPostgresSessionStore(url);
  createPostgresRunStore(url);
  createPostgresDeliveryStore(url);
  createPostgresGrantStore(url);
  createPostgresAuditLog(url);
  createPostgresMemoryService(url);
  try {
    await migrateRegisteredPgSchemas(url);
    await admin.query(`ALTER ROLE qm_app PASSWORD '${APP_PASSWORD}'`);
    const [a, b] = [randomUUID(), randomUUID()];
    await seedTenant(url, a);
    await seedTenant(url, b);
    const session = await withTenant(a, () =>
      store.getOrCreateByThread(`tenancy-${randomUUID()}`, "channel", scopeId("channel", "tenancy")),
    );
    const appUrl = new globalThis.URL(url);
    appUrl.username = "qm_app";
    appUrl.password = APP_PASSWORD;
    const app = createPgPool(appUrl.toString());
    try {
      await fn({ app, admin, url, schema, a, b, sessionId: session.id });
    } finally {
      await app.close();
    }
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const insertItem = `INSERT INTO items(session_id, seq, kind, body, created_at, text)
  VALUES ($1, $2, 'UserMessage', '{"text":"tenant fixture"}', now(), 'tenant fixture')`;
const countItems = "SELECT count(*)::int AS n FROM items WHERE session_id = $1";

test(
  "a fresh database gets no tenant row and every tenant table has row security enabled, not forced",
  { skip },
  async () => {
    const schema = `tenancy_${randomUUID().replaceAll("-", "")}`;
    const schemaUrl = new globalThis.URL(URL!);
    schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
    const admin = new pg.Pool({ connectionString: schemaUrl.toString() });
    await admin.query(`CREATE SCHEMA ${schema}`);
    try {
      createPostgresSessionStore(schemaUrl.toString());
      createPostgresRunStore(schemaUrl.toString());
      await migrateRegisteredPgSchemas(schemaUrl.toString());
      const { rows } = await admin.query(
        `SELECT (SELECT count(*)::int FROM tenants) AS tenants, to_regclass('qm_tenant') IS NULL AS dropped,
              array_agg(c.relname ORDER BY c.relname) FILTER (WHERE NOT c.relrowsecurity OR c.relforcerowsecurity
                OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) <> 2) AS unprotected
         FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid AND t.attname = 'tenant_id'
        WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r'`,
        [schema],
      );
      assert.deepEqual(rows[0], { tenants: 0, dropped: true, unprotected: null });
      const roles = await admin.query(
        "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('qm_app', 'qm_reader') ORDER BY 1",
      );
      assert.deepEqual(roles.rows, [
        { rolname: "qm_app", rolsuper: false, rolbypassrls: false },
        { rolname: "qm_reader", rolsuper: false, rolbypassrls: false },
      ]);
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test("the app login cannot read, change or delete another tenant's rows", { skip }, async () => {
  await withTenancy(async ({ app, a, b, sessionId }) => {
    const seed = [
      [insertItem, [sessionId, 0]],
      [
        "INSERT INTO runs(id, session_id, status, request, idempotency_key, created_at) VALUES ('r1', $1, 'pending', '{}', 'k', 1)",
        [sessionId],
      ],
      [
        "INSERT INTO deliveries(id, idempotency_key, destination, text, created_at) VALUES ('d1', 'k', '{}', 't', 1)",
        [],
      ],
      ["INSERT INTO acl_grants VALUES ('personal:a', 'p', 'personal:b', 'read', 'a')", []],
      ["INSERT INTO audit_log(at, principal_id, action, resource, scope_label) VALUES (1, 'a', 'x', 'y', 'z')", []],
      [
        "INSERT INTO memory_facts(scope_id, text, sensitivity, source_unknown, created_at, updated_at) VALUES ('s', 't', 'normal', false, 1, 1)",
        [],
      ],
    ] as const;
    for (const [sql, params] of seed) await withTenant(a, () => app.q(sql, [...params]));
    for (const table of ["sessions", "items", "runs", "deliveries", "acl_grants", "audit_log", "memory_facts"]) {
      const count = `SELECT count(*)::int AS n FROM ${table}`;
      assert.deepEqual(await withTenant(a, () => app.q(count)), [{ n: 1 }], `${table} visible to its tenant`);
      assert.deepEqual(await withTenant(b, () => app.q(count)), [{ n: 0 }], `${table} hidden from another tenant`);
      const touched = await withTenant(b, () => app.query(`UPDATE ${table} SET tenant_id = tenant_id`));
      assert.equal(touched.rowCount, 0, `${table} update stays in tenant`);
      const removed = await withTenant(b, () => app.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [a]));
      assert.equal(removed.rowCount, 0, `${table} delete stays in tenant`);
      assert.deepEqual(await withTenant(a, () => app.q(count)), [{ n: 1 }]);
    }
    await assert.rejects(
      withTenant(b, () =>
        app.q(
          "INSERT INTO deliveries(tenant_id, id, idempotency_key, destination, text, created_at) VALUES ($1, 'd2', 'k2', '{}', 't', 1)",
          [a],
        ),
      ),
      /row-level security policy/,
    );
    await withTenant(b, () =>
      app.q(
        "INSERT INTO runs(id, session_id, status, request, idempotency_key, created_at) VALUES ('r1', 's', 'pending', '{}', 'k', 1)",
      ),
    );
    assert.deepEqual(
      await withTenant(b, () => app.q("SELECT count(*)::int AS n FROM runs WHERE idempotency_key = 'k'")),
      [{ n: 1 }],
    );
    await assert.rejects(
      withTenant(b, () => app.q("UPDATE runs SET tenant_id = $1", [a])),
      /row-level security policy/,
    );
    await assert.rejects(
      app.q("INSERT INTO tenants(id, slug, name) VALUES ($1, 'x', 'x')", [randomUUID()]),
      /row-level security policy/,
    );
  });
});

test("unbound app queries fail closed, including on a connection a tenant just used", { skip }, async () => {
  await withTenancy(async ({ app, a, sessionId }) => {
    await withTenant(a, () => app.q(insertItem, [sessionId, 0]));
    const pool = await app.pool();
    const client = await pool.connect();
    try {
      await withTenant(a, () => client.query(countItems, [sessionId]));
      await assert.rejects(client.query(countItems, [sessionId]), /No tenant is bound to this transaction/);
      await assert.rejects(client.query(insertItem, [sessionId, 5]), /No tenant is bound to this transaction/);
    } finally {
      client.release();
    }
    for (const table of ["sessions", "runs", "deliveries", "acl_grants", "memory_facts"]) {
      await assert.rejects(app.q(`SELECT count(*) FROM ${table}`), /No tenant is bound to this transaction/);
    }
  });
});

test("item search goes through the definer function and stays inside the bound tenant", { skip }, async () => {
  await withTenancy(async ({ app, a, b, sessionId }) => {
    await withTenant(a, () => app.q(insertItem, [sessionId, 0]));
    const search = "SELECT session_id FROM qm_search_items(to_tsquery('simple', 'fixture'))";
    assert.deepEqual(await withTenant(a, () => app.q(search)), [{ session_id: sessionId }]);
    assert.deepEqual(await withTenant(b, () => app.q(search)), []);
    await assert.rejects(app.q(search), /No tenant is bound to this transaction/);
  });
});

test("the reader login sees only its tenant's rows and cannot write", { skip }, async () => {
  await withTenancy(async ({ admin, url, a, b, sessionId }) => {
    await admin.query(`ALTER ROLE qm_reader PASSWORD '${APP_PASSWORD}'`);
    const readerUrl = new globalThis.URL(url);
    readerUrl.username = "qm_reader";
    readerUrl.password = APP_PASSWORD;
    const reader = createPgPool(readerUrl.toString());
    try {
      assert.deepEqual(await withTenant(a, () => reader.q("SELECT id FROM sessions")), [{ id: sessionId }]);
      assert.deepEqual(await withTenant(b, () => reader.q("SELECT id FROM sessions")), []);
      await assert.rejects(
        withTenant(a, () => reader.q("DELETE FROM sessions")),
        /permission denied/,
      );
    } finally {
      await reader.close();
    }
  });
});

test("transactions and queued pool queries keep the tenant of the caller that issued them", { skip }, async () => {
  await withTenancy(async ({ app, a, b, sessionId }) => {
    await withTenant(a, () => app.q(insertItem, [sessionId, 0]));
    const inTransaction = await withTenant(a, async () =>
      withPgTransaction(await app.pool(), async (client) => {
        await client.query(insertItem, [sessionId, 1]);
        return (await client.query(countItems, [sessionId])).rows;
      }),
    );
    assert.deepEqual(inTransaction, [{ n: 2 }]);
    const pool = await app.pool();
    const callers = [a, b, undefined];
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
      await withTenant(a, () => client.query("BEGIN"));
      await assert.rejects(
        withTenant(b, () => client.query(countItems, [sessionId])),
        /This transaction is bound to another tenant/,
      );
      assert.deepEqual((await withTenant(a, () => client.query(countItems, [sessionId]))).rows, [{ n: 2 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

test("acl grant caches and version bumps stay per tenant", { skip }, async () => {
  await withTenancy(async ({ admin, url, schema, a, b }) => {
    await admin.query(`GRANT CREATE ON SCHEMA ${schema} TO qm_app`);
    const appUrl = new globalThis.URL(url);
    appUrl.username = "qm_app";
    appUrl.password = APP_PASSWORD;
    const grants = createPostgresGrantStore(appUrl.toString());
    const grant = (ref: string) => ({
      ownerScopeId: scopeId("personal", "a"),
      ref,
      granteeScopeId: scopeId("personal", "b"),
      permission: "read" as const,
      grantedBy: "a",
    });
    await withTenant(a, () => grants.put(grant("a.md")));
    assert.deepEqual(
      (await withTenant(a, () => grants.all())).map((g) => g.ref),
      ["a.md"],
    );
    assert.deepEqual(await withTenant(b, () => grants.all()), []);
    await withTenant(b, () => grants.put(grant("b.md")));
    assert.deepEqual(
      (await withTenant(b, () => grants.all())).map((g) => g.ref),
      ["b.md"],
    );
    assert.deepEqual(
      (await withTenant(a, () => grants.all())).map((g) => g.ref),
      ["a.md"],
    );
  });
});

test(
  "row-limited queries, queries in a transaction opened unbound, and streams all bind or refuse",
  { skip },
  async () => {
    await withTenancy(async ({ app, sessionId, a: tenant }) => {
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
