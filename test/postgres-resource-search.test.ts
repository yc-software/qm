import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import {
  CRON_SEARCH_DESCRIPTION,
  CRON_SEARCH_TITLE,
  WEBHOOK_SEARCH_DESCRIPTION,
  WEBHOOK_SEARCH_TITLE,
  createPostgresResourceSearch,
} from "../src/search/resource-search.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createPostgresCronRows } from "../src/cron/cron-table.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createPostgresWebhookRows } from "../src/webhooks/webhook-table.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { withTypedTableDb } from "./support/typed-table.ts";
import { testCronFires } from "./support/typed-stores.ts";

const database = process.env.DATABASE_URL;
test(
  "resource GIN indexes match real queries, exclude heavy fields, and track writes",
  { skip: !database },
  async () => {
    const admin = createPgPool(database!);
    const schema = `search_${randomUUID().replaceAll("-", "")}`;
    await admin.q(`CREATE SCHEMA ${schema}`);
    const url = new URL(database!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pg = createPgPool(url.toString());
    try {
      let searchSql = "";
      let searchParams: unknown[] = [];
      const store = createPostgresResourceSearch({
        ...pg,
        q: async (sql, params, options) => {
          if (sql.includes("@@ to_tsquery")) {
            searchSql = sql;
            searchParams = params ?? [];
          }
          return pg.q(sql, params, options);
        },
      });
      for (const kind of ["skills", "deploys"] as const) await store.search(kind, "zanzibar", 50);
      for (const [table, record] of [
        [
          "skills",
          {
            manifest: {
              name: "zanzibar-review",
              description: "release checklist",
              body: "privatebody ".repeat(10000),
              files: [{ content: "asset".repeat(10000) }],
            },
          },
        ],
        [
          "deployments",
          {
            name: "zanzibar",
            displayName: "Release checklist",
            versions: [{ files: "version ".repeat(10000) }],
            endpoint: { secret: "never return" },
          },
        ],
      ] as const) {
        await pg.q(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [
          "hit",
          JSON.stringify({ id: "hit", ...record, owner: "U1", ownerScopeId: "personal:U1", scopeId: "personal:U1" }),
        ]);
        const kind = table === "deployments" ? "deploys" : table;
        const rows = await store.search(kind, "zanz release", 50);
        const actualSql = searchSql;
        const actualParams = searchParams;
        assert.equal(rows.length, 1);
        assert.ok(JSON.stringify(rows).length < 1000);
        assert.equal(JSON.stringify(rows).includes("never return"), false);
        assert.equal((await store.search(kind, "privatebody", 50)).length, 0);
        assert.equal((await store.search(kind, "' | &", 50)).length, 0);
        const indexes = await pg.q(
          "SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 AND indexname LIKE '%resource_search_gin'",
          [schema, table],
        );
        assert.equal(indexes.length, 1);
        const client = await (await pg.pool()).connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL enable_seqscan=off");
          const plan = await client.query(`EXPLAIN (FORMAT JSON) ${actualSql}`, actualParams);
          assert.match(JSON.stringify(plan.rows), /resource_search_gin/);
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
        await pg.q(`UPDATE ${table} SET json = $1 WHERE id = 'hit'`, [
          JSON.stringify({ id: "hit", title: "other", action: "other", name: "other", manifest: { name: "other" } }),
        ]);
        assert.equal((await store.search(kind, "zanzibar", 50)).length, 0);
      }
    } finally {
      await pg.close();
      await admin.q(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  },
);

function searchStores(url: string) {
  const cronRows = createPostgresCronRows(url);
  const webhookRows = createPostgresWebhookRows(url);
  const pool = createPgPool(url);
  return {
    crons: createCronStore(cronRows, { fires: testCronFires() }),
    webhooks: createWebhookStore(webhookRows),
    search: createPostgresResourceSearch(pool),
    async close() {
      await Promise.all([cronRows.close(), webhookRows.close(), pool.close()]);
    },
  };
}

test(
  "cron and webhook search reads typed columns, stays inside the tenant and uses the GIN indexes",
  { skip: !database },
  async () => {
    await withTypedTableDb(searchStores, async ({ store, admin, tenant, otherTenant }) => {
      const owner = { owner: "U1", createdBy: "U1", ownerScopeId: scopeId("personal", "U1") };
      const seed = async (title: string) => {
        await store.crons.create({ ...owner, schedule: { everyMs: 60_000 }, title, action: "release checklist" });
        await store.webhooks.create({
          ...owner,
          action: `${title} release checklist`,
          verification: { scheme: "github", secret: "never return" },
        });
      };
      await withTenant(otherTenant, () => seed("zanzibar elsewhere"));
      await withTenant(tenant, async () => {
        await seed("zanzibar digest");
        for (const kind of ["crons", "webhooks"] as const) {
          const rows = await store.search.search(kind, "zanz release", 50);
          assert.equal(rows.length, 1, kind);
          assert.equal(rows[0]!.ownerScopeId, "personal:U1");
          assert.match(rows[0]!.title, /zanzibar digest/);
          assert.equal(JSON.stringify(rows).includes("never return"), false);
          assert.equal((await store.search.search(kind, "' | &", 50)).length, 0);
        }
      });
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan=off");
        for (const [table, title, description] of [
          ["crons", CRON_SEARCH_TITLE, CRON_SEARCH_DESCRIPTION],
          ["webhooks", WEBHOOK_SEARCH_TITLE, WEBHOOK_SEARCH_DESCRIPTION],
        ]) {
          const plan = await client.query(
            `EXPLAIN (FORMAT JSON) SELECT id FROM ${table} WHERE to_tsvector('simple', ${title} || ' ' || ${description}) @@ to_tsquery('simple', 'zanz:*')`,
          );
          assert.match(JSON.stringify(plan.rows), new RegExp(`${table}_resource_search_gin`));
        }
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  },
);
