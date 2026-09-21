import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Orchestrator } from "../src/core/orchestrator.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createWorkCapacity } from "../src/runs/work-capacity.ts";
import { createWorker, type Worker } from "../src/runs/worker.ts";
import { withTimeout } from "../src/util/async.ts";

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

test(
  "postgres: a locked tenant cannot retain shared work capacity and recovers after its table unlocks",
  { skip: !process.env.DATABASE_URL, timeout: 20_000 },
  async (t) => {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const suffix = randomUUID().replaceAll("-", "");
    const names = [`capacity_blocked_${suffix}`, `capacity_healthy_${suffix}`];
    const created: string[] = [];
    const runtimes: ReturnType<typeof createPostgresRunStore>[] = [];
    const workers: Worker[] = [];
    let holder: import("pg").PoolClient | undefined;
    let lockPool: Pool | undefined;
    const warnings: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      for (const name of names) {
        await admin.query(`CREATE DATABASE ${name}`);
        created.push(name);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${name}`;
        runtimes.push(createPostgresRunStore(url.toString()));
        if (!lockPool) lockPool = new pg.Pool({ connectionString: url.toString() });
      }
      const blocked = runtimes[0]!;
      const healthy = runtimes[1]!;
      const blockedRun = (await blocked.runs.enqueue({ sessionId: "same", request })).run;
      const healthyRun = (await healthy.runs.enqueue({ sessionId: "same", request })).run;
      holder = await lockPool!.connect();
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE runs IN ACCESS EXCLUSIVE MODE");
      await Promise.all(
        [
          blocked.runs.claim("probe", 10_000),
          blocked.runs.claimById(blockedRun.id, "probe", 10_000),
          blocked.runs.claimForSession("same", "probe", 10_000),
        ].map((claim) => assert.rejects(claim, { code: "57014" })),
      );
      const capacity = createWorkCapacity(1);
      const blockedClaimStarted = Promise.withResolvers<void>();
      const healthyStarted = Promise.withResolvers<void>();
      const recovered = Promise.withResolvers<void>();
      const claim = blocked.runs.claim.bind(blocked.runs);
      t.mock.method(blocked.runs, "claim", (...args: Parameters<typeof claim>) => {
        blockedClaimStarted.resolve();
        return claim(...args);
      });
      workers.push(
        ...runtimes.map((runtime, index) =>
          createWorker({
            capacity: createWorkCapacity(1, capacity),
            runs: runtime.runs,
            sessions: createMemorySessionStore(),
            leaseTtlMs: 10_000,
            pollMs: 250,
            orchestrator: {
              async handleTurn() {
                if (index === 0) recovered.resolve();
                else healthyStarted.resolve();
                return { status: "ok", reply: "done" };
              },
            } as unknown as Orchestrator,
          }),
        ),
      );
      const startedAt = performance.now();
      workers[0]!.start();
      await blockedClaimStarted.promise;
      workers[1]!.start();
      await withTimeout(() => healthyStarted.promise, 5_000, "healthy tenant run");
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed >= 1_000 && elapsed < 5_000);
      assert.equal(warnings.filter((line) => line.includes("worker: claim failed")).length, 1);
      await holder.query("ROLLBACK");
      await withTimeout(() => recovered.promise, 5_000, "blocked tenant recovery");
      await Promise.all([blocked.runs.waitFor(blockedRun.id, 5_000), healthy.runs.waitFor(healthyRun.id, 5_000)]);
      assert.equal((await blocked.runs.get(blockedRun.id))?.attempts, 1);
      assert.equal((await healthy.runs.get(healthyRun.id))?.attempts, 1);
    } finally {
      await holder?.query("ROLLBACK");
      holder?.release();
      await Promise.all(workers.map((worker) => worker.stop()));
      await Promise.all(runtimes.map((runtime) => runtime.close()));
      await lockPool?.end();
      for (const name of created) await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  },
);
