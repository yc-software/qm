import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import pg from "pg";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore, createPostgresDeploymentRows, type Deployment } from "../src/deploy/deploy-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresResourceSearch } from "../src/search/resource-search.ts";
import { scopeId } from "../src/types.ts";
import { seedKeyValueTable, skipWithoutPg as skip, withTypedTableDb } from "./support/typed-table.ts";

const createInput = (name?: string) => ({
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  entrypoint: "node s.js",
  snapshotDir: "/snap",
  ...(name ? { name } : {}),
});

const stores = (url: string) => {
  const rows = [createPostgresDeploymentRows(url), createPostgresDeploymentRows(url)];
  const make = (i: number, touchDebounceMs?: number) =>
    createDeployStore({
      deployments: rows[i]!,
      git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-pg-")) },
      ...(touchDebounceMs === undefined ? {} : { touchDebounceMs }),
    });
  return { rows, make, close: async () => undefined };
};

const legacy = (id: string, extra: Partial<Deployment> = {}): Deployment => ({
  id,
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  currentVersion: 1,
  status: "running",
  endpoint: { host: "10.0.0.1", port: 8080, publicUrl: "https://app.example.test/d/x/" },
  versions: [{ version: 1, createdAt: 1, entrypoint: "node s.js", snapshotDir: "/snap" }],
  ...extra,
});

test("touch keeps the max across instances and a full rewrite never regresses it", { skip }, async () => {
  await withTypedTableDb(stores, async ({ store, tenant }) => {
    await withTenant(tenant, async () => {
      const a = store.make(0, 0);
      const b = store.make(1, 0);
      const d = await a.create(createInput());
      await a.touch(d.id, 2_000);
      await b.touch(d.id, 500);
      assert.equal((await b.get(d.id))!.lastAccessAt, 2_000);
      await b.setStatus(d.id, "running");
      assert.equal((await a.get(d.id))!.lastAccessAt, 2_000);
      const stale = (await store.rows[1]!.get(d.id))!;
      await a.touch(d.id, 2_500);
      await store.rows[1]!.put(d.id, { ...stale, status: "stopped" });
      assert.equal((await a.get(d.id))!.lastAccessAt, 2_500);
      await b.touch(d.id, 3_000);
      assert.equal((await a.get(d.id))!.lastAccessAt, 3_000);
      assert.equal(await store.rows[0]!.touch("missing-id", 5), false);
      const debounced = store.make(0);
      await debounced.touch(d.id, 10_000);
      await debounced.touch(d.id, 50_000);
      assert.equal((await a.get(d.id))!.lastAccessAt, 10_000);
    });
  });
});

test("deployment names are unique across every tenant", { skip }, async () => {
  await withTypedTableDb(stores, async ({ store, tenant, otherTenant }) => {
    await withTenant(tenant, async () => {
      const s = store.make(0);
      await s.create(createInput("held"));
      const other = await s.create(createInput("free"));
      await assert.rejects(store.make(1).create(createInput("held")), /deployment name taken: held/);
      await assert.rejects(s.setName(other.id, "held"), /deployment name taken: held/);
      assert.equal((await s.get(other.id))!.name, "free");
      assert.equal((await s.getByName("held"))!.ownerScopeId, "personal:U1");
    });
    await withTenant(otherTenant, async () => {
      const s = store.make(0);
      assert.equal(await s.getByName("held"), null);
      assert.deepEqual(await s.list(), []);
      await assert.rejects(s.create(createInput("held")), /deployment name taken: held/);
      const mine = await s.create(createInput("mine"));
      assert.deepEqual(
        (await s.list()).map((d) => d.id),
        [mine.id],
      );
    });
  });
});

test(
  "a raw duplicate name from the app login hits the unique index the owner migration created",
  { skip },
  async () => {
    await withTypedTableDb(stores, async ({ url, tenant, admin }) => {
      const { rows: owned } = await admin.query(
        `SELECT pg_get_indexdef(to_regclass('deployments_name_key')) AS def,
              (SELECT tableowner FROM pg_tables WHERE tablename = 'deployments') AS owner`,
      );
      assert.match(owned[0].def, /CREATE UNIQUE INDEX deployments_name_key ON .*deployments USING btree \(name\)/);
      const app = new pg.Client({ connectionString: url });
      await app.connect();
      try {
        const { rows } = await app.query(
          `SELECT current_user AS login, pg_has_role(current_user, 'qm_app', 'MEMBER') AS member`,
        );
        assert.notEqual(rows[0].login, owned[0].owner);
        assert.equal(rows[0].member, true);
        await app.query("BEGIN");
        await app.query("SELECT set_config('qm.tenant_id', $1, true)", [tenant]);
        const insert = (id: string) =>
          app.query(
            `INSERT INTO deployments (id, owner_scope_id, created_by, current_version, status, versions, name)
           VALUES ($1, 'personal:U1', 'U1', 1, 'running', '[]', 'held')`,
            [id],
          );
        await insert("raw-a");
        await assert.rejects(insert("raw-b"), { code: "23505", constraint: "deployments_name_key" });
      } finally {
        await app.query("ROLLBACK");
        await app.end();
      }
    });
  },
);

const older = (id: string): Deployment =>
  legacy(id, {
    endpoint: null,
    alwaysOn: true,
    public: true,
    versions: [{ version: 1, createdAt: 0, entrypoint: "node s.js", snapshotDir: "/snap" }],
  });

test(
  "deployments backfill with their access times and keep a duplicate name on the oldest deployment",
  { skip },
  async () => {
    await withTypedTableDb(
      stores,
      async ({ store, tenant, admin }) => {
        await withTenant(tenant, async () => {
          const s = store.make(0);
          assert.deepEqual(await s.get("dep-a"), { ...legacy("dep-a"), lastAccessAt: 4_242 });
          assert.deepEqual(await s.get("dep-b"), { ...older("dep-b"), name: "doubled" });
          assert.equal((await s.getByName("doubled"))!.id, "dep-b");
        });
        const { rows } = await admin.query(
          `SELECT to_regclass('deployment_access') AS access, to_regclass('deployments_kv') AS kv,
                (SELECT count(*)::int FROM app_page_views) AS views,
                (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'app_page_views_deployment_fkey') AS fk`,
        );
        assert.deepEqual(rows[0], {
          access: null,
          kv: null,
          views: 1,
          fk: "FOREIGN KEY (tenant_id, deployment_id) REFERENCES deployments(tenant_id, id) ON DELETE CASCADE",
        });
      },
      async (admin) => {
        await seedKeyValueTable(admin, "deployments", {
          "dep-a": legacy("dep-a", { name: "doubled" }),
          "dep-b": { ...older("dep-b"), name: "doubled" },
        });
        await admin.query(
          `CREATE TABLE deployment_access (id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
           last_access_at BIGINT NOT NULL)`,
        );
        await admin.query("INSERT INTO deployment_access VALUES ('dep-a', 4242)");
        await admin.query(
          `CREATE TABLE app_page_views(id BIGSERIAL PRIMARY KEY, deployment_id TEXT NOT NULL REFERENCES deployments(id),
           version INTEGER, viewer TEXT, auth_mode TEXT NOT NULL, at BIGINT NOT NULL, path TEXT NOT NULL, ip TEXT,
           user_agent TEXT)`,
        );
        await admin.query(
          "INSERT INTO app_page_views(deployment_id, auth_mode, at, path) VALUES ('dep-a', 'public', 1, '/')",
        );
      },
    );
  },
);

test("deploy search reads typed columns through its GIN index inside one tenant", { skip }, async () => {
  const search = (url: string) => ({ ...stores(url), search: createPostgresResourceSearch(createPgPool(url)) });
  await withTypedTableDb(search, async ({ store, tenant, otherTenant, admin }) => {
    await withTenant(tenant, () =>
      store.rows[0]!.put("hit", legacy("hit", { name: "zanzibar", displayName: "Release checklist" })),
    );
    await withTenant(otherTenant, async () => {
      assert.deepEqual(await store.search.search("deploys", "zanz release", 50), []);
    });
    await withTenant(tenant, async () => {
      const rows = await store.search.search("deploys", "zanz release", 50);
      assert.deepEqual(rows, [
        {
          id: "hit",
          title: "Release checklist",
          description: "zanzibar",
          ownerScopeId: "personal:U1",
          createdInScope: null,
          createdBy: "U1",
          status: "running",
        },
      ]);
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan=off");
        const vector = "to_tsvector('simple', coalesce(display_name, name, '') || ' ' || coalesce(name, ''))";
        const plan = await client.query(
          `EXPLAIN (FORMAT JSON) SELECT id FROM deployments WHERE ${vector} @@ to_tsquery('simple', 'zanz:*')`,
        );
        assert.match(JSON.stringify(plan.rows), /deployments_resource_search_gin/);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  });
});
