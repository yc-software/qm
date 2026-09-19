import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createDurableTasks } from "../src/durable/tasks.ts";
import { withPgTransaction } from "../src/persistence/pg-pool.ts";
import { sleep, withTimeout } from "../src/util/async.ts";
import { errorAlreadyReported } from "../src/util/errors.ts";
import { isolatedPostgres } from "./support/isolated-postgres.ts";

test("memory workflow replays committed values and suspends without consuming a worker slot", async () => {
  const tasks = createDurableTasks({ queue: "memory" });
  let effects = 0;
  tasks.register("wait", async (context, { n }: { n: number }) => {
    const value = await context.step("committed", async () => {
      effects++;
      return n;
    });
    await context.step("void", async () => {});
    await context.awaitEvent("proceed");
    return value;
  });
  tasks.register("release", async () => tasks.emitEvent("proceed", true));
  const worker = tasks.start({ concurrency: 1 });
  try {
    const { taskId } = await tasks.spawn("wait", { n: 7 }, { idempotencyKey: "one" });
    assert.equal((await tasks.spawn("wait", { n: 99 }, { idempotencyKey: "one" })).taskId, taskId);
    await tasks.spawn("release", {}, { idempotencyKey: "two" });
    assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "memory workflow"), 7);
    assert.equal(effects, 1);
  } finally {
    await worker.stop();
    await tasks.close();
  }
});

test("memory workflow retries unknown handlers when their adapter registers", async () => {
  const tasks = createDurableTasks({ queue: "late_registration" });
  const { taskId } = await tasks.spawn("late", {}, { idempotencyKey: "late" });
  tasks.start({ pollIntervalMs: 5 });
  try {
    await sleep(30);
    tasks.register("late", async () => "ready");
    assert.equal(await withTimeout(() => tasks.result(taskId), 1000, "late adapter"), "ready");
  } finally {
    await tasks.close();
  }
});

for (const postgres of [false, true]) {
  test(
    `${postgres ? "Postgres" : "memory"} reports handler failures before the workflow runtime consumes them`,
    { skip: postgres && !process.env.DATABASE_URL },
    async () => {
      const db = postgres ? await isolatedPostgres() : undefined;
      const tasks = createDurableTasks({ databaseUrl: db?.url, queue: "qm_reporting_test" });
      const failure = new Error("provider rejected the workflow");
      tasks.register("fail", async () => {
        throw failure;
      });
      tasks.start({ pollIntervalMs: 5 });
      try {
        const { taskId } = await tasks.spawn("fail", {}, { idempotencyKey: "report-on-failure", maxAttempts: 1 });
        await assert.rejects(withTimeout(() => tasks.result(taskId), 3000, "failed workflow"));
        assert.equal(errorAlreadyReported(failure), true);
      } finally {
        await tasks.close();
        await db?.cleanup();
      }
    },
  );
  test(
    `${postgres ? "Postgres" : "memory"} close aborts stalled handlers and fences late steps`,
    { skip: postgres && !process.env.DATABASE_URL },
    async () => {
      const db = postgres ? await isolatedPostgres() : undefined;
      const tasks = createDurableTasks({ databaseUrl: db?.url, queue: "qm_close_test" });
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      let lateEffects = 0;
      tasks.register("work", async (context) => {
        entered.resolve(context.signal);
        try {
          await release.promise;
          await context.step("late", async () => {
            lateEffects++;
          });
          return "late success";
        } finally {
          finished.resolve();
        }
      });
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "close" });
      tasks.start({ leaseTtlMs: 5000, pollIntervalMs: 5 });
      try {
        const signal = await entered.promise;
        const result = assert.rejects(tasks.result(taskId), /runtime closed/);
        await withTimeout(() => tasks.close(500), 1000, "close stalled workflow");
        assert.equal(signal.aborted, true);
        await result;
        release.resolve();
        await finished.promise;
        assert.equal(lateEffects, 0);
        if (db) {
          const before = (await db.admin.query("SELECT state,claim_expires_at FROM absurd.r_qm_close_test")).rows[0];
          assert.equal(before.state, "running");
          assert.equal((await db.admin.query("SELECT state FROM absurd.t_qm_close_test")).rows[0].state, "running");
          assert.equal(
            (await db.admin.query("SELECT * FROM absurd.claim_task('qm_close_test','new',5,1)")).rowCount,
            0,
          );
          await sleep(1800);
          const after = (await db.admin.query("SELECT claim_expires_at FROM absurd.r_qm_close_test")).rows[0];
          assert.deepEqual(after.claim_expires_at, before.claim_expires_at);
          await db.admin.query(
            "UPDATE absurd.r_qm_close_test SET claim_expires_at=absurd.current_time()-interval '1 second'",
          );
          await db.admin.query("SELECT * FROM absurd.claim_task('qm_close_test','recover',5,1)");
          await db.admin.query(
            "UPDATE absurd.r_qm_close_test SET available_at=absurd.current_time() WHERE state='sleeping'",
          );
          const replacement = createDurableTasks({ databaseUrl: db.url, queue: "qm_close_test" });
          replacement.register("work", async (context) => context.attempt);
          replacement.start({ pollIntervalMs: 5 });
          try {
            assert.equal(await withTimeout(() => replacement.result(taskId), 2000, "shutdown takeover"), 2);
          } finally {
            await replacement.close();
          }
        }
      } finally {
        release.resolve();
        await tasks.close();
        await db?.cleanup();
      }
    },
  );
}

for (const operation of ["extend_claim", "set_task_checkpoint_state"]) {
  test(`Postgres close exits after a late ${operation} response`, { skip: !process.env.DATABASE_URL }, async () => {
    const db = await isolatedPostgres();
    const source = `
      import { createDurableTasks } from ${JSON.stringify(new URL("../src/durable/tasks.ts", import.meta.url).href)};
      const tasks = createDurableTasks({ databaseUrl: process.env.DATABASE_URL, queue: "qm_close_exit_test" });
      const query = tasks.pg.query.bind(tasks.pg);
      const blocked = Promise.withResolvers();
      const release = Promise.withResolvers();
      tasks.pg.query = (...args) => {
        const result = query(...args);
        if (typeof args[0] === "string" && args[0].includes(${JSON.stringify(operation)}))
          return result.then(async (value) => { blocked.resolve(); await release.promise; return value; });
        return result;
      };
      tasks.register("work", async (context) => context.step("saved", async () => "done"));
      await tasks.spawn("work", {}, { idempotencyKey: "exit" });
      tasks.start({ pollIntervalMs: 5 });
      await blocked.promise;
      const closing = tasks.close(1000);
      setTimeout(() => release.resolve(), 20);
      await closing;
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, DATABASE_URL: db.url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    try {
      assert.equal(await withTimeout(() => exited, 5000, "workflow process exit"), 0, output);
    } finally {
      child.kill("SIGKILL");
      await exited.catch(() => {});
      await db.cleanup();
    }
  });
}

test(
  "Postgres workflow rolls back acceptance with its domain transaction",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = await isolatedPostgres();
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_transaction_test" });
    try {
      await tasks.ready();
      await assert.rejects(
        withPgTransaction(await tasks.pg!.pool(), async (client) => {
          await tasks.spawnInTransaction(client, "work", { accepted: true }, { idempotencyKey: "rollback" });
          throw new Error("domain write failed");
        }),
        /domain write failed/,
      );
      assert.equal((await db.admin.query("SELECT count(*) FROM absurd.t_qm_transaction_test")).rows[0].count, "0");
      const copies = await Promise.all(
        Array.from({ length: 10 }, () => tasks.spawn("work", {}, { idempotencyKey: "committed" })),
      );
      assert.equal(new Set(copies.map((copy) => copy.taskId)).size, 1);
    } finally {
      await tasks.close();
      await db.cleanup();
    }
  },
);

test(
  "Postgres workers recover from a transient startup connection failure",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = await isolatedPostgres();
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_start_retry_test" });
    const failed = Promise.withResolvers<void>();
    const pool = tasks.pg!.pool.bind(tasks.pg);
    let connecting = 0;
    tasks.pg!.pool = () => (++connecting === 1 ? Promise.reject(new Error("database restarting")) : pool());
    tasks.register("work", async () => "recovered");
    tasks.start({ pollIntervalMs: 10, onError: () => failed.resolve() });
    try {
      await failed.promise;
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "startup-retry" });
      assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "startup retry"), "recovered");
    } finally {
      await tasks.close();
      await db.cleanup();
    }
  },
);

test(
  "Postgres checkpoints and event waits survive another runtime taking over",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = await isolatedPostgres();
    let tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_restart_test" });
    let effects = 0;
    const handler = async (context: Parameters<Parameters<typeof tasks.register>[1]>[0]) => {
      const value = await context.step("effect", async () => {
        effects++;
        return "saved";
      });
      const payload = await context.awaitEvent<string>("resume");
      await context.step("void", async () => {});
      return `${value}:${payload}`;
    };
    tasks.register("work", handler);
    const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "restart" });
    const first = tasks.start({ concurrency: 1, pollIntervalMs: 10 });
    try {
      await withTimeout(
        async () => {
          while (!(await db.admin.query("SELECT 1 FROM absurd.w_qm_restart_test")).rows.length) await sleep(10);
        },
        5000,
        "workflow wait",
      );
      await first.stop();
      await tasks.close();
      tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_restart_test" });
      tasks.register("work", handler);
      await tasks.emitEvent("resume", "ready");
      await tasks.emitEvent("resume", "duplicate");
      tasks.start({ concurrency: 2, pollIntervalMs: 10 });
      tasks.start({ concurrency: 2, pollIntervalMs: 10 });
      assert.equal(await withTimeout(() => tasks.result(taskId), 5000, "restarted workflow"), "saved:ready");
      assert.equal(effects, 1);
    } finally {
      await tasks.close();
      await db.cleanup();
    }
  },
);

test(
  "stopping claims fences a claim already in flight before executing its handler",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = await isolatedPostgres();
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_stop_test" });
    let executed = 0;
    tasks.register("work", async () => {
      executed++;
    });
    const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "stop" });
    const client = await tasks.absurd();
    const claim = client.claimTasks.bind(client);
    const claimed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.claimTasks = async (options) => {
      const rows = await claim(options);
      claimed.resolve();
      await release.promise;
      return rows;
    };
    const worker = tasks.start({ pollIntervalMs: 10 });
    try {
      await claimed.promise;
      const stopping = worker.stopClaims();
      release.resolve();
      await stopping;
      await worker.drained();
      assert.equal(executed, 0);
      assert.equal((await client.fetchTaskResult(taskId))?.state, "pending");
      client.claimTasks = claim;
      tasks.start({ pollIntervalMs: 10 });
      assert.equal(await withTimeout(() => tasks.result(taskId), 5000, "deferred claim"), undefined);
      assert.equal(executed, 1);
    } finally {
      release.resolve();
      await tasks.close();
      await db.cleanup();
    }
  },
);

for (const operation of ["event", "sleep"]) {
  test(
    `Postgres close fences a late ${operation} result before the handler continues`,
    { skip: !process.env.DATABASE_URL },
    async () => {
      const db = await isolatedPostgres();
      const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_late_wait_test" });
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let effects = 0;
      const query = tasks.pg!.query.bind(tasks.pg!);
      tasks.pg!.query = ((...args: Parameters<typeof query>) => {
        const result = query(...args);
        const statement = args[0];
        if (
          typeof statement === "string" &&
          statement.includes(operation === "event" ? "absurd.await_event" : "absurd.set_task_checkpoint_state")
        ) {
          return result.then(async (value) => {
            blocked.resolve();
            await release.promise;
            return value;
          });
        }
        return result;
      }) as typeof query;
      tasks.register("work", async (context) => {
        if (operation === "event") await context.awaitEvent("ready");
        else await context.sleepUntil("ready", new Date(0));
        effects++;
      });
      try {
        await tasks.emitEvent("ready", true);
        await tasks.spawn("work", {}, { idempotencyKey: "late-wait" });
        tasks.start({ pollIntervalMs: 5 });
        await blocked.promise;
        const closing = tasks.close(1000);
        release.resolve();
        await closing;
        assert.equal(effects, 0);
      } finally {
        release.resolve();
        await tasks.close();
        await db.cleanup();
      }
    },
  );
}

test(
  "a delayed heartbeat response does not extend the proven lease deadline",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = await isolatedPostgres();
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_heartbeat_deadline_test" });
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<AbortSignal>();
    const query = tasks.pg!.query.bind(tasks.pg!);
    tasks.pg!.query = ((...args: Parameters<typeof query>) => {
      const result = query(...args);
      if (typeof args[0] === "string" && args[0].includes("absurd.extend_claim"))
        return result.then(async (value) => {
          blocked.resolve();
          await release.promise;
          return value;
        });
      return result;
    }) as typeof query;
    tasks.register("work", async (context) => {
      entered.resolve(context.signal);
      await context.heartbeat(1);
      await new Promise<void>(() => {});
    });
    try {
      await tasks.spawn("work", {}, { idempotencyKey: "delayed-heartbeat" });
      tasks.start({ pollIntervalMs: 5 });
      const signal = await entered.promise;
      await blocked.promise;
      const expiry = (await db.admin.query("SELECT claim_expires_at FROM absurd.r_qm_heartbeat_deadline_test")).rows[0]
        .claim_expires_at as Date;
      await sleep(500);
      release.resolve();
      await sleep(Math.max(0, expiry.getTime() + 100 - Date.now()));
      assert.equal(signal.aborted, true);
    } finally {
      release.resolve();
      await tasks.close();
      await db.cleanup();
    }
  },
);

test("an expired claim response never starts its user handler", { skip: !process.env.DATABASE_URL }, async () => {
  const db = await isolatedPostgres();
  const tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_late_claim_test" });
  const claimed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const executed = Promise.withResolvers<void>();
  let effects = 0;
  tasks.register("work", async () => {
    effects++;
  });
  const client = await tasks.absurd();
  const claim = client.claimTasks.bind(client);
  const execute = client.executeTask.bind(client);
  client.claimTasks = async (options) => {
    const rows = await claim(options);
    claimed.resolve();
    await release.promise;
    return rows;
  };
  client.executeTask = async (...args) => {
    try {
      await execute(...args);
    } finally {
      executed.resolve();
    }
  };
  try {
    await tasks.spawn("work", {}, { idempotencyKey: "late-claim" });
    const worker = tasks.start({ leaseTtlMs: 1000, pollIntervalMs: 5 });
    await claimed.promise;
    await sleep(1100);
    release.resolve();
    await executed.promise;
    await worker.stop();
    assert.equal(effects, 0);
  } finally {
    release.resolve();
    await tasks.close();
    await db.cleanup();
  }
});
