import { isolatedPostgres } from "./support/isolated-postgres.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import { createWorker } from "../src/runs/worker.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";

const actor = { id: "internal:U1", type: "internal" as const };
const request: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "availability", audience: [actor] },
  origin: { kind: "direct" },
  text: "availability",
};
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition reached before deadline");
    await sleep(5);
  }
}

for (const duringClaim of [false, true]) {
  test(`notification wakes idle worker without a lost wakeup (during claim: ${duringClaim})`, async () => {
    const { runs } = createMemoryRunStore();
    const bus = createMemoryEventBus<null>("availability test");
    runs.subscribeAvailable = (listener, options) => {
      const off = bus.subscribe(listener, options);
      options?.onResync?.();
      return off;
    };
    const claim = runs.claim.bind(runs);
    let claims = 0;
    let finished = false;
    runs.claim = async (...args) => {
      claims++;
      const result = await claim(...args);
      if (duringClaim && claims === 1) {
        await runs.enqueue({ sessionId: "availability", request });
        bus.emit(null);
      }
      return result;
    };
    const worker = createWorker({
      runs,
      sessions: createMemorySessionStore(),
      orchestrator: {
        handleTurn: async () => {
          finished = true;
          return { status: "ok", sessionId: "availability" };
        },
      } as unknown as Orchestrator,
      leaseTtlMs: 5_000,
      pollMs: 10,
      recoveryPollMs: 10_000,
    });
    worker.start();
    try {
      if (!duringClaim) {
        await until(() => claims === 1);
        await sleep(100);
        assert.equal(claims, 1, "healthy idle listener does not repeatedly claim");
        await runs.enqueue({ sessionId: "availability", request });
        bus.emit(null);
      }
      await until(() => finished);
    } finally {
      await worker.stop();
    }
    assert.equal(bus.size(), 0);
  });
}

test("missed notifications recover and reconnect checks immediately", async () => {
  const { runs } = createMemoryRunStore();
  const bus = createMemoryEventBus<null>("availability test");
  runs.subscribeAvailable = (listener, options) => {
    const off = bus.subscribe(listener, options);
    options?.onResync?.();
    return off;
  };
  let claims = 0;
  runs.claim = async () => {
    claims++;
    return null;
  };
  const worker = createWorker({
    runs,
    sessions: createMemorySessionStore(),
    orchestrator: {} as Orchestrator,
    leaseTtlMs: 5_000,
    pollMs: 10,
    recoveryPollMs: 200,
  });
  worker.start();
  try {
    await until(() => claims >= 2);
    bus.resync();
    const reconnectClaims = claims;
    await until(() => claims > reconnectClaims);
    const healthyClaims = claims;
    await sleep(50);
    assert.equal(claims, healthyClaims);
  } finally {
    await worker.stop();
  }
});

test(
  "Postgres notifies across stores for enqueue, unblock, retry, release and reconnect",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const { url, admin, cleanup } = await isolatedPostgres();
    const writer = createPostgresRunStore(url);
    const reader = createPostgresRunStore(url);
    let notifications = 0;
    let resyncs = 0;
    const off = reader.runs.subscribeAvailable!(() => notifications++, {
      pollMs: 60_000,
      onResync: () => resyncs++,
    });
    const ids: string[] = [];
    try {
      await writer.runs.list();
      await until(() => resyncs === 1);
      const sessionId = randomUUID();
      const enqueue = async (): Promise<void> => {
        const before = notifications;
        ids.push((await writer.runs.enqueue({ sessionId, request })).run.id);
        await until(() => notifications > before);
      };
      await enqueue();
      let claimed = await writer.runs.claimById(ids[0]!, "test", 5_000);
      assert.ok(claimed);
      await enqueue();
      assert.equal(await reader.runs.claimById(ids[1]!, "test2", 5_000), null);
      let before = notifications;
      await writer.runs.complete(claimed.id, claimed.leaseToken!, { status: "ok", sessionId });
      await until(() => notifications > before);
      claimed = await reader.runs.claimById(ids[1]!, "test2", 5_000);
      assert.ok(claimed);
      before = notifications;
      await writer.runs.fail(claimed.id, claimed.leaseToken!, "retry", { retryAfterMs: 0 });
      await until(() => notifications > before);
      claimed = await reader.runs.claimById(ids[1]!, "test2", 5_000);
      assert.ok(claimed);
      before = notifications;
      await writer.runs.releaseLease(claimed.id, claimed.leaseToken!);
      await until(() => notifications > before);
      claimed = await reader.runs.claimById(ids[1]!, "test2", 5_000);
      assert.ok(claimed);
      before = notifications;
      await writer.runs.fail(claimed.id, claimed.leaseToken!, "terminal", { retry: false });
      await until(() => notifications > before);
      await enqueue();
      claimed = await reader.runs.claimById(ids[2]!, "expired", 1);
      assert.ok(claimed);
      await admin.query(
        "UPDATE absurd.r_qm_runs SET claim_expires_at=absurd.current_time()-interval '1 second' WHERE run_id=$1",
        [claimed.leaseToken],
      );
      before = notifications;
      await writer.runs.claim("native-recovery", 5_000);
      assert.equal((await writer.runs.get(claimed.id))?.status, "pending");
      await until(() => notifications > before);
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND query='LISTEN qm_run_available' AND application_name=$1",
        [new URL(url).searchParams.get("application_name")],
      );
      ids.push((await writer.runs.enqueue({ sessionId, request })).run.id);
      await until(() => resyncs === 2);
      await enqueue();
    } finally {
      off();
      await reader.close();
      await writer.close();
      await cleanup();
    }
  },
);

test(
  "Postgres workers pick up new runs promptly and preserve single claims under contention",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const { url, cleanup } = await isolatedPostgres();
    const writer = createPostgresRunStore(url);
    const reader = createPostgresRunStore(url);
    const prefix = randomUUID();
    const observed = new Map<string, number>();
    const enqueueTimes = new Map<string, number>();
    const latencies: number[] = [];
    const claim = reader.runs.claim.bind(reader.runs);
    let claims = 0;
    reader.runs.claim = async (...args) => {
      claims++;
      return claim(...args);
    };
    const workers = Array.from({ length: 2 }, () =>
      createWorker({
        runs: reader.runs,
        sessions: createMemorySessionStore(),
        orchestrator: {
          handleTurn: async (input: OrchestratorInput) => {
            const id = input.conversation.threadRef;
            observed.set(id, (observed.get(id) ?? 0) + 1);
            latencies.push(performance.now() - enqueueTimes.get(id)!);
            return { status: "ok", sessionId: id };
          },
        } as unknown as Orchestrator,
        leaseTtlMs: 5_000,
        pollMs: 60_000,
      }),
    );
    try {
      await writer.runs.list();
      for (const worker of workers) worker.start();
      await until(() => claims >= 2);
      await sleep(100);
      const before = claims;
      await sleep(1_000);
      assert.equal(claims, before, "idle workers issue no claim queries between recovery polls");
      for (let i = 0; i < 20; i++) {
        const sessionId = `${prefix}-${i}`;
        enqueueTimes.set(sessionId, performance.now());
        await writer.runs.enqueue({
          sessionId,
          request: { ...request, conversation: { ...request.conversation, threadRef: sessionId } },
        });
        await until(() => observed.has(sessionId));
      }
      assert.equal(observed.size, 20);
      assert.ok([...observed.values()].every((count) => count === 1));
      latencies.sort((a, b) => a - b);
      t.diagnostic(
        `enqueue-to-handler latency, local Postgres: p50=${latencies[9]!.toFixed(1)}ms, p95=${latencies[18]!.toFixed(1)}ms, max=${latencies[19]!.toFixed(1)}ms`,
      );
      assert.ok(latencies[19]! < 1_000, "pickup does not wait for the five-second recovery poll");
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
      await reader.close();
      await writer.close();
      await cleanup();
    }
  },
);

test(
  "shared watchdog preserves retry deadlines and catches missing notifications",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const { url, cleanup } = await isolatedPostgres();
    const writer = createPostgresRunStore(url);
    const reader = createPostgresRunStore(url);
    const direct = new pg.Pool({ connectionString: url });
    const observed: Array<{ id: string; at: number }> = [];
    const workers = Array.from({ length: 16 }, () =>
      createWorker({
        runs: reader.runs,
        sessions: createMemorySessionStore(),
        orchestrator: {
          handleTurn: async (input: OrchestratorInput) => {
            observed.push({ id: input.text, at: Date.now() });
            return { status: "ok", sessionId: "scheduled" };
          },
        } as unknown as Orchestrator,
        leaseTtlMs: 5_000,
        pollMs: 250,
      }),
    );
    try {
      const first = (await writer.runs.enqueue({ sessionId: "scheduled", request: { ...request, text: "first" } })).run;
      const claimed = await writer.runs.claimById(first.id, "setup", 5_000);
      await writer.runs.fail(first.id, claimed!.leaseToken!, "transient", { retryAfterMs: 500 });
      const { rows } = await direct.query(
        "SELECT extract(epoch FROM execution.available_at)*1000 AS deadline FROM absurd.r_qm_runs execution JOIN runs ON runs.workflow_task_id=execution.task_id WHERE runs.id=$1 AND execution.state IN ('pending','sleeping')",
        [first.id],
      );
      const deadline = Number(rows[0].deadline);
      await writer.runs.enqueue({ sessionId: "scheduled", request: { ...request, text: "second" } });
      for (const worker of workers) worker.start();
      await until(() => observed.length === 2);
      assert.deepEqual(
        observed.map(({ id }) => id),
        ["first", "second"],
      );
      assert.ok(observed[0]!.at >= deadline, "retry never claims before its deadline");
      assert.ok(
        observed[0]!.at - deadline < 750,
        "deadline pickup uses the watchdog, not five-second recovery polling",
      );
      const insertedAt = Date.now();
      const missedId = randomUUID();
      const client = await direct.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO runs(id,session_id,status,request,created_at) VALUES($1,$2,'pending',$3,$4)", [
          missedId,
          "missed",
          JSON.stringify({ ...request, text: "missed" }),
          insertedAt,
        ]);
        const spawned = await client.query("SELECT * FROM absurd.spawn_task('qm_runs','run.execute',$1)", [
          JSON.stringify({ runId: missedId }),
        ]);
        await client.query("UPDATE runs SET workflow_task_id=$2 WHERE id=$1", [missedId, spawned.rows[0].task_id]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await until(() => observed.length === 3);
      assert.equal(observed[2]!.id, "missed");
      assert.ok(observed[2]!.at - insertedAt < 750, "missing NOTIFY retains the original polling cadence");
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
      await reader.close();
      await writer.close();
      await direct.end();
      await cleanup();
    }
  },
);

test(
  "Postgres claims preserve a locked session head while other sessions progress",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const { url, cleanup } = await isolatedPostgres();
    const runtime = createPostgresRunStore(url);
    const pool = new pg.Pool({ connectionString: url });
    const holder = await pool.connect();
    try {
      const first = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
      const second = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
      const other = (await runtime.runs.enqueue({ sessionId: "independent", request })).run;
      await pool.query("UPDATE runs SET created_at = 1 WHERE session_id = 'ordered'");
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [first.id]);
      const claimedOther = await runtime.runs.claim("other-worker", 5_000);
      assert.equal(claimedOther?.id, other.id, "a locked head blocks its siblings without blocking another session");
      assert.equal(await runtime.runs.claim("waiting-worker", 5_000), null);
      assert.equal(await runtime.runs.claimById(second.id, "inline-worker", 5_000), null);
      assert.equal(await runtime.runs.claimForSession("ordered", "inline-worker", 5_000), null);
      await holder.query("ROLLBACK");
      const claimedFirst = await runtime.runs.claimForSession("ordered", "head-worker", 5_000);
      assert.equal(claimedFirst?.id, first.id);
      assert.equal(await runtime.runs.claimById(second.id, "inline-worker", 5_000), null);
      await runtime.runs.complete(first.id, claimedFirst!.leaseToken!, { status: "ok" });
      const claimedSecond = await runtime.runs.claimById(second.id, "inline-worker", 5_000);
      assert.equal(claimedSecond?.id, second.id);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await runtime.close();
      await pool.end();
      await cleanup();
    }
  },
);
