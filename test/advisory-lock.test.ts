import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
  type SandboxResourceRollout,
} from "../src/sandbox/sandbox-resources.ts";
import type { SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresAdvisoryLock, createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the advisory-lock tests";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

test("pg sandbox activation fences publication from a separate compatible reader", { skip }, async () => {
  const pgA = createPgPool(URL!);
  const pgB = createPgPool(URL!);
  const release = Promise.withResolvers<string[]>();
  try {
    const options = {
      enabled: false,
      rollout: createMemoryMap<SandboxResourceRollout>(),
      records: createMemoryMap<SandboxResource>(),
      defaults: createMemoryMap<SandboxDefault>(),
      routes: createMemoryMap<SandboxRoute>(),
      backends: {},
      defaultBackend: "local" as const,
      canUseScope: async () => true,
    };
    const entered = Promise.withResolvers<void>();
    const reader = createSandboxResources({ ...options, lock: createPostgresAdvisoryLock(pgB, { pollMs: 10 }) });
    const active = createSandboxResources({
      ...options,
      enabled: true,
      lock: createPostgresAdvisoryLock(pgA, { pollMs: 10 }),
      legacyScopes: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const activation = active.initialize();
    await entered.promise;
    const publication = reader.recordLegacy("personal:late", "local", { id: "late", rootDir: "/workspace" });
    release.resolve([]);
    await activation;
    const id = await publication;
    assert.equal((await reader.resolve("personal:late"))?.id, id);
    assert.deepEqual(await options.defaults.get("personal:late"), { sandboxId: id });
    let changed = false;
    await assert.rejects(
      reader.withLegacyMutation("personal:late", async () => {
        changed = true;
      }),
      /retired/,
    );
    assert.equal(changed, false);
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
