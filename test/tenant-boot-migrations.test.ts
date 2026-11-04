import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPgBossCronQueue, migrateCronQueue, type CronFireJob } from "../src/cron/job-queue.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createMemoryVectorIndexer } from "../src/memory/vector-indexer.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { TENANT_A, TENANT_B, twoTenantDatabase, twoTenantTestSkip } from "./support/two-tenants.ts";

test(
  "the app login runs the cron queue that the owner installed, without pg-boss DDL",
  { skip: twoTenantTestSkip() },
  async () => {
    const db = await twoTenantDatabase(() => undefined);
    const schema = `pgboss_t${Date.now().toString(36)}`;
    const role = new URL(db.appUrl).username;
    const queue = createPgBossCronQueue(db.appUrl, schema);
    try {
      await migrateCronQueue(db.ownerUrl, schema);
      await db.owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await db.owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      await db.owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
      await db.owner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
      const app = new pg.Pool({ connectionString: db.appUrl, max: 1 });
      const canCreate = await app.query("SELECT has_schema_privilege($1, 'CREATE') AS ok", [schema]);
      await app.end();
      assert.equal(canCreate.rows[0].ok, false);
      const fired: CronFireJob[] = [];
      await queue.start({ onFire: async (job) => void fired.push(job) });
      await queue.enqueueFire({ tenantId: TENANT_B, cronId: "cron-b", scheduledAt: Date.now() });
      const deadline = Date.now() + 15_000;
      while (!fired.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(
        fired.map((job) => [job.tenantId, job.cronId]),
        [[TENANT_B, "cron-b"]],
      );
    } finally {
      await queue.stop();
      await db.owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.close();
    }
  },
);

test(
  "the memory vector indexer resolves each tenant's embedder under that tenant and indexes only its facts",
  { skip: twoTenantTestSkip() },
  async () => {
    const db = await twoTenantDatabase((url) => {
      createPostgresMemoryService(url);
      createPostgresVectorStore(url);
    });
    await db.owner.query(
      `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT '${TENANT_A}'::uuid $f$`,
    );
    const memory = createPostgresMemoryService(db.appUrl);
    const store = createPostgresVectorStore(db.appUrl);
    const scope = "personal:vector-tenants";
    try {
      await withTenant(TENANT_A, () => memory.capture(scope, ["tenant a fact"], Date.now()));
      await withTenant(TENANT_B, () => memory.capture(scope, ["tenant b fact"], Date.now()));
      const resolvedFor: Array<string | undefined> = [];
      const indexer = createMemoryVectorIndexer({
        resolve: async () => {
          resolvedFor.push(boundTenant());
          if (boundTenant() !== TENANT_A) return undefined;
          return { store, embedder: { id: "tenant-a-model", embed: async (texts) => texts.map(() => [1, 0]) } };
        },
        eachTenant: (fn) => store.eachTenant(fn),
        leaderLease: createNoopLeaderLease(),
        onError: (error) => assert.fail(error instanceof Error ? error : String(error)),
      });
      await indexer.tick();
      assert.ok(resolvedFor.includes(TENANT_A) && resolvedFor.includes(TENANT_B));
      assert.ok(!resolvedFor.includes(undefined));
      const { rows } = await db.owner.query(
        "SELECT tenant_id::text AS tenant, model FROM memory_fact_vectors WHERE scope_id = $1",
        [scope],
      );
      assert.deepEqual(rows, [{ tenant: TENANT_A, model: "tenant-a-model" }]);
    } finally {
      await store.close();
      await db.close();
    }
  },
);
