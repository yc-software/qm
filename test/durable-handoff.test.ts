import assert from "node:assert/strict";
import { test } from "node:test";
import { TimeoutError } from "absurd-sdk";
import { createDurableTasks, type DurableTaskContext, type DurableWorker } from "../src/durable/tasks.ts";
import { sleep, withTimeout } from "../src/util/async.ts";
import { isolatedPostgres } from "./support/isolated-postgres.ts";

for (const postgres of [false, true]) {
  test(
    `${postgres ? "Postgres" : "memory"} deployment handoffs replay committed steps without spending retries`,
    { skip: postgres && !process.env.DATABASE_URL },
    async () => {
      const db = postgres ? await isolatedPostgres() : undefined;
      const tasks = createDurableTasks({ databaseUrl: db?.url, queue: "qm_handoff_test" });
      const entered = Array.from({ length: 4 }, () => Promise.withResolvers<DurableTaskContext>());
      const releases = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
      const effects: number[] = [];
      const attempts: number[] = [];
      const workers: DurableWorker[] = [];
      tasks.register("work", async (context) => {
        attempts.push(context.attempt);
        const values = [];
        for (let index = 0; index < 4; index++)
          values.push(
            await context.step(`step:${index}`, async () => {
              entered[index]!.resolve(context);
              await releases[index]!.promise;
              effects.push(index);
              return index;
            }),
          );
        return values;
      });
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "handoff", maxAttempts: 1 });
      workers.push(tasks.start({ workerId: "worker:0", pollIntervalMs: 5 }));
      try {
        const tokens = new Set<string>();
        for (let index = 0; index < 3; index++) {
          const context = await withTimeout(() => entered[index]!.promise, 2000, "step started");
          tokens.add(context.runID);
          workers[index]!.requestHandoff(1000);
          workers.push(tasks.start({ workerId: `worker:${index + 1}`, pollIntervalMs: 5 }));
          await sleep(15);
          assert.deepEqual(
            effects,
            Array.from({ length: index }, (_, n) => n),
          );
          releases[index]!.resolve();
          await withTimeout(() => workers[index]!.drained(), 2000, "committed handoff");
          const next = await withTimeout(() => entered[index + 1]!.promise, 2000, "immediate successor");
          assert.notEqual(next.runID, context.runID);
          await assert.rejects(context.heartbeat());
          await assert.rejects(context.step("stale", async () => assert.fail("stale effect")));
          if (db) {
            const stale = [
              db.admin.query("SELECT absurd.extend_claim('qm_handoff_test',$1,120)", [context.runID]),
              db.admin.query("SELECT absurd.set_task_checkpoint_state('qm_handoff_test',$1,'stale','{}',$2)", [
                taskId,
                context.runID,
              ]),
              db.admin.query("SELECT absurd.complete_run('qm_handoff_test',$1,'{}')", [context.runID]),
            ];
            for (const outcome of await Promise.allSettled(stale)) {
              assert.equal(outcome.status, "rejected");
              if (outcome.status === "rejected") assert.equal(outcome.reason.code, "AB002");
            }
            assert.equal(
              (await db.admin.query("SELECT qm_handoff_run('qm_handoff_test',$1,'wrong') AS token", [next.runID]))
                .rows[0].token,
              null,
            );
          }
        }
        tokens.add((await entered[3]!.promise).runID);
        assert.equal(tokens.size, 4);
        releases[3]!.resolve();
        assert.deepEqual(await withTimeout(() => tasks.result(taskId), 2000, "handoff result"), [0, 1, 2, 3]);
        assert.deepEqual(effects, [0, 1, 2, 3]);
        assert.deepEqual(attempts, [1, 1, 1, 1]);
        if (db) {
          const row = (await db.admin.query("SELECT attempts,max_attempts,state FROM absurd.t_qm_handoff_test"))
            .rows[0];
          assert.deepEqual(row, { attempts: 1, max_attempts: 1, state: "completed" });
        }
      } finally {
        for (const release of releases) release.resolve();
        await tasks.close();
        await db?.cleanup();
      }
    },
  );

  test(
    `${postgres ? "Postgres" : "memory"} handoff deadline fences a noncooperative callback and admits its replacement`,
    { skip: postgres && !process.env.DATABASE_URL },
    async () => {
      const db = postgres ? await isolatedPostgres() : undefined;
      const tasks = createDurableTasks({ databaseUrl: db?.url, queue: "qm_deadline_test" });
      const entered = Promise.withResolvers<DurableTaskContext>();
      const release = Promise.withResolvers<void>();
      const lateDone = Promise.withResolvers<void>();
      let executions = 0;
      tasks.register("work", async (context) => {
        const execution = ++executions;
        return context.step("effect", async () => {
          if (execution > 1) return "replacement";
          entered.resolve(context);
          await release.promise;
          try {
            await assert.rejects(context.step("late-write", async () => assert.fail("stale callback started work")));
          } finally {
            lateDone.resolve();
          }
          return "late";
        });
      });
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "deadline", maxAttempts: 1 });
      const retiring = tasks.start({ pollIntervalMs: 5 });
      try {
        const context = await entered.promise;
        retiring.requestHandoff(20);
        await withTimeout(() => retiring.drained(), 2000, "deadline handoff");
        assert.equal(context.signal.aborted, true);
        tasks.start({ pollIntervalMs: 5 });
        assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "immediate replacement"), "replacement");
        release.resolve();
        await withTimeout(() => lateDone.promise, 2000, "late callback fenced");
        assert.equal(await tasks.result(taskId), "replacement");
        assert.equal(executions, 2);
      } finally {
        release.resolve();
        await tasks.close();
        await db?.cleanup();
      }
    },
  );

  test(
    `${postgres ? "Postgres" : "memory"} parent workflow surrenders a cross-queue child join immediately`,
    { skip: postgres && !process.env.DATABASE_URL },
    async () => {
      const db = postgres ? await isolatedPostgres() : undefined;
      const parent = createDurableTasks({ databaseUrl: db?.url, queue: "qm_parent_test" });
      const child = createDurableTasks({ databaseUrl: db?.url, queue: "qm_child_test" });
      const waiting = Promise.withResolvers<void>();
      child.register("child", async () => "child finished");
      parent.register("parent", async (context) => {
        const spawned = await context.step("child", () => child.spawn("child", {}, { idempotencyKey: "child" }));
        waiting.resolve();
        return child.result(spawned.taskId);
      });
      const { taskId } = await parent.spawn("parent", {}, { idempotencyKey: "parent", maxAttempts: 1 });
      const retiring = parent.start({ pollIntervalMs: 5 });
      try {
        await waiting.promise;
        retiring.requestHandoff(120_000);
        await withTimeout(() => retiring.drained(), 1000, "cross-queue join handoff");
        parent.start({ pollIntervalMs: 5 });
        child.start({ pollIntervalMs: 5 });
        assert.equal(await withTimeout(() => parent.result(taskId), 2000, "parent resumed"), "child finished");
      } finally {
        await parent.close();
        await child.close();
        await db?.cleanup();
      }
    },
  );
}

for (const operation of ["extend_claim", "set_task_checkpoint_state"]) {
  test(
    `Postgres handoff drains a late ${operation} response before surrender`,
    { skip: !process.env.DATABASE_URL },
    async () => {
      const db = await isolatedPostgres();
      const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_late_handoff_test" });
      const query = tasks.pg!.query.bind(tasks.pg!);
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let intercepted = false;
      tasks.pg!.query = ((...args: Parameters<typeof query>) => {
        const result = query(...args);
        if (!intercepted && typeof args[0] === "string" && args[0].includes(operation)) {
          intercepted = true;
          return result.then(async (value) => {
            blocked.resolve();
            await release.promise;
            return value;
          });
        }
        return result;
      }) as typeof query;
      let effects = 0;
      tasks.register("work", async (context) => context.step("effect", async () => ++effects));
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "late", maxAttempts: 1 });
      const retiring = tasks.start({ workerId: "retiring", pollIntervalMs: 5 });
      try {
        await blocked.promise;
        retiring.requestHandoff(1000);
        tasks.start({ workerId: "incoming", pollIntervalMs: 5 });
        await sleep(30);
        const rows = (await db.admin.query("SELECT state,claimed_by FROM absurd.r_qm_late_handoff_test")).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].state, "running");
        assert.match(rows[0].claimed_by, /^retiring:/);
        release.resolve();
        await withTimeout(() => retiring.drained(), 2000, "native operations drained");
        assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "late native result"), 1);
        assert.equal(effects, 1);
      } finally {
        release.resolve();
        await tasks.close();
        await db.cleanup();
      }
    },
  );
}

test(
  "Postgres handoff fences a checkpoint already waiting on the former owner's row",
  {
    skip: !process.env.DATABASE_URL,
  },
  async () => {
    const db = await isolatedPostgres();
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_checkpoint_fence_test" });
    const retiring = await db.admin.connect();
    const stale = await db.admin.connect();
    try {
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "checkpoint-fence" });
      const old = (await db.admin.query("SELECT * FROM absurd.claim_task('qm_checkpoint_fence_test','retiring',120,1)"))
        .rows[0];
      const pid = (await stale.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await retiring.query("BEGIN");
      await retiring.query("SELECT run_id FROM absurd.r_qm_checkpoint_fence_test WHERE run_id=$1 FOR UPDATE", [
        old.run_id,
      ]);
      const staleWrite = stale
        .query("SELECT absurd.set_task_checkpoint_state('qm_checkpoint_fence_test',$1,'effect','\"stale\"',$2,120)", [
          taskId,
          old.run_id,
        ])
        .then(
          () => null,
          (error: unknown) => error,
        );
      await withTimeout(
        async () => {
          for (;;) {
            const activity = await db.admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
            if (activity.rows[0]?.wait_event_type === "Lock") return;
            await sleep(5);
          }
        },
        2000,
        "checkpoint blocked on owner",
      );
      const successor = await retiring.query(
        "SELECT qm_handoff_run('qm_checkpoint_fence_test',$1,'retiring') AS token",
        [old.run_id],
      );
      assert.ok(successor.rows[0].token);
      await retiring.query("COMMIT");
      const error = await staleWrite;
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "AB002");
      assert.equal((await db.admin.query("SELECT * FROM absurd.c_qm_checkpoint_fence_test")).rows.length, 0);
    } finally {
      await retiring.query("ROLLBACK");
      retiring.release();
      stale.release();
      await tasks.close();
      await db.cleanup();
    }
  },
);

test(
  "Postgres handoff preserves a completed event timeout for the successor",
  {
    skip: !process.env.DATABASE_URL,
  },
  async () => {
    const db = await isolatedPostgres();
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_timeout_handoff_test" });
    tasks.register("work", async (context) => {
      try {
        await context.awaitEvent("never", { timeoutSeconds: 60, stepName: "wait" });
        return "event received";
      } catch (error) {
        if (error instanceof TimeoutError) return "timed out";
        throw error;
      }
    });
    try {
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "timeout-handoff", maxAttempts: 1 });
      const initial = (
        await db.admin.query("SELECT * FROM absurd.claim_task('qm_timeout_handoff_test','retiring',120,1)")
      ).rows[0];
      await db.admin.query("SELECT * FROM absurd.await_event('qm_timeout_handoff_test',$1,$2,'wait','never',0)", [
        taskId,
        initial.run_id,
      ]);
      const timedOut = (
        await db.admin.query("SELECT * FROM absurd.claim_task('qm_timeout_handoff_test','retiring',120,1)")
      ).rows[0];
      assert.equal(timedOut.wake_event, "never");
      assert.equal(timedOut.event_payload, null);
      await db.admin.query("SELECT qm_handoff_run('qm_timeout_handoff_test',$1,'retiring')", [timedOut.run_id]);
      tasks.start({ workerId: "incoming", pollIntervalMs: 5 });
      assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "preserved event timeout"), "timed out");
    } finally {
      await tasks.close();
      await db.cleanup();
    }
  },
);

for (const operation of ["get_task_checkpoint_states", "extend_claim", "set_task_checkpoint_state", "complete_run"]) {
  test(
    `Postgres deployment deadline fences a delayed ${operation} acknowledgement`,
    { skip: !process.env.DATABASE_URL },
    async () => {
      const db = await isolatedPostgres();
      const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_deadline_reply_test" });
      const query = tasks.pg!.query.bind(tasks.pg!);
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let intercepted = false;
      tasks.pg!.query = async (...args) => {
        const result = await query(...args);
        if (!intercepted && args[0].includes(operation)) {
          intercepted = true;
          blocked.resolve();
          await release.promise;
        }
        return result;
      };
      let effects = 0;
      tasks.register("work", async (context) => context.step("effect", async () => ++effects));
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "deadline-reply", maxAttempts: 1 });
      const retiring = tasks.start({ workerId: "retiring", pollIntervalMs: 5 });
      try {
        await withTimeout(() => blocked.promise, 2000, "native acknowledgement delayed");
        retiring.requestHandoff(20);
        await withTimeout(() => retiring.drained(), 1000, "deadline relinquishes native wait");
        tasks.start({ workerId: "replacement", pollIntervalMs: 5 });
        assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "replacement completes"), 1);
        release.resolve();
        await sleep(30);
        assert.equal(effects, 1);
        assert.equal(await tasks.result(taskId), 1);
      } finally {
        release.resolve();
        await tasks.close();
        await db.cleanup();
      }
    },
  );
}

for (const graceMs of [20, 120000])
  test(
    `Postgres deployment fences an unacknowledged claim immediately with ${graceMs}ms grace`,
    {
      skip: !process.env.DATABASE_URL,
    },
    async () => {
      const db = await isolatedPostgres();
      const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_claim_reply_test" });
      const query = tasks.pg!.query.bind(tasks.pg!);
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let intercepted = false;
      tasks.pg!.query = async (...args) => {
        const result = await query(...args);
        if (!intercepted && args[0].includes("qm_claim_tasks")) {
          intercepted = true;
          blocked.resolve();
          await release.promise;
        }
        return result;
      };
      let effects = 0;
      tasks.register("work", async () => ++effects);
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "claim-reply", maxAttempts: 1 });
      const retiring = tasks.start({ workerId: "retiring", pollIntervalMs: 5, leaseTtlMs: 1000 });
      try {
        await withTimeout(() => blocked.promise, 2000, "committed claim acknowledgement delayed");
        retiring.requestHandoff(graceMs);
        tasks.start({ workerId: "incoming", pollIntervalMs: 5 });
        assert.equal(await withTimeout(() => tasks.result(taskId), 1000, "unacknowledged claim handed off"), 1);
        retiring.requestHandoff(0);
        await withTimeout(() => retiring.drained(), 1000, "claim deadline drains");
        release.resolve();
        await sleep(30);
        assert.equal(effects, 1);
        const rows = (await db.admin.query("SELECT state,attempt FROM absurd.r_qm_claim_reply_test ORDER BY run_id"))
          .rows;
        assert.deepEqual(rows, [
          { state: "failed", attempt: 1 },
          { state: "completed", attempt: 1 },
        ]);
      } finally {
        release.resolve();
        await tasks.close();
        await db.cleanup();
      }
    },
  );

test(
  "Postgres worker retirement serializes with an uncommitted claim and fences later claims",
  {
    skip: !process.env.DATABASE_URL,
  },
  async () => {
    const db = await isolatedPostgres();
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_claim_fence_test" });
    const claimant = await db.admin.connect();
    const retiring = await db.admin.connect();
    tasks.register("work", async () => "finished");
    try {
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "claim-fence", maxAttempts: 1 });
      await claimant.query("BEGIN");
      const original = (await claimant.query("SELECT * FROM qm_claim_tasks('qm_claim_fence_test','retiring',120,1)"))
        .rows[0];
      assert.ok(original);
      const pid = (await retiring.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const surrendered = retiring.query("SELECT qm_handoff_worker('qm_claim_fence_test','retiring')");
      await withTimeout(
        async () => {
          for (;;) {
            const activity = await db.admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
            if (activity.rows[0]?.wait_event_type === "Lock") return;
            await sleep(5);
          }
        },
        2000,
        "retirement serialized behind claim",
      );
      await claimant.query("COMMIT");
      await surrendered;
      const late = await db.admin.query("SELECT * FROM qm_claim_tasks('qm_claim_fence_test','retiring',120,1)");
      assert.equal(late.rows.length, 0);
      const rows = (await db.admin.query("SELECT state,attempt FROM absurd.r_qm_claim_fence_test ORDER BY run_id"))
        .rows;
      assert.deepEqual(rows, [
        { state: "failed", attempt: 1 },
        { state: "pending", attempt: 1 },
      ]);
      tasks.start({ workerId: "retiring", pollIntervalMs: 5 });
      assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "same-label successor"), "finished");
    } finally {
      await claimant.query("ROLLBACK");
      claimant.release();
      retiring.release();
      await tasks.close();
      await db.cleanup();
    }
  },
);

test(
  "retirement hands off a claim whose lease expired while its transaction held the worker fence",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = await isolatedPostgres();
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_expired_fence_test" });
    const claiming = await db.admin.connect();
    let retiring: Promise<unknown> | undefined;
    try {
      tasks.register("work", async (context) => context.attempt);
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "expired-fence", maxAttempts: 1 });
      await claiming.query("BEGIN");
      const claim = (await claiming.query("SELECT * FROM qm_claim_tasks('qm_expired_fence_test','retiring',1,1)"))
        .rows[0];
      assert.ok(claim);
      retiring = db.admin.query("SELECT qm_handoff_worker('qm_expired_fence_test','retiring')");
      await sleep(1100);
      await claiming.query("COMMIT");
      await withTimeout(() => retiring!, 2000, "retirement waits for committed claim");
      tasks.start({ workerId: "replacement", pollIntervalMs: 5 });
      assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "expired claim resumes without retry"), 1);
      const attempts = (
        await db.admin.query("SELECT attempt,state FROM absurd.r_qm_expired_fence_test ORDER BY run_id")
      ).rows;
      assert.deepEqual(attempts, [
        { attempt: 1, state: "failed" },
        { attempt: 1, state: "completed" },
      ]);
    } finally {
      await claiming.query("ROLLBACK");
      claiming.release();
      await retiring;
      await tasks.close();
      await db.cleanup();
    }
  },
);
