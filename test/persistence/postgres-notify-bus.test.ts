import assert from "node:assert/strict";
import { mock, test } from "node:test";

const PG_POOL = "../../src/persistence/pg-pool.ts";
const actual = (await import(`${PG_POOL}?actual`)) as typeof import("../../src/persistence/pg-pool.ts");
const started: string[][] = [];
const pending: Array<() => void> = [];
let closed = false;
mock.module("../../src/persistence/pg-pool.ts", {
  namedExports: {
    ...actual,
    createPgPool: () => ({
      query: (_sql: string, [payload]: string[][]) => {
        started.push(payload!.map((notice) => String((JSON.parse(notice) as { e: unknown }).e)));
        return new Promise<void>((resolve) => pending.push(resolve));
      },
      close: async () => {
        closed = true;
      },
    }),
  },
});
const { createPostgresNotifyBus } = await import("../../src/persistence/postgres-notify-bus.ts");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("notification publication preserves order without concurrent pool queries and drains on close", async () => {
  const bus = createPostgresNotifyBus<number>("db", "events", "test");
  bus.emit(1);
  bus.emit(2);
  await tick();
  assert.deepEqual(started, [["1", "2"]]);
  bus.emit(3);
  bus.emit(4);
  const closing = bus.close!();
  assert.equal(closed, false);
  pending.shift()!();
  await tick();
  assert.deepEqual(started, [
    ["1", "2"],
    ["3", "4"],
  ]);
  assert.equal(closed, false);
  pending.shift()!();
  await closing;
  assert.equal(closed, true);
});
