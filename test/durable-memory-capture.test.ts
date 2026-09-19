import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPerTurnStrategy } from "../src/memory/strategies/per-turn.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import type { McpClient } from "../src/mcp/mcp-client.ts";
import { withDurableMemoryCapture, type MemoryCaptureBurst } from "../src/memory/durable-capture.ts";
import { createAdmittedWork } from "../src/util/admitted-work.ts";
import { createMemoryStrategy } from "../src/memory/strategy.ts";
import { createDurableTasks } from "../src/durable/tasks.ts";
import { createMemoryMap, createPostgresMap } from "../src/persistence/durable-map.ts";
import { sleep, withOperationSignal, withTimeout } from "../src/util/async.ts";
import { isolatedPostgres } from "./support/isolated-postgres.ts";

const input = (id: string) => ({
  scopeId: "personal:U1" as const,
  actorId: "U1",
  input: id,
  reply: `reply:${id}`,
  idempotencyKey: id,
});

test(
  "retired memory writes cannot resume after a pending Postgres lock",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = await isolatedPostgres();
    const memory = createPostgresMemoryService(db.url);
    try {
      for (const operation of ["capture", "replace", "replaceIfRevision", "restore"] as const) {
        const scope = `personal:${operation}` as const;
        await memory.replace(scope, "# Memory\n\nOriginal");
        const original = await memory.readHead!(scope);
        await memory.replace(scope, "# Memory\n\nCurrent");
        const current = await memory.readHead!(scope);
        const blocker = await db.admin.connect();
        let active: Promise<unknown> | undefined;
        try {
          await blocker.query("BEGIN");
          const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
          await blocker.query("SELECT pg_advisory_xact_lock(hashtext('memory'), hashtext($1))", [scope]);
          const controller = new AbortController();
          active = withOperationSignal(controller.signal, () => {
            if (operation === "capture") return memory.capture(scope, ["Late fact"], Date.now());
            if (operation === "replace") return memory.replace(scope, "Late rewrite");
            if (operation === "restore") return memory.restore!(scope, original.revision, current.revision);
            return memory.replaceIfRevision!(scope, "Late promotion", current.revision);
          });
          await withTimeout(
            async () => {
              for (;;) {
                const waiting = await db.admin.query(
                  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting",
                  [rows[0].pid],
                );
                if (waiting.rows[0].waiting) return;
                await sleep(5);
              }
            },
            2000,
            "memory write blocked on lock",
          );
          controller.abort();
          await blocker.query("ROLLBACK");
          await assert.rejects(active, { name: "AbortError" });
          assert.deepEqual(await memory.readHead!(scope), current);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          await active?.catch(() => {});
        }
      }
    } finally {
      await db.cleanup();
    }
  },
);

test("durable memory preserves maximum burst size and deduplicates accepted turns", async () => {
  const tasks = createDurableTasks({ queue: "memory" });
  const captured: string[][] = [];
  const strategy = withDurableMemoryCapture(
    {
      onTurnEnd: async () => {
        throw new Error("batch adapter must be used");
      },
      captureBurst: async (batch) => {
        captured.push(batch.turns.map((turn) => turn.input));
      },
    },
    tasks,
    createMemoryMap(),
    60_000,
    2,
  );
  await strategy.onTurnEnd!(input("one"));
  await strategy.onTurnEnd!(input("two"));
  await strategy.onTurnEnd!(input("two"));
  tasks.start({ concurrency: 2 });
  try {
    await withTimeout(
      async () => {
        while (!captured.length) await sleep(10);
      },
      2000,
      "burst capture",
    );
    assert.deepEqual(captured, [["one", "two"]]);
  } finally {
    await tasks.close();
  }
});

test(
  "accepted memory capture and its batch survive worker replacement and extraction failure",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = await isolatedPostgres();
    let tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_capture_test" });
    let attempts = 0;
    const captured: string[][] = [];
    const firstMap = createPostgresMap<MemoryCaptureBurst>(tasks.pg!, "test_capture_bursts");
    const first = withDurableMemoryCapture(
      {
        onTurnEnd: async () => {},
        captureBurst: async () => {
          attempts++;
          throw new Error("provider unavailable");
        },
      },
      tasks,
      firstMap,
      0,
      10,
    );
    try {
      await first.onTurnEnd!(input("accepted"));
      tasks.start({ pollIntervalMs: 10 });
      await withTimeout(
        async () => {
          while (!attempts) await sleep(10);
        },
        2000,
        "first capture attempt",
      );
      await tasks.close();
      tasks = createDurableTasks({ databaseUrl: db.url, queue: "qm_capture_test" });
      withDurableMemoryCapture(
        {
          onTurnEnd: async () => {},
          captureBurst: async (batch) => {
            captured.push(batch.turns.map((turn) => turn.input));
          },
        },
        tasks,
        createPostgresMap<MemoryCaptureBurst>(tasks.pg!, "test_capture_bursts"),
        0,
        10,
      );
      tasks.start({ pollIntervalMs: 10 });
      await withTimeout(
        async () => {
          while (!captured.length) await sleep(10);
        },
        5000,
        "recovered capture",
      );
      assert.deepEqual(captured, [["accepted"]]);
    } finally {
      await tasks.close();
      await db.cleanup();
    }
  },
);

test("a lost batch completion receipt cannot consume a later capture on replay", async () => {
  const tasks = createDurableTasks({ queue: "memory" });
  const bursts = createMemoryMap<MemoryCaptureBurst>();
  const update = bursts.update!.bind(bursts);
  let injected = false;
  bursts.update = async (id, edit) => {
    let completing = false;
    const result = await update(id, (state) => {
      const next = edit(state);
      completing = !injected && Object.keys(state.active).length > 0 && Object.keys(next.active).length === 0;
      if (!completing) return next;
      return { ...next, pending: [{ id: "later", acceptedAt: Date.now(), params: input("later") }] };
    });
    if (completing) {
      injected = true;
      throw new Error("completion acknowledgement lost");
    }
    return result;
  };
  let taskId = "";
  const schedule = tasks.spawn.bind(tasks);
  tasks.spawn = async (name, params, options) => {
    const task = await schedule(name, params, options);
    taskId = task.taskId;
    return task;
  };
  const captured: string[][] = [];
  const strategy = withDurableMemoryCapture(
    {
      onTurnEnd: async () => {},
      captureBurst: async (batch) => {
        captured.push(batch.turns.map((turn) => turn.input));
      },
    },
    tasks,
    bursts,
    0,
  );
  await strategy.onTurnEnd!(input("first"));
  tasks.start();
  try {
    await withTimeout(() => tasks.result(taskId), 3000, "retried batch");
    assert.deepEqual(captured, [["first"]]);
    assert.deepEqual(
      (await bursts.all())[0]!.pending.map((event) => event.params.input),
      ["later"],
    );
    assert.deepEqual((await bursts.all())[0]!.active, {});
  } finally {
    await tasks.close();
  }
});

for (const postgres of [false, true]) {
  test(
    `${postgres ? "Postgres" : "memory"} capture hands off a hung extraction without losing its burst`,
    {
      skip: postgres && !process.env.DATABASE_URL,
    },
    async () => {
      const db = postgres ? await isolatedPostgres() : undefined;
      const tasks = createDurableTasks({ databaseUrl: db?.url, queue: "qm_capture_handoff" });
      const bursts = db
        ? createPostgresMap<MemoryCaptureBurst>(tasks.pg!, "capture_bursts")
        : createMemoryMap<MemoryCaptureBurst>();
      const dir = await mkdtemp(join(tmpdir(), "capture-handoff-"));
      const memory = createMemoryService(createLocalWorkspaceStore(dir));
      let taskId = "";
      const spawn = tasks.spawn.bind(tasks);
      tasks.spawn = async (...args) => {
        const task = await spawn(...args);
        taskId = task.taskId;
        return task;
      };
      let signal: AbortSignal | undefined;
      let calls = 0;
      let lateReply!: (reply: string) => void;
      const errors: unknown[] = [];
      const strategy = withDurableMemoryCapture(
        createPerTurnStrategy({
          memory,
          harness: {
            oneShot: async (_system, _prompt, suppliedSignal) => {
              if (++calls > 1) return "- Prefers short replies";
              signal = suppliedSignal;
              return new Promise<string>((resolve) => {
                lateReply = resolve;
              });
            },
          },
        }),
        tasks,
        bursts,
        0,
        10,
        { onError: (error) => errors.push(error) },
      );
      const retiring = tasks.start({ pollIntervalMs: 10 });
      try {
        await strategy.onTurnEnd!(input("accepted"));
        await withTimeout(
          async () => {
            while (!calls) await sleep(5);
          },
          2000,
          "capture extraction",
        );
        assert.ok(signal);
        retiring.requestHandoff(20);
        await withTimeout(() => retiring.drained(), 1000, "memory extraction handoff");
        assert.equal(signal.aborted, true);
        assert.equal((await bursts.all())[0]!.active[taskId]?.length, 1);
        tasks.start({ pollIntervalMs: 10 });
        await withTimeout(() => tasks.result(taskId), 2000, "replacement capture");
        lateReply("- This retired result must never be captured");
        await sleep(20);
        assert.match(await memory.read("personal:U1"), /Prefers short replies/);
        assert.doesNotMatch(await memory.read("personal:U1"), /retired result/);
        assert.equal(calls, 2);
        assert.deepEqual(errors, []);
        assert.deepEqual((await bursts.all())[0]!.active, {});
        if (db)
          assert.equal((await db.admin.query("SELECT attempts FROM absurd.t_qm_capture_handoff")).rows[0].attempts, 1);
      } finally {
        await tasks.close();
        await db?.cleanup();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    `${postgres ? "Postgres" : "memory"} capture replays its extracted facts and committed scope mutation`,
    {
      skip: postgres && !process.env.DATABASE_URL,
    },
    async () => {
      const db = postgres ? await isolatedPostgres() : undefined;
      const tasks = createDurableTasks({ databaseUrl: db?.url, queue: "qm_capture_steps" });
      const bursts = db
        ? createPostgresMap<MemoryCaptureBurst>(tasks.pg!, "capture_bursts")
        : createMemoryMap<MemoryCaptureBurst>();
      const dir = await mkdtemp(join(tmpdir(), "capture-steps-"));
      const memory = createMemoryService(createLocalWorkspaceStore(dir));
      const retiring = tasks.start({ pollIntervalMs: 10 });
      let taskId = "";
      const spawn = tasks.spawn.bind(tasks);
      tasks.spawn = async (...args) => {
        const task = await spawn(...args);
        taskId = task.taskId;
        return task;
      };
      let extractions = 0;
      const writes: string[] = [];
      const strategy = withDurableMemoryCapture(
        createPerTurnStrategy({
          memory: {
            ...memory,
            async capture(...args) {
              writes.push(args[0]);
              const added = await memory.capture(...args);
              if (writes.length === 1) retiring.requestHandoff(500);
              return added;
            },
          },
          harness: { oneShot: async () => `- Extracted fact ${++extractions}` },
        }),
        tasks,
        bursts,
        0,
      );
      try {
        await strategy.onTurnEnd!({ ...input("accepted"), scopeId: "channel:C1", conversationScopeId: "channel:C1" });
        await withTimeout(() => retiring.drained(), 2000, "committed memory handoff");
        tasks.start({ pollIntervalMs: 10 });
        await withTimeout(() => tasks.result(taskId), 2000, "memory continuation");
        assert.deepEqual(writes, ["channel:C1", "personal:U1"]);
        assert.equal(extractions, 1);
        assert.match(await memory.read("channel:C1"), /Extracted fact 1/);
        assert.match(await memory.read("personal:U1"), /Extracted fact 1/);
      } finally {
        await tasks.close();
        await db?.cleanup();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

for (const idempotent of [false, true]) {
  test(`memory handoff ${idempotent ? "retries an idempotent" : "quarantines an ambiguous"} provider write`, async () => {
    const tasks = createDurableTasks({ queue: "memory_provider_handoff" });
    const bursts = createMemoryMap<MemoryCaptureBurst>();
    const written = new Set<unknown>();
    let calls = 0;
    let extractions = 0;
    let providerSignal: AbortSignal | undefined;
    let taskId = "";
    const spawn = tasks.spawn.bind(tasks);
    tasks.spawn = async (...args) => {
      const task = await spawn(...args);
      taskId = task.taskId;
      return task;
    };
    const client: McpClient = {
      base: "http://memory.local",
      host: "memory.local",
      listTools: async () => [],
      async callTool(_tool, args, signal) {
        calls++;
        written.add(args.key ?? calls);
        providerSignal = signal;
        if (calls === 1) return new Promise(() => {});
        return { content: [] };
      },
    };
    const memory = createMcpMemoryProvider({
      read: { client, tool: "read", timeoutMs: 300_000 },
      write: { client, tool: "write", timeoutMs: 300_000, ...(idempotent ? { idempotencyArg: "key" } : {}) },
    });
    const strategy = withDurableMemoryCapture(
      createPerTurnStrategy({
        harness: {
          oneShot: async () => {
            extractions++;
            return "- Prefers short replies";
          },
        },
        memory: createRoutedMemoryService({
          providers: { external: memory },
          routes: [{ provider: "external", scopes: ["personal"], capture: "automatic", failOpen: true }],
        }),
      }),
      tasks,
      bursts,
      0,
    );
    const retiring = tasks.start({ pollIntervalMs: 10 });
    try {
      await strategy.onTurnEnd!(input("accepted"));
      await withTimeout(
        async () => {
          while (!calls) await sleep(5);
        },
        2000,
        "provider started",
      );
      retiring.requestHandoff(20);
      await withTimeout(() => retiring.drained(), 1000, "provider handoff");
      assert.equal(providerSignal?.aborted, true);
      let replayed = false;
      const replacement = tasks.start({
        pollIntervalMs: 10,
        admittedWork: {
          ...createAdmittedWork(),
          run: async (run) => {
            try {
              return await run();
            } finally {
              replayed = true;
            }
          },
        },
      });
      if (idempotent) {
        await withTimeout(() => tasks.result(taskId), 2000, "provider replay");
        assert.equal(calls, 2);
        assert.deepEqual((await bursts.all())[0]!.active, {});
      } else {
        await withTimeout(
          async () => {
            while (!replayed) await sleep(5);
          },
          2000,
          "uncertain provider retained",
        );
        await replacement.stopClaims();
        assert.equal(calls, 1);
        assert.equal((await bursts.all())[0]!.active[taskId]?.length, 1);
      }
      assert.equal(written.size, 1);
      assert.equal(extractions, 1);
    } finally {
      await tasks.close();
    }
  });
}

for (const kind of ["per-turn", "scratch-promote"] as const) {
  test(`${kind} capture interrupts promotion without dropping the already stored facts`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-promote-"));
    const workspace = createLocalWorkspaceStore(dir);
    const tasks = createDurableTasks({ queue: "memory_promotion" });
    const bursts = createMemoryMap<MemoryCaptureBurst>();
    let taskId = "";
    const spawn = tasks.spawn.bind(tasks);
    tasks.spawn = async (...args) => {
      const task = await spawn(...args);
      taskId = task.taskId;
      return task;
    };
    let extractions = 0;
    let promotions = 0;
    let signal: AbortSignal | undefined;
    const { strategy, memory } = createMemoryStrategy(kind, {
      harness: {
        oneShot: async (system, _prompt, suppliedSignal) => {
          if (system.startsWith("You extract")) {
            extractions++;
            return "- Prefers short replies";
          }
          signal = suppliedSignal;
          if (++promotions === 1) return new Promise(() => {});
          return "NONE";
        },
      },
      memory: createMemoryService(workspace),
      workspace,
      consolidateAfter: 1,
    });
    const capture = withDurableMemoryCapture(strategy, tasks, bursts, 0);
    const retiring = tasks.start({ pollIntervalMs: 10 });
    try {
      await capture.onTurnEnd!(input("accepted"));
      await withTimeout(
        async () => {
          while (!promotions) await sleep(5);
        },
        2000,
        "memory promotion",
      );
      assert.ok(signal);
      retiring.requestHandoff(20);
      await withTimeout(() => retiring.drained(), 1000, "promotion handoff");
      assert.equal(signal.aborted, true);
      tasks.start({ pollIntervalMs: 10 });
      await withTimeout(() => tasks.result(taskId), 2000, "promoted capture replay");
      assert.match(await memory.recall("personal:U1"), /Prefers short replies/);
      assert.equal(extractions, 1);
      assert.equal(promotions, 2);
      assert.deepEqual((await bursts.all())[0]!.active, {});
    } finally {
      await tasks.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("a cooperative handoff before provider dispatch does not quarantine an unattempted write", async () => {
  const { memoryCaptureEffect } = await import("../src/memory/capture-effect.ts");
  const tasks = createDurableTasks({ queue: "memory_intent_handoff" });
  let handoffRequested = false;
  let calls = 0;
  tasks.register("capture", (context) =>
    memoryCaptureEffect(
      {
        mode: "automatic",
        signal: context.signal,
        checkpoint: (name, run) =>
          context.step(name, async () => {
            const value = await run();
            if (name === "provider:started" && !handoffRequested) {
              handoffRequested = true;
              retiring.requestHandoff(1000);
            }
            return value;
          }),
      },
      "provider",
      false,
      async () => {
        calls++;
      },
    ),
  );
  await tasks.spawn("capture", {}, { idempotencyKey: "unattempted", maxAttempts: null });
  const retiring = tasks.start({ pollIntervalMs: 1 });
  try {
    await withTimeout(() => retiring.drained(), 1000, "intent handoff");
    assert.ok(calls <= 1);
    const replayed = Promise.withResolvers<void>();
    const replacement = tasks.start({
      pollIntervalMs: 1,
      admittedWork: {
        ...createAdmittedWork(),
        run: async (run) => {
          try {
            return await run();
          } finally {
            replayed.resolve();
          }
        },
      },
    });
    await withTimeout(() => replayed.promise, 1000, "intent replay");
    await replacement.stop();
    assert.equal(calls, 1);
  } finally {
    await tasks.close();
  }
});
