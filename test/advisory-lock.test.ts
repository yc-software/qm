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
