import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresResourceSearch } from "../src/search/resource-search.ts";

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
      for (const kind of ["skills", "crons", "deploys", "webhooks"] as const) await store.search(kind, "zanzibar", 50);
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
          "crons",
          { title: "zanzibar digest", action: "release checklist", fireLog: [{ note: "history ".repeat(10000) }] },
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
        [
          "webhooks",
          { action: "zanzibar release checklist", verification: { scheme: "github", secret: "never return" } },
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
