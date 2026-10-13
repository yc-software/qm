import { createE2bSandbox } from "../src/sandbox/e2b-sandbox.ts";
import type { E2bSession } from "../src/sandbox/e2b-client.ts";
import { installFakeE2b } from "./support/fake-e2b.ts";
import type { SandboxResource, SandboxDefault } from "../src/sandbox/sandbox-resources.ts";
import { upgradeLegacySandboxes, type SandboxResourceUpgradeMarker } from "../src/sandbox/sandbox-resource-upgrade.ts";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModalSandbox } from "../src/sandbox/modal-sandbox.ts";
import type { ModalSession } from "../src/sandbox/modal-client.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { installFakeModal } from "./support/fake-modal.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { scopeId } from "../src/types.ts";
import { createPgPool, configurePgPooling, setSandboxPoolMax, type PoolClient } from "../src/persistence/pg-pool.ts";
import {
  createPostgresAdvisoryLock,
  createNoopAdvisoryLock,
  createMemoryAdvisoryLock,
} from "../src/persistence/advisory-lock.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the advisory-lock tests";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test(
  "swarm delivery leaves sandbox capacity available while waiting for run admission",
  { skip, timeout: 5_000 },
  async () => {
    configurePgPooling({ databaseUrl: URL!, sessionMax: 1, sandboxMax: 1 });
    const pg = createPgPool(URL!);
    const general = createPostgresAdvisoryLock(pg);
    const sandbox = createPostgresAdvisoryLock(pg, { pool: "sandbox" });
    const originalRuns = createMemoryRunStore().runs;
    const fixture = await swarmFixture({
      lock: sandbox,
      deliveryLock: general,
      runs: {
        ...originalRuns,
        enqueue: (input) => general.withLock("session-run-admission", () => originalRuns.enqueue(input)),
      },
    });
    const entered = Promise.withResolvers<void>();
    const startCommand = Promise.withResolvers<void>();
    let cron: Promise<unknown> | undefined;
    let sweep: Promise<void> | undefined;
    try {
      await fixture.service.spawn(fixture.caller, { requestId: "initial", text: "Work" });
      const generalPool = await pg.sessionPool();
      const sandboxPool = await pg.sessionPool("sandbox");
      generalPool.options.connectionTimeoutMillis = 500;
      sandboxPool.options.connectionTimeoutMillis = 500;
      cron = general.withLock("cron-lifecycle:capacity", async () => {
        entered.resolve();
        await startCommand.promise;
        await sandbox.withSharedLock!("sandbox-resource:capacity", async () => {});
      });
      const completed = Promise.allSettled([cron]);
      await entered.promise;
      sweep = fixture.service.sweep();
      const deadline = Date.now() + 1_000;
      while (!generalPool.waitingCount && Date.now() < deadline) await sleep(5);
      assert.equal(generalPool.waitingCount, 1);
      startCommand.resolve();
      const [result] = await completed;
      assert.equal(result.status, "fulfilled");
      await sweep;
      const swarm = (await fixture.store.get(fixture.root.id))!;
      assert.equal(swarm.messages[0]!.notifications[swarm.members[1]!.id]!.state, "queued");
      assert.equal(generalPool.waitingCount, 0);
      assert.equal(sandboxPool.waitingCount, 0);
    } finally {
      startCommand.resolve();
      await Promise.allSettled([cron, sweep]);
      await pg.close();
      configurePgPooling({});
    }
  },
);

test(
  "Modal cancellation uses its protected session while the sandbox pool is full",
  { skip, timeout: 10_000 },
  async () => {
    configurePgPooling({ databaseUrl: URL!, sandboxMax: 1 });
    const pg = createPgPool(URL!);
    const fake = installFakeModal();
    const entered = Promise.withResolvers<void>();
    const command = Promise.withResolvers<void>();
    const finishKill = Promise.withResolvers<void>();
    let kills = 0;
    let settled = false;
    const wrap = (session: ModalSession): ModalSession => ({
      ...session,
      async runCommand(script, options) {
        if (script.includes("SATURATED_MODAL_COMMAND")) {
          entered.resolve();
          await command.promise;
          return { stdout: "", stderr: "", exitCode: 137 };
        }
        if (script.includes("kill -KILL")) {
          kills++;
          command.resolve();
          await finishKill.promise;
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return session.runCommand(script, options);
      },
    });
    const lock = createPostgresAdvisoryLock(pg, { pool: "sandbox" });
    const sandbox = createModalSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "modal-capacity-"))), {
      advisoryLock: lock,
      client: {
        ...fake.client,
        create: async (options) => wrap(await fake.client.create(options)),
        fromId: async (id) => wrap(await fake.client.fromId(id)),
        fromName: async (name) => {
          const session = await fake.client.fromName(name);
          return session ? wrap(session) : null;
        },
      },
    });
    let running: Promise<unknown> | undefined;
    try {
      const handle = await sandbox.provision([
        { scopeId: scopeId("personal", "capacity"), mountPath: "/", mode: "rw" },
      ]);
      const controller = new AbortController();
      running = lock.withSharedLock!("sandbox-resource:modal-capacity", () =>
        sandbox.run(handle, "SATURATED_MODAL_COMMAND", { signal: controller.signal }),
      ).finally(() => {
        settled = true;
      });
      await entered.promise;
      controller.abort();
      await sleep(50);
      assert.equal(kills, 1, "Stop dispatches without borrowing a second connection");
      assert.equal((await pg.sessionPool("sandbox")).waitingCount, 0);
      assert.equal(settled, false, "the protected operation waits for the kill to finish");
      finishKill.resolve();
      await running;
    } finally {
      command.resolve();
      finishKill.resolve();
      await running?.catch(() => {});
      await pg.close();
      fake.cleanup();
      configurePgPooling({});
    }
  },
);

test(
  "E2b cancellation uses its protected session while the sandbox pool is full",
  { skip, timeout: 10_000 },
  async () => {
    configurePgPooling({ databaseUrl: URL!, sandboxMax: 1 });
    const pg = createPgPool(URL!);
    const fake = installFakeE2b();
    const entered = Promise.withResolvers<void>();
    const command = Promise.withResolvers<void>();
    const finishKill = Promise.withResolvers<void>();
    let kills = 0;
    let settled = false;
    const wrap = (session: E2bSession): E2bSession => ({
      ...session,
      async runCommand(script, options) {
        if (script.includes("SATURATED_E2B_COMMAND")) {
          entered.resolve();
          await command.promise;
          return { stdout: "", stderr: "", exitCode: 137 };
        }
        if (script.includes("kill -KILL")) {
          kills++;
          command.resolve();
          await finishKill.promise;
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return session.runCommand(script, options);
      },
    });
    const lock = createPostgresAdvisoryLock(pg, { pool: "sandbox" });
    const sandbox = createE2bSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "e2b-capacity-"))), {
      advisoryLock: lock,
      client: {
        ...fake.client,
        create: async (options) => wrap(await fake.client.create(options)),
        connect: async (id) => wrap(await fake.client.connect(id)),
      },
    });
    let running: Promise<unknown> | undefined;
    try {
      const handle = await sandbox.provision([
        { scopeId: scopeId("personal", "capacity"), mountPath: "/", mode: "rw" },
      ]);
      const controller = new AbortController();
      running = lock.withSharedLock!("sandbox-resource:e2b-capacity", () =>
        sandbox.run(handle, "SATURATED_E2B_COMMAND", { signal: controller.signal }),
      ).finally(() => {
        settled = true;
      });
      await entered.promise;
      controller.abort();
      await sleep(50);
      assert.equal(kills, 1, "Stop dispatches without borrowing a second connection");
      assert.equal((await pg.sessionPool("sandbox")).waitingCount, 0);
      assert.equal(settled, false, "the protected operation waits for the kill to finish");
      finishKill.resolve();
      await running;
    } finally {
      command.resolve();
      finishKill.resolve();
      await running?.catch(() => {});
      await pg.close();
      fake.cleanup();
      configurePgPooling({});
    }
  },
);

test(
  "sandbox capacity changes wake waiters and drain excess clients without dropping active locks",
  { skip, timeout: 10_000 },
  async () => {
    configurePgPooling({ databaseUrl: URL!, sandboxMax: 1 });
    const pg = createPgPool(URL!);
    const held = new Set<PoolClient>();
    try {
      const pool = await pg.sessionPool("sandbox");
      const first = await pool.connect();
      held.add(first);
      await first.query("SELECT pg_advisory_lock(827360195)");
      const pending = Array.from({ length: 3 }, async () => {
        const client = await pool.connect();
        held.add(client);
        return client;
      });
      assert.equal(pool.waitingCount, 3);
      setSandboxPoolMax(URL!, 4);
      await Promise.all(pending);
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.totalCount, 4);
      assert.equal(await pg.sessionPool("sandbox"), pool);

      setSandboxPoolMax(URL!, 1);
      assert.equal(pool.totalCount, 4);
      assert.equal((await pg.q("SELECT pg_try_advisory_xact_lock(827360195) AS acquired"))[0]!.acquired, false);
      const waiting = pool.connect().then((client) => {
        held.add(client);
        return client;
      });
      for (const client of [...held].filter((client) => client !== first)) {
        held.delete(client);
        client.release();
      }
      assert.equal(pool.totalCount, 1);
      assert.equal(pool.waitingCount, 1);
      await first.query("SELECT pg_advisory_unlock(827360195)");
      held.delete(first);
      first.release();
      const next = await waiting;
      assert.equal((await next.query("SELECT 42 AS answer")).rows[0].answer, 42);
      held.delete(next);
      next.release();

      setSandboxPoolMax(URL!, 4);
      const idle = await Promise.all(Array.from({ length: 4 }, () => pool.connect()));
      idle.forEach((client) => client.release());
      assert.equal(pool.idleCount, 4);
      setSandboxPoolMax(URL!, 2);
      assert.equal(pool.idleCount, 2);
      assert.equal(pool.totalCount, 2);
      assert.throws(() => setSandboxPoolMax(URL!, 0), /positive safe integer/);
      assert.equal(pool.options.max, 2);
    } finally {
      held.forEach((client) => client.release(true));
      await pg.close();
      configurePgPooling({});
    }
  },
);

test("no-op mutex: withLock runs fn and returns its value (single-instance dev/test path)", async () => {
  const lock = createNoopAdvisoryLock();
  let ran = 0;
  const out = await lock.withLock("deploy:any", async () => {
    ran++;
    return 42;
  });
  assert.equal(out, 42, "returns fn's result");
  assert.equal(ran, 1, "ran fn exactly once");
});

test(
  "pg mutex: the SAME key serializes — the two fns never overlap (one finishes before the other starts)",
  { skip },
  async () => {
    const pgA = createPgPool(URL!);
    const pgB = createPgPool(URL!);
    try {
      const lockA = createPostgresAdvisoryLock(pgA, { pollMs: 20 });
      const lockB = createPostgresAdvisoryLock(pgB, { pollMs: 20 });
      let active = 0;
      let maxActive = 0;
      const order: string[] = [];
      const body = (tag: string) => async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`${tag}:start`);
        await sleep(80);
        order.push(`${tag}:end`);
        active--;
      };
      await Promise.all([lockA.withLock("deploy:same", body("A")), lockB.withLock("deploy:same", body("B"))]);
      assert.equal(maxActive, 1, "the two fns never overlapped (serialized)");
      assert.equal(order.length, 4, "both fns ran to completion");
      assert.equal(order[1], `${order[0]!.split(":")[0]}:end`, "the first fn ends before the second begins");
      assert.equal(order[3], `${order[2]!.split(":")[0]}:end`, "the second fn ends after it begins");
    } finally {
      await pgA.close();
      await pgB.close();
    }
  },
);

test("pg mutex: DIFFERENT keys run concurrently (independent locks)", { skip }, async () => {
  const pgA = createPgPool(URL!);
  const pgB = createPgPool(URL!);
  try {
    const lockA = createPostgresAdvisoryLock(pgA, { pollMs: 20 });
    const lockB = createPostgresAdvisoryLock(pgB, { pollMs: 20 });
    let active = 0;
    let maxActive = 0;
    const body = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(80);
      active--;
    };
    await Promise.all([lockA.withLock("deploy:one", body), lockB.withLock("deploy:two", body)]);
    assert.equal(maxActive, 2, "different keys did not block each other (ran concurrently)");
  } finally {
    await pgA.close();
    await pgB.close();
  }
});

test("pg mutex: the lock is released after fn THROWS (the next acquire succeeds)", { skip }, async () => {
  const pg = createPgPool(URL!);
  try {
    const lock = createPostgresAdvisoryLock(pg, { pollMs: 20 });
    await assert.rejects(
      () =>
        lock.withLock("deploy:boom", async () => {
          throw new Error("boom");
        }),
      /boom/,
      "fn's error bubbles (not swallowed)",
    );
    let ran = 0;
    await lock.withLock("deploy:boom", async () => {
      ran++;
    });
    assert.equal(ran, 1, "the key is free again after a thrown fn");
  } finally {
    await pg.close();
  }
});

test("pg mutex: waiting beyond timeoutMs throws a clear error", { skip }, async () => {
  const pgHolder = createPgPool(URL!);
  const pgWaiter = createPgPool(URL!);
  try {
    const holder = createPostgresAdvisoryLock(pgHolder, { pollMs: 20 });
    const waiter = createPostgresAdvisoryLock(pgWaiter, { pollMs: 20, timeoutMs: 100 });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holding = holder.withLock("deploy:slow", async () => {
      await held;
    });
    await sleep(30);
    await assert.rejects(
      () => waiter.withLock("deploy:slow", async () => "never"),
      /timeout acquiring advisory lock for deploy:slow/,
      "waiting past timeoutMs throws a clear error",
    );
    release();
    await holding;
  } finally {
    await pgHolder.close();
    await pgWaiter.close();
  }
});

test("pg sandbox upgrade runs once across cores and never overwrites a newer default", { skip }, async () => {
  const pgA = createPgPool(URL!);
  const pgB = createPgPool(URL!);
  const release = Promise.withResolvers<string[]>();
  try {
    const maps = (pg: typeof pgA) => ({
      availableBackends: ["local"] as const,
      records: createPostgresMap<SandboxResource>(pg, "upgrade_sandbox_records"),
      defaults: createPostgresMap<SandboxDefault>(pg, "upgrade_sandbox_defaults"),
      marker: createPostgresMap<SandboxResourceUpgradeMarker>(pg, "upgrade_sandbox_marker"),
      legacyBackend: () => "local" as const,
    });
    const shared = maps(pgA);
    const other = maps(pgB);
    await shared.defaults.put("personal:cleared", { sandboxId: null });
    const entered = Promise.withResolvers<void>();
    let calls = 0;
    const first = upgradeLegacySandboxes({
      ...shared,
      lock: createPostgresAdvisoryLock(pgA, { pollMs: 10 }),
      legacyScopes: () => {
        calls++;
        entered.resolve();
        return release.promise;
      },
    });
    await entered.promise;
    const second = upgradeLegacySandboxes({
      ...other,
      lock: createPostgresAdvisoryLock(pgB, { pollMs: 10 }),
      legacyScopes: async () => {
        calls++;
        return ["personal:late"];
      },
    });
    await shared.defaults.put("personal:old", { sandboxId: "newer" });
    release.resolve(["personal:old", "personal:cleared", "personal:adopted"]);
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(await shared.defaults.get("personal:old"), { sandboxId: "newer" });
    assert.equal(await shared.defaults.get("personal:late"), null);
    assert.deepEqual(await other.defaults.get("personal:cleared"), { sandboxId: null });
    const adopted = await other.defaults.get("personal:adopted");
    assert.ok(adopted?.sandboxId);
    assert.equal((await other.records.get(adopted.sandboxId))?.backingScopeId, "personal:adopted");
    await upgradeLegacySandboxes({
      ...other,
      lock: createPostgresAdvisoryLock(pgB),
      routes: async () => {
        throw new Error("completed upgrades must never read legacy routing again");
      },
    });
  } finally {
    release.resolve([]);
    await pgA.close();
    await pgB.close();
  }
});
test(
  "pg shared sandbox use overlaps across cores and excludes lifecycle mutations",
  { skip, timeout: 10000 },
  async () => {
    const pgA = createPgPool(URL!);
    const pgB = createPgPool(URL!);
    const pgWriter = createPgPool(URL!);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const key = `sandbox-shared:${crypto.randomUUID()}`;
    const a = createPostgresAdvisoryLock(pgA, { pollMs: 10 });
    const b = createPostgresAdvisoryLock(pgB, { pollMs: 10, timeoutMs: 200 });
    const writer = createPostgresAdvisoryLock(pgWriter, { pollMs: 10, timeoutMs: 100 });
    const running = a.withSharedLock!(key, async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      assert.equal(await b.withSharedLock!(key, async () => "concurrent"), "concurrent");
      await assert.rejects(
        writer.withLock(key, async () => assert.fail("mutated active sandbox")),
        /timeout acquiring/,
      );
      assert.equal(await writer.tryWithLock!(key, async () => "exclusive"), null);
      release.resolve();
      await running;
      assert.equal(await writer.withLock(key, async () => "exclusive"), "exclusive");
      await assert.rejects(
        b.withSharedLock!(key, async () => {
          throw new Error("failed operation");
        }),
        /failed operation/,
      );
      assert.equal(await writer.tryWithLock!(key, async () => "released"), "released");
      await writer.withLock(key, async () => {
        await assert.rejects(
          b.withSharedLock!(key, async () => assert.fail("entered during mutation")),
          /timeout acquiring/,
        );
      });
    } finally {
      release.resolve();
      await running;
      await Promise.all([pgA.close(), pgB.close(), pgWriter.close()]);
    }
  },
);

test("sandbox pool capacity is independent of query and coordination capacity", { skip, timeout: 10000 }, async () => {
  for (const capacity of [1, 3]) {
    configurePgPooling({ queryMax: 1, sessionMax: 1, sandboxMax: capacity });
    const pg = createPgPool(URL!);
    const other = createPgPool(URL!);
    const release = Promise.withResolvers<void>();
    const running: Promise<unknown>[] = [];
    try {
      const sandboxPool = await pg.sessionPool("sandbox");
      assert.ok(sandboxPool !== (await pg.sessionPool()), "sandbox and coordination pools must be separate");
      assert.ok(sandboxPool !== (await pg.pool()), "sandbox and query pools must be separate");
      assert.ok(sandboxPool === (await other.sessionPool("sandbox")));
      assert.equal(sandboxPool.options.max, capacity);
      const sandbox = createPostgresAdvisoryLock(pg, { pool: "sandbox", pollMs: 5 });
      const coordination = createPostgresAdvisoryLock(other);
      const key = `sandbox-capacity:${crypto.randomUUID()}`;
      const entered = Array.from({ length: capacity }, () => Promise.withResolvers<void>());
      for (const ready of entered) {
        running.push(
          sandbox.withSharedLock!(key, async () => {
            ready.resolve();
            await release.promise;
          }),
        );
      }
      void Promise.allSettled(running);
      await Promise.all(entered.map(({ promise }) => promise));
      assert.equal(sandboxPool.totalCount, capacity);
      assert.equal(sandboxPool.idleCount, 0);
      let overflowStarted = false;
      running.push(
        sandbox.withLock("sandbox-overflow", async () => {
          overflowStarted = true;
        }),
      );
      await sleep(30);
      assert.equal(overflowStarted, false);
      assert.equal(
        await coordination.withLock("session-tree-admission", async () => (await pg.q("SELECT 42 AS n"))[0]!.n),
        42,
      );
      assert.equal(await coordination.tryWithLock!(key, async () => true), null);
      release.resolve();
      await Promise.all(running);
      assert.equal(overflowStarted, true);
      assert.equal(sandboxPool.idleCount, capacity);
      await pg.close();
      assert.equal(await createPostgresAdvisoryLock(other, { pool: "sandbox" }).withLock(key, async () => true), true);
    } finally {
      release.resolve();
      await Promise.allSettled(running);
      await pg.close();
      await other.close();
      configurePgPooling({});
    }
  }
});

test("failed cleanup preserves nested locks until their callbacks finish", { skip, timeout: 10000 }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: URL, max: 2 });
  const pg = createPgPool(URL!);
  const lock = createPostgresAdvisoryLock({ ...pg, sessionPool: async () => pool });
  const contender = createPostgresAdvisoryLock(pg);
  const rootKey = `cleanup:${crypto.randomUUID()}`;
  const childKey = `child:${crypto.randomUUID()}`;
  const failure = new Error("unlock unavailable");
  const callbackFailure = new Error("sandbox operation failed");
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  client.query = ((...args: Parameters<typeof client.query>) => {
    if (String(args[0]).includes("pg_advisory_unlock") && (args[1] as unknown as string[])[0] === rootKey)
      return Promise.reject(failure);
    return originalQuery(...args);
  }) as typeof client.query;
  client.release();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let child: Promise<unknown> | undefined;
  try {
    await assert.rejects(
      lock.withLock(rootKey, async () => {
        child = lock.withLock(childKey, async () => {
          entered.resolve();
          await release.promise;
        });
        void child.catch(() => {});
        await entered.promise;
        throw callbackFailure;
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [callbackFailure, failure]);
        return true;
      },
    );
    assert.equal(await contender.tryWithLock!(rootKey, async () => true), null);
    assert.equal(await contender.tryWithLock!(childKey, async () => true), null);
    assert.equal(await lock.withLock("independent-operation", async () => true), true);
    release.resolve();
    await assert.rejects(child!, (error) => error === failure);
    assert.equal(await contender.withLock(rootKey, async () => true), true);
    assert.equal(await contender.withLock(childKey, async () => true), true);
    assert.equal(pool.totalCount, 1);
    assert.equal(pool.idleCount, 1);
  } finally {
    release.resolve();
    await child?.catch(() => {});
    await pool.end();
    await pg.close();
  }
});

test(
  "losing one sandbox connection leaves unrelated locks and admission usable",
  { skip, timeout: 10000 },
  async () => {
    configurePgPooling({ sandboxMax: 3, sessionMax: 1 });
    const pg = createPgPool(URL!);
    const sandbox = createPostgresAdvisoryLock(pg, { pool: "sandbox" });
    const coordination = createPostgresAdvisoryLock(pg);
    const keys = Array.from({ length: 2 }, () => `disconnect:${crypto.randomUUID()}`);
    const entered = keys.map(() => Promise.withResolvers<void>());
    const release = keys.map(() => Promise.withResolvers<void>());
    const running = keys.map((key, index) =>
      sandbox.withLock(key, async () => {
        entered[index]!.resolve();
        await release[index]!.promise;
      }),
    );
    const finished = Promise.allSettled(running);
    try {
      await Promise.all(entered.map(({ promise }) => promise));
      const [held] = await pg.q(
        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND classid=(hashtextextended($1,0)>>32)::int::oid AND objid=(hashtextextended($1,0)&4294967295)::oid",
        [keys[0]],
      );
      assert.ok(held);
      await pg.q("SELECT pg_terminate_backend($1)", [held.pid]);
      assert.equal(await coordination.tryWithLock!(keys[1]!, async () => true), null);
      assert.equal(await sandbox.withLock("new-sandbox-operation", async () => true), true);
      assert.equal(await coordination.withLock("session-tree-admission", async () => true), true);
      release[0]!.resolve();
      await assert.rejects(running[0]!);
      assert.equal(await coordination.tryWithLock!(keys[1]!, async () => true), null);
      release[1]!.resolve();
      await running[1];
      assert.equal(await sandbox.withLock(keys[0]!, async () => true), true);
    } finally {
      for (const gate of release) gate.resolve();
      await finished;
      await pg.close();
      configurePgPooling({});
    }
  },
);

test("pg nested locks reuse one connection without bypassing sibling exclusion", { skip, timeout: 10000 }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: URL, max: 1, connectionTimeoutMillis: 200 });
  const pg = createPgPool(URL!);
  const lock = createPostgresAdvisoryLock({ ...pg, sessionPool: async () => pool }, { pollMs: 5, timeoutMs: 100 });
  try {
    assert.equal(
      await lock.withSharedLock!("resource", () =>
        lock.withSharedLock!("use", () => lock.withLock("recover", async () => 42)),
      ),
      42,
    );
    await lock.withLock("parent", async () => {
      let active = 0;
      let maximum = 0;
      const action = () =>
        lock.withLock("writer", async () => {
          maximum = Math.max(maximum, ++active);
          await sleep(15);
          active--;
        });
      await Promise.all([action(), action(), action()]);
      assert.equal(maximum, 1);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let writing = false;
      const reader = lock.withSharedLock!("mixed", async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      assert.equal(await lock.tryWithLock!("mixed", async () => true), null);
      const writer = lock.withLock("mixed", async () => {
        writing = true;
      });
      await sleep(15);
      assert.equal(writing, false);
      release.resolve();
      await Promise.all([reader, writer]);
      await assert.rejects(
        lock.withLock("parent", async () => true),
        /timeout acquiring/,
      );
      await assert.rejects(
        lock.withLock("throws", async () => {
          throw new Error("callback failure");
        }),
        /callback failure/,
      );
      assert.equal(await lock.withLock("throws", async () => true), true);
    });
    assert.equal(pool.idleCount, 1);
  } finally {
    await pool.end();
    await pg.close();
  }
});

test(
  "pg nested lock leases outlive their parent and late inherited work leases anew",
  { skip, timeout: 10000 },
  async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: URL, max: 1, connectionTimeoutMillis: 200 });
    const pg = createPgPool(URL!);
    const lock = createPostgresAdvisoryLock({ ...pg, sessionPool: async () => pool }, { pollMs: 5 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    let child!: Promise<void>;
    let delayed!: Promise<boolean>;
    try {
      await lock.withLock("root", async () => {
        child = lock.withLock("child", async () => {
          entered.resolve();
          await release.promise;
          assert.equal(await lock.withLock("grandchild", async () => true), true);
        });
        delayed = late.promise.then(() => lock.withLock("late", async () => true));
        await entered.promise;
      });
      assert.equal(pool.idleCount, 0);
      release.resolve();
      await child;
      assert.equal(pool.idleCount, 1);
      late.resolve();
      assert.equal(await delayed, true);
      assert.equal(pool.idleCount, 1);
    } finally {
      release.resolve();
      late.resolve();
      await pool.end();
      await pg.close();
    }
  },
);

test("pg contended polling releases connections for unrelated keys", { skip, timeout: 10000 }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 100 });
  const pg = createPgPool(URL!);
  const lock = createPostgresAdvisoryLock({ ...pg, sessionPool: async () => pool }, { pollMs: 5 });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = lock.withLock("occupied", async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const waiting = lock.withLock("occupied", async () => true);
  try {
    await sleep(20);
    assert.equal(await lock.withLock("unrelated", async () => true), true);
    assert.equal(await lock.tryWithLock!("unrelated", async () => true), true);
  } finally {
    release.resolve();
    await Promise.all([holding, waiting]);
    await pool.end();
    await pg.close();
  }
});

test("pg multi-key locks reuse one session for nested held keys and release the set", { skip }, async () => {
  const pg = createPgPool(URL!);
  const other = createPgPool(URL!);
  const lock = createPostgresAdvisoryLock(pg);
  const contender = createPostgresAdvisoryLock(other);
  try {
    const result = await lock.tryWithLocks!(["inbox:one", "inbox:two"], async () => {
      assert.equal(await contender.tryWithLock!("inbox:two", async () => "unexpected"), null);
      return lock.withLock("inbox:one", async () => lock.withLock("inbox:two", async () => 42));
    });
    assert.equal(result, 42);
    assert.equal(await contender.tryWithLocks!(["inbox:one", "inbox:two"], async () => true), true);
  } finally {
    await pg.close();
    await other.close();
  }
});

test("multi-key locks retain unawaited nested work until it finishes", async () => {
  const lock = createMemoryAdvisoryLock();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const outer = lock.tryWithLocks!(["nested"], async () => {
    void lock.withLock("nested", async () => {
      entered.resolve();
      await release.promise;
    });
  });
  await entered.promise;
  assert.equal(await lock.tryWithLock!("nested", async () => true), null);
  release.resolve();
  await outer;
  assert.equal(await lock.tryWithLock!("nested", async () => true), true);
});
