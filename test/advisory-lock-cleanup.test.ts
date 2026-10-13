import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { PgPool } from "../src/persistence/pg-pool.ts";

for (const failsWork of [false, true]) {
  test(`failed unlock discards its session and retains ${failsWork ? "both errors" : "the cleanup error"}`, async () => {
    const client = new EventEmitter();
    const cleanup = new Error("connection lost during unlock");
    const primary = new Error("operation failed");
    const releases: boolean[] = [];
    const pg = {
      sessionPool: async () => ({
        connect: async () =>
          Object.assign(client, {
            query: async (sql: string) => {
              if (sql.includes("pg_advisory_unlock")) throw cleanup;
              return { rows: [{ locked: true }] };
            },
            release: (broken: boolean) => releases.push(broken),
          }),
      }),
    } as unknown as PgPool;
    const lock = createPostgresAdvisoryLock(pg);
    const work = lock.withLock("key", async () => {
      if (failsWork) throw primary;
      return 42;
    });
    if (failsWork) {
      await assert.rejects(work, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, cleanup]);
        return true;
      });
    } else assert.equal(await work, 42);
    assert.deepEqual(releases, [true]);
    assert.equal(client.listenerCount("error"), 0);
  });
}

test("a client error marks the shared lease unusable until all nested work releases it", async () => {
  const client = new EventEmitter();
  const releases: boolean[] = [];
  const pg = {
    sessionPool: async () => ({
      connect: async () =>
        Object.assign(client, {
          query: async () => ({ rows: [{ locked: true }] }),
          release: (broken: boolean) => releases.push(broken),
        }),
    }),
  } as unknown as PgPool;
  const lock = createPostgresAdvisoryLock(pg);
  await lock.withLock("parent", async () => {
    await lock.withLock("child", async () => {
      client.emit("error", new Error("transport lost"));
      await assert.rejects(
        lock.withLock("grandchild", async () => 0),
        /no longer available/,
      );
      assert.deepEqual(releases, []);
    });
    assert.deepEqual(releases, []);
  });
  assert.deepEqual(releases, [true]);
});
