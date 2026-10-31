import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { TEST_TENANT } from "./support/tenant.ts";

const started: string[][] = [];
const pending: Array<() => void> = [];
let closed = false;
mock.module("../src/persistence/pg-pool.ts", {
  namedExports: {
    createPgPool: () => ({
      query: (_sql: string, [payload]: string[][]) => {
        started.push(payload!);
        return new Promise<void>((resolve) => pending.push(resolve));
      },
      close: async () => {
        closed = true;
      },
    }),
  },
});
const { createPostgresNotifyBus } = await import("../src/persistence/postgres-notify-bus.ts");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("notification publication preserves order without concurrent pool queries and drains on close", async () => {
  const bus = createPostgresNotifyBus<number>("db", "events", "test");
  bus.emit(1);
  bus.emit(2);
  await tick();
  assert.deepEqual(started, [[`${TEST_TENANT}\n1`, `${TEST_TENANT}\n2`]]);
  bus.emit(3);
  bus.emit(4);
  const closing = bus.close!();
  assert.equal(closed, false);
  pending.shift()!();
  await tick();
  assert.deepEqual(started, [
    [`${TEST_TENANT}\n1`, `${TEST_TENANT}\n2`],
    [`${TEST_TENANT}\n3`, `${TEST_TENANT}\n4`],
  ]);
  assert.equal(closed, false);
  pending.shift()!();
  await closing;
  assert.equal(closed, true);
});
