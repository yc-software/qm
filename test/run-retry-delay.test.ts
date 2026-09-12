import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

const request: OrchestratorInput = {
  actor: { id: "retry-test", type: "internal" },
  conversation: { kind: "dm", threadRef: "retry-test", audience: [] },
  origin: { kind: "direct" },
  text: "test",
};

for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend}: retry deadline is respected across claim paths and preserves session order`,
    {
      skip: backend === "postgres" && !process.env.DATABASE_URL,
    },
    async (t) => {
      let connectionString = process.env.DATABASE_URL!;
      let admin: Pool | undefined;
      const schema = `retry_${randomUUID().replaceAll("-", "")}`;
      if (backend === "postgres") {
        const pg = (await import("pg")).default;
        admin = new pg.Pool({ connectionString });
        await admin.query(`CREATE SCHEMA ${schema}`);
        const url = new URL(connectionString);
        url.searchParams.set("options", `-c search_path=${schema}`);
        connectionString = url.toString();
      }
      const runtime = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(connectionString);
      let { runs } = runtime;
      const sessionId = randomUUID();
      try {
        const first = (await runs.enqueue({ sessionId, request })).run;
        const lease = await runs.claimById(first.id, "worker-1", 60_000);
        assert.ok(lease?.leaseToken);
        const now = Date.now();
        t.mock.timers.enable({ apis: ["Date"], now });
        await runs.fail(first.id, lease.leaseToken, "temporary outage", { retryAfterMs: 30_000 });
        if (backend === "postgres") {
          await runs.close?.();
          runs = createPostgresRunStore(connectionString).runs;
        }
        const later = (await runs.enqueue({ sessionId, request })).run;
        const other = (await runs.enqueue({ sessionId: randomUUID(), request })).run;
        assert.equal(await runs.claimById(first.id, "worker-2", 60_000), null);
        assert.equal(await runs.claimById(later.id, "worker-2", 60_000), null);
        const unrelated = await runs.claim("worker-2", 60_000);
        assert.equal(unrelated?.id, other.id);
        await runs.complete(other.id, unrelated!.leaseToken!, { status: "ok", sessionId: other.sessionId });
        t.mock.timers.tick(29_999);
        assert.equal(await runs.claim("worker-3", 60_000), null);
        t.mock.timers.tick(1);
        const retried = await runs.claim("worker-3", 60_000);
        assert.equal(retried?.id, first.id);
        assert.equal(retried?.attempts, 2);
        assert.equal(retried?.errorAttempts, 1);
        await runs.complete(first.id, retried!.leaseToken!, { status: "ok", sessionId });
        const next = await runs.claim("worker-3", 60_000);
        assert.equal(next?.id, later.id);
        await runs.complete(later.id, next!.leaseToken!, { status: "ok", sessionId });
      } finally {
        t.mock.timers.reset();
        await runs.close?.();
        if (admin) {
          try {
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          } finally {
            await admin.end();
          }
        }
      }
    },
  );
}

test("memory: one claim uses one clock snapshot across the retry boundary", async (t) => {
  const { runs } = createMemoryRunStore();
  const first = (await runs.enqueue({ sessionId: "same", request })).run;
  const claimed = await runs.claim("w1", 60_000);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await runs.fail(first.id, claimed!.leaseToken!, "temporary", { retryAfterMs: 1_000 });
  await runs.enqueue({ sessionId: "same", request });
  let reads = 0;
  t.mock.method(Date, "now", () => now + (++reads === 1 ? 999 : 1_000));
  assert.equal(await runs.claim("w2", 60_000), null);
  assert.equal((await runs.claim("w2", 60_000))?.id, first.id);
});

test(
  "postgres: retry migration bounds lock waiting and can be retried",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pg = (await import("pg")).default;
    const { applyPgMigrations, registeredPgMigrations } = await import("../src/persistence/pg-pool.ts");
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `retry_lock_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000`);
    const runtime = createPostgresRunStore(url.toString());
    const pool = new pg.Pool({ connectionString: url.toString() });
    const holder = await pool.connect();
    try {
      const migrations = registeredPgMigrations(url.toString());
      await applyPgMigrations(
        pool,
        migrations.filter((m) => m.id !== "runs/store/0004"),
      );
      await holder.query("BEGIN");
      await holder.query("SELECT * FROM runs");
      await assert.rejects(applyPgMigrations(pool, migrations), { code: "55P03" });
      assert.equal((await pool.query("SELECT count(*) FROM runs")).rows[0].count, "0");
      await holder.query("ROLLBACK");
      await applyPgMigrations(pool, migrations);
      await applyPgMigrations(pool, migrations);
      await pool.query("SELECT retry_after FROM runs");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await runtime.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
