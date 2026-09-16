import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { PgPool } from "../src/persistence/pg-pool.ts";

function fixture(
  options: {
    acquired?: boolean;
    unlocked?: boolean;
    acquireError?: Error;
    unlockError?: Error;
    acquireEvent?: Error;
    unlockEvent?: Error;
  } = {},
) {
  const client = new EventEmitter();
  const releases: boolean[] = [];
  const queries: string[] = [];
  const idleError = () => {};
  const pool = {
    async connect() {
      return Object.assign(client, {
        async query(text: string) {
          queries.push(text);
          if (text.includes("pg_try_advisory_lock")) {
            if (options.acquireError) throw options.acquireError;
            if (options.acquireEvent) client.emit("error", options.acquireEvent);
            return { rows: [{ locked: options.acquired ?? true }] };
          }
          if (options.unlockError) throw options.unlockError;
          if (options.unlockEvent) client.emit("error", options.unlockEvent);
          return { rows: [{ released: options.unlocked ?? true }] };
        },
        release(destroy: boolean) {
          releases.push(destroy);
          client.on("error", idleError);
        },
      });
    },
  };
  const pg = { sessionPool: async () => pool } as unknown as PgPool;
  return { lock: createPostgresAdvisoryLock(pg), client, releases, queries, idleError };
}

for (const method of ["withLock", "tryWithLock"] as const) {
  test(`${method}: connection loss is handled, work drains, and the callback is not replayed`, async () => {
    const { lock, client, releases, queries, idleError } = fixture();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const lost = new Error("connection lost");
    let calls = 0;
    let settled = false;
    const result = lock[method]!("test", async () => {
      calls++;
      entered.resolve();
      await finish.promise;
      return 42;
    });
    const rejected = assert
      .rejects(result, (error) => error === lost)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    client.emit("error", lost);
    client.emit("error", new Error("second connection error"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "do not release the caller while its callback is still running");
    assert.deepEqual(releases, []);
    finish.resolve();
    await rejected;
    assert.equal(calls, 1);
    assert.equal(queries.length, 1, "do not attempt an unlock on a dead client");
    assert.deepEqual(releases, [true]);
    assert.deepEqual(client.listeners("error"), [idleError]);
  });

  test(`${method}: callback errors survive a second unlock error`, async () => {
    const callbackError = new Error("callback failed");
    const { lock, releases } = fixture({ unlockError: new Error("unlock failed") });
    await assert.rejects(
      lock[method]!("test", async () => {
        throw callbackError;
      }),
      (error) => error === callbackError,
    );
    assert.deepEqual(releases, [true]);
  });

  test(`${method}: a callback failure with successful unlock preserves the healthy client and thrown value`, async () => {
    for (const failure of [new Error("callback failed"), undefined, null]) {
      const { lock, releases } = fixture();
      const result = await lock[method]!("test", () => {
        throw failure;
      }).then(
        () => ({ failed: false, error: undefined }),
        (error: unknown) => ({ failed: true, error }),
      );
      assert.equal(result.failed, true);
      assert.equal(result.error, failure);
      assert.deepEqual(releases, [false]);
    }
  });

  test(`${method}: connection error during acquisition never starts work or retries`, async () => {
    const acquireEvent = new Error("connection lost during acquire");
    const { lock, releases, queries } = fixture({ acquireEvent });
    let calls = 0;
    await assert.rejects(
      lock[method]!("test", async () => {
        calls++;
      }),
      (error) => error === acquireEvent,
    );
    assert.equal(calls, 0);
    assert.equal(queries.length, 1);
    assert.deepEqual(releases, [true]);
  });

  test(`${method}: connection error during unlock overrides a successful callback`, async () => {
    const unlockEvent = new Error("connection lost during unlock");
    const { lock, releases } = fixture({ unlockEvent });
    await assert.rejects(
      lock[method]!("test", async () => "done"),
      (error) => error === unlockEvent,
    );
    assert.deepEqual(releases, [true]);
  });

  test(`${method}: failed unlock never reports a successful operation`, async () => {
    const { lock, releases } = fixture({ unlocked: false });
    await assert.rejects(
      lock[method]!("test", async () => "done"),
      /advisory lock was lost/,
    );
    assert.deepEqual(releases, [true]);
  });

  test(`${method}: acquire failure skips the callback and discards the client`, async () => {
    const acquireError = new Error("acquire failed");
    const { lock, releases } = fixture({ acquireError });
    let calls = 0;
    await assert.rejects(
      lock[method]!("test", async () => {
        calls++;
      }),
      (error) => error === acquireError,
    );
    assert.equal(calls, 0);
    assert.deepEqual(releases, [true]);
  });

  test(`${method}: healthy release preserves null and undefined callback results`, async () => {
    for (const value of [null, undefined]) {
      const { lock, releases, client, idleError } = fixture();
      assert.equal(await lock[method]!("test", async () => value), value);
      assert.deepEqual(releases, [false]);
      assert.deepEqual(client.listeners("error"), [idleError]);
    }
  });
}

test("tryWithLock: contention releases a healthy client without running the callback", async () => {
  const { lock, releases, queries } = fixture({ acquired: false });
  let calls = 0;
  assert.equal(
    await lock.tryWithLock!("test", async () => {
      calls++;
    }),
    null,
  );
  assert.equal(calls, 0);
  assert.equal(queries.length, 1);
  assert.deepEqual(releases, [false]);
});
