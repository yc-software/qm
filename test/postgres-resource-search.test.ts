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
