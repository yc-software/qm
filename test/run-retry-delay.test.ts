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
        assert.equal(await runs.claimForSession(sessionId, "inline-worker", 60_000), null);
        const unrelated = await runs.claim("worker-2", 60_000);
        assert.equal(unrelated?.id, other.id);
        await runs.complete(other.id, unrelated!.leaseToken!, { status: "ok", sessionId: other.sessionId });
        t.mock.timers.tick(29_999);
        assert.equal(await runs.claim("worker-3", 60_000), null);
        t.mock.timers.tick(1);
        assert.equal(await runs.claimById(later.id, "inline-worker", 60_000), null);
        const retried = await runs.claimForSession(sessionId, "worker-3", 60_000);
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

  test(
    `${backend}: failed returns wait durably without delaying new work or acknowledging results`,
    { skip: backend === "postgres" && !process.env.DATABASE_URL },
    async (t) => {
      let connectionString = process.env.DATABASE_URL!;
      let admin: Pool | undefined;
      const schema = `return_retry_${randomUUID().replaceAll("-", "")}`;
      if (backend === "postgres") {
        const pg = (await import("pg")).default;
        admin = new pg.Pool({ connectionString });
        await admin.query(`CREATE SCHEMA ${schema}`);
        const url = new URL(connectionString);
        url.searchParams.set("options", `-c search_path=${schema}`);
        connectionString = url.toString();
      }
      let { runs } = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(connectionString);
      try {
        const child = (await runs.enqueue({ sessionId: `agent:main:subagent:${randomUUID()}`, request })).run;
        await runs.deferReturn(child.id, 60_000);
        const lease = await runs.claimById(child.id, "worker", 60_000);
        assert.ok(lease?.leaseToken);
        await runs.complete(child.id, lease.leaseToken, { status: "ok", reply: "saved result" });
        const completed = await runs.get(child.id);
        const wake = (await runs.enqueue({ sessionId: randomUUID(), request, dedupKey: `subagent-return:${child.id}` }))
          .run;
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        await runs.deferReturn(child.id, 60_000);
        if (backend === "postgres") {
          await runs.close?.();
          runs = createPostgresRunStore(connectionString).runs;
        }
        assert.deepEqual(await runs.pendingReturns(), []);
        assert.deepEqual(await runs.get(child.id), completed);
        const fresh = (await runs.enqueue({ sessionId: `agent:main:subagent:${randomUUID()}`, request })).run;
        const freshLease = await runs.claimById(fresh.id, "worker", 60_000);
        await runs.fail(fresh.id, freshLease!.leaseToken!, "failed task", { retry: false });
        assert.deepEqual(
          (await runs.pendingReturns()).map((run) => run.id),
          [fresh.id],
        );
        await runs.deferReturn(fresh.id, 60_000);
        t.mock.timers.tick(59_999);
        assert.deepEqual(await runs.pendingReturns(), []);
        t.mock.timers.tick(1);
        assert.equal((await runs.pendingReturns()).length, 2);
        await runs.markReturned(child.id);
        await runs.deferReturn(child.id, 60_000);
        assert.ok(!(await runs.pendingReturns()).some((run) => run.id === child.id));
        t.mock.timers.tick(60_000);
        assert.ok((await runs.pendingReturns()).some((run) => run.id === child.id));
        await runs.withdraw(wake.id, { unstartedOnly: true });
        assert.deepEqual(
          (await runs.pendingReturns()).map((run) => run.id),
          [fresh.id],
        );
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

test(
  "postgres: latest session history uses its ordered index and excludes private messages",
  {
    skip: !process.env.DATABASE_URL,
  },
  async () => {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `run_history_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const runtime = createPostgresRunStore(url.toString());
    const pool = new pg.Pool({ connectionString: url.toString() });
    try {
      const sessionId = randomUUID();
      const publicRun = (await runtime.runs.enqueue({ sessionId, request })).run;
      const privateRun = (
        await runtime.runs.enqueue({ sessionId, request: { ...request, privateSessionMessage: true } })
      ).run;
      await pool.query("UPDATE runs SET created_at = 1 WHERE session_id = $1", [sessionId]);
      assert.equal((await runtime.runs.latestForThread(sessionId))?.id, privateRun.id);
      assert.equal((await runtime.runs.latestForThread(sessionId, { excludePrivateMessages: true }))?.id, publicRun.id);
      const client = await pool.connect();
      try {
        await client.query("SET enable_seqscan = off");
        const { rows } = await client.query(
          "EXPLAIN (FORMAT JSON) SELECT * FROM runs WHERE session_id = $1 AND COALESCE(request::jsonb->>'privateSessionMessage', 'false') <> 'true' ORDER BY created_at DESC, seq DESC LIMIT 1",
          [sessionId],
        );
        const plan = JSON.stringify(rows);
        assert.match(plan, /idx_runs_session_created_seq/);
        assert.doesNotMatch(plan, /"Node Type":"Sort"/);
        const recent = await client.query(
          "EXPLAIN (FORMAT JSON) SELECT * FROM runs ORDER BY created_at DESC LIMIT 500",
        );
        assert.match(JSON.stringify(recent.rows), /idx_runs_created/);
        assert.doesNotMatch(JSON.stringify(recent.rows), /"Node Type":"Sort"/);
      } finally {
        client.release();
      }
    } finally {
      await runtime.close();
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  },
);

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
