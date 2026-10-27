import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { createPostgresAdvisoryLock, createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { testAdvisoryLock } from "../support/test-database.ts";

const URL = process.env.DATABASE_URL!;

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

test("pg mutex: the SAME key serializes — the two fns never overlap (one finishes before the other starts)", async () => {
  const pgA = createPgPool(URL);
  const pgB = createPgPool(URL);
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
});

test("pg mutex: DIFFERENT keys run concurrently (independent locks)", async () => {
  const pgA = createPgPool(URL);
  const pgB = createPgPool(URL);
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

test("pg mutex: the lock is released after fn THROWS (the next acquire succeeds)", async () => {
  const pg = createPgPool(URL);
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

test("pg mutex: waiting beyond timeoutMs throws a clear error", async () => {
  const pgHolder = createPgPool(URL);
  const pgWaiter = createPgPool(URL);
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

test("pg shared sandbox use overlaps across cores and excludes lifecycle mutations", { timeout: 10000 }, async () => {
  const pgA = createPgPool(URL);
  const pgB = createPgPool(URL);
  const pgWriter = createPgPool(URL);
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
});

test("pg nested locks reuse one connection without bypassing sibling exclusion", { timeout: 10000 }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: URL, max: 1, connectionTimeoutMillis: 200 });
  const pg = createPgPool(URL);
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

test("pg nested lock leases outlive their parent and late inherited work leases anew", { timeout: 10000 }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: URL, max: 1, connectionTimeoutMillis: 200 });
  const pg = createPgPool(URL);
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
});

test("pg contended polling releases connections for unrelated keys", { timeout: 10000 }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 100 });
  const pg = createPgPool(URL);
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

test("pg multi-key locks reuse one session for nested held keys and release the set", async () => {
  const pg = createPgPool(URL);
  const other = createPgPool(URL);
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
  const lock = testAdvisoryLock();
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

test("pg mutex: when fn throws and unlock also fails, both errors surface and the connection is destroyed", async () => {
  const pg = createPgPool(URL);
  const releases: Array<Error | undefined> = [];
  let failUnlock = false;
  const session = await pg.sessionPool();
  const wrapped = {
    connect: async () => {
      const real = await session.connect();
      return {
        query: (text: string, params?: unknown[]) =>
          failUnlock && text.includes("pg_advisory_unlock")
            ? Promise.reject(new Error("unlock lost"))
            : real.query(text, params),
        release: (err?: Error) => {
          releases.push(err);
          real.release(err);
        },
      };
    },
  };
  const brittle = { ...pg, sessionPool: async () => wrapped as unknown as Awaited<ReturnType<typeof pg.sessionPool>> };
  try {
    const lock = createPostgresAdvisoryLock(brittle, { pollMs: 20 });
    failUnlock = true;
    await assert.rejects(
      () =>
        lock.withLock("deploy:lost", async () => {
          throw new Error("boom");
        }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError, "both failures are reported together");
        assert.deepEqual(
          error.errors.map((e: Error) => e.message),
          ["boom", "unlock lost"],
        );
        assert.match(error.message, /deploy:lost/);
        return true;
      },
    );
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.message, "unlock lost", "the possibly lock-holding connection is destroyed, not pooled");
    assert.equal(session.totalCount, 0, "the pool no longer holds the destroyed connection");
    failUnlock = false;
    let ran = 0;
    await lock.withLock("deploy:lost", async () => {
      ran++;
    });
    assert.equal(ran, 1, "the key is free again once the dead session is gone");
    assert.equal(releases[1], undefined, "a clean unlock returns the connection to the pool");
  } finally {
    await pg.close();
  }
});

test("pg mutex: when fn succeeds but unlock fails, the unlock error surfaces and the connection is destroyed", async () => {
  const pg = createPgPool(URL);
  const releases: Array<Error | undefined> = [];
  const session = await pg.sessionPool();
  const wrapped = {
    connect: async () => {
      const real = await session.connect();
      return {
        query: (text: string, params?: unknown[]) =>
          text.includes("pg_advisory_unlock") ? Promise.reject(new Error("unlock lost")) : real.query(text, params),
        release: (err?: Error) => {
          releases.push(err);
          real.release(err);
        },
      };
    },
  };
  const brittle = { ...pg, sessionPool: async () => wrapped as unknown as Awaited<ReturnType<typeof pg.sessionPool>> };
  try {
    const lock = createPostgresAdvisoryLock(brittle, { pollMs: 20 });
    await assert.rejects(() => lock.withLock("deploy:lost-after-success", async () => "done"), /unlock lost/);
    assert.equal(releases[0]?.message, "unlock lost");
    assert.equal(session.totalCount, 0);
  } finally {
    await pg.close();
  }
});
