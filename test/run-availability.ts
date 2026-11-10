import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import { createWorker } from "../src/runs/worker.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { seedTestTenant } from "./support/test-tenant.ts";

const actor = { id: "internal:U1", type: "internal" as const };
const request: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "availability", audience: [actor] },
  origin: { kind: "direct" },
  text: "availability",
};
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "condition reached before deadline");
    await sleep(5);
  }
}

async function isolatedPostgres(): Promise<{ url: string; admin: pg.Pool; cleanup(): Promise<void> }> {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
  const schema = `run_availability_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  url.searchParams.set("application_name", schema);
  await seedTestTenant(url.toString());
  return {
    url: url.toString(),
    admin,
    async cleanup() {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

for (const duringClaim of [false, true]) {
  test(`notification wakes idle worker without a lost wakeup (during claim: ${duringClaim})`, async () => {
    const { runs } = createPostgresRunStore(testDatabaseUrl());
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
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const bus = createMemoryEventBus<null>("availability test");
  runs.subscribeAvailable = (listener, options) => {
    const off = bus.subscribe(listener, options);
    options?.onResync?.();
    return off;
  };
  let claims = 0;
  runs.claim = async () => {
    claims++;
    return [];
  };
  const worker = createWorker({
    runs,
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
      onResync: () => void resyncs++,
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
      await writer.runs.fail(claimed.id, claimed.leaseToken!, "retry");
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
      await sleep(5);
      before = notifications;
      assert.equal((await writer.runs.reapExpired()).requeued, 1);
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
  "Postgres workers pick up new runs promptly, preserve single claims under contention, and claim once per process per wakeup",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const { url, cleanup } = await isolatedPostgres();
    const writer = createPostgresRunStore(url);
    const readers = [createPostgresRunStore(url), createPostgresRunStore(url)];
    const prefix = randomUUID();
    const observed = new Map<string, number>();
    const enqueueTimes = new Map<string, number>();
    const latencies: number[] = [];
    let claims = 0;
    for (const reader of readers) {
      const claim = reader.runs.claim.bind(reader.runs);
      reader.runs.claim = async (...args) => {
        claims++;
        return claim(...args);
      };
    }
    const workers = readers.map((reader) =>
      createWorker({
        runs: reader.runs,
        slots: 16,
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
      await until(() => claims >= readers.length * 2);
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
      t.diagnostic(`claim queries per run with two processes of 16 slots: ${((claims - before) / 20).toFixed(1)}`);
      assert.ok(claims - before <= 20 * 6, "each wakeup costs a claim per process, not one per slot");
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
      await Promise.all(readers.map((reader) => reader.close()));
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
    const worker = createWorker({
      runs: reader.runs,
      slots: 16,
      orchestrator: {
        handleTurn: async (input: OrchestratorInput) => {
          observed.push({ id: input.text, at: Date.now() });
          return { status: "ok", sessionId: "scheduled" };
        },
      } as unknown as Orchestrator,
      leaseTtlMs: 5_000,
      pollMs: 250,
    });
    try {
      const first = (await writer.runs.enqueue({ sessionId: "scheduled", request: { ...request, text: "first" } })).run;
      const claimed = await writer.runs.claimById(first.id, "setup", 5_000);
      await writer.runs.fail(first.id, claimed!.leaseToken!, "transient", { retryAfterMs: 500 });
      const { rows } = await direct.query("SELECT retry_after FROM runs WHERE id=$1", [first.id]);
      const deadline = Number(rows[0].retry_after);
      await writer.runs.enqueue({ sessionId: "scheduled", request: { ...request, text: "second" } });
      worker.start();
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
      await direct.query(
        "INSERT INTO runs(id, session_id, status, request, created_at) VALUES($1,$2,'pending',$3,$4)",
        [randomUUID(), "missed", JSON.stringify({ ...request, text: "missed" }), insertedAt],
      );
      await until(() => observed.length === 3);
      assert.equal(observed[2]!.id, "missed");
      assert.ok(observed[2]!.at - insertedAt < 750, "missing NOTIFY retains the original polling cadence");
    } finally {
      await worker.stop();
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
      const claimedOther = (await runtime.runs.claim("other-worker", 5_000))[0] ?? null;
      assert.equal(claimedOther?.id, other.id, "a locked head blocks its siblings without blocking another session");
      assert.equal((await runtime.runs.claim("waiting-worker", 5_000))[0] ?? null, null);
      assert.equal(await runtime.runs.claimById(second.id, "targeted-worker", 5_000), null);
      await holder.query("ROLLBACK");
      const claimedFirst = await runtime.runs.claimById(first.id, "head-worker", 5_000);
      assert.equal(claimedFirst?.id, first.id);
      assert.equal(await runtime.runs.claimById(second.id, "targeted-worker", 5_000), null);
      await runtime.runs.complete(first.id, claimedFirst!.leaseToken!, { status: "ok" });
      const claimedSecond = await runtime.runs.claimById(second.id, "targeted-worker", 5_000);
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

test("one claim fills every free slot, and a freed slot claims the backlog", async () => {
  const { runs, close } = createPostgresRunStore(testDatabaseUrl());
  const batches: number[] = [];
  const claim = runs.claim.bind(runs);
  runs.claim = async (...args) => {
    const claimed = await claim(...args);
    batches.push(claimed.length);
    return claimed;
  };
  const release: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  const worker = createWorker({
    runs,
    slots: 3,
    orchestrator: {
      handleTurn: async (input: OrchestratorInput) => {
        peak = Math.max(peak, ++running);
        await new Promise<void>((resolve) => release.push(resolve));
        running--;
        return { status: "ok", sessionId: input.conversation.threadRef };
      },
    } as unknown as Orchestrator,
    leaseTtlMs: 5_000,
    pollMs: 10,
  });
  try {
    for (let i = 0; i < 5; i++)
      await runs.enqueue({
        sessionId: `slots-${i}`,
        request: { ...request, conversation: { ...request.conversation, threadRef: `slots-${i}` } },
      });
    worker.start();
    await until(() => release.length === 3);
    assert.equal(batches[0], 3, "the first claim takes a run for every free slot");
    assert.equal(worker.held().length, 3);
    release.shift()!();
    release.shift()!();
    await until(() => release.length === 3);
    release.splice(0).forEach((resolve) => resolve());
    await until(() => worker.held().length === 0);
    assert.equal(peak, 3, "never more turns than slots");
    assert.deepEqual(
      (await runs.list()).map((run) => run.status),
      Array.from({ length: 5 }, () => "done"),
    );
  } finally {
    await worker.stop();
    await close();
  }
});

test("a batch claimed as claiming pauses is handed back, and claiming resumes", async () => {
  const { runs, close } = createPostgresRunStore(testDatabaseUrl());
  let open = true;
  let claims = 0;
  const claim = runs.claim.bind(runs);
  runs.claim = async (...args) => {
    const claimed = await claim(...args);
    if (++claims === 1) open = false;
    return claimed;
  };
  const handled: string[] = [];
  const worker = createWorker({
    runs,
    slots: 3,
    canClaim: () => open,
    orchestrator: {
      handleTurn: async (input: OrchestratorInput) => {
        handled.push(input.conversation.threadRef);
        return { status: "ok", sessionId: input.conversation.threadRef };
      },
    } as unknown as Orchestrator,
    leaseTtlMs: 5_000,
    pollMs: 10,
  });
  try {
    for (let i = 0; i < 3; i++)
      await runs.enqueue({
        sessionId: `paused-${i}`,
        request: { ...request, conversation: { ...request.conversation, threadRef: `paused-${i}` } },
      });
    worker.start();
    await until(() => claims === 1);
    await until(async () => (await runs.list()).every((run) => run.status === "pending"));
    assert.equal(handled.length, 0);
    open = true;
    await until(() => handled.length === 3);
  } finally {
    await worker.stop();
    await close();
  }
});

test("a full worker answers wakeups without claim queries and claims again once a slot frees", async () => {
  const { runs, close } = createPostgresRunStore(testDatabaseUrl());
  const bus = createMemoryEventBus<null>("availability test");
  runs.subscribeAvailable = (listener, options) => bus.subscribe(listener, options);
  let claims = 0;
  const claim = runs.claim.bind(runs);
  runs.claim = async (...args) => {
    claims++;
    return claim(...args);
  };
  const release: Array<() => void> = [];
  const worker = createWorker({
    runs,
    slots: 1,
    orchestrator: {
      handleTurn: (input: OrchestratorInput) =>
        new Promise((resolve) =>
          release.push(() => resolve({ status: "ok", sessionId: input.conversation.threadRef })),
        ),
    } as unknown as Orchestrator,
    leaseTtlMs: 5_000,
    pollMs: 10,
    recoveryPollMs: 10_000,
  });
  try {
    for (const threadRef of ["full-a", "full-b"])
      await runs.enqueue({
        sessionId: threadRef,
        request: { ...request, conversation: { ...request.conversation, threadRef } },
      });
    worker.start();
    await until(() => release.length === 1);
    const held = claims;
    for (let i = 0; i < 20; i++) bus.emit(null);
    await sleep(50);
    assert.equal(claims, held, "no claim queries while every slot is busy");
    release.shift()!();
    await until(() => release.length === 1);
    release.shift()!();
    await until(() => worker.held().length === 0);
  } finally {
    await worker.stop();
    await close();
  }
});
