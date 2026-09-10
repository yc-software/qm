import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPostgresLeaderLease } from "../src/persistence/leader-lease.ts";
import { createPostgresNotifyBus } from "../src/persistence/postgres-notify-bus.ts";

const url = process.env.DATABASE_URL;

test("full operation pool does not block leader election or notification delivery", { skip: !url }, async () => {
  const pg = createPgPool(url!);
  const lock = createPostgresAdvisoryLock(pg);
  const key = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const holds: Promise<void>[] = [];
  const buses = Array.from({ length: 3 }, (_, i) =>
    createPostgresNotifyBus<{ id: string }>(url!, `coordination_test_${i}`, "coordination test"),
  );
  try {
    const operations = await pg.pool("session");
    for (let i = 0; i < operations.options.max!; i++) {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => (started = resolve));
      const hold = lock.withLock(`${key}:${i}`, async () => {
        started();
        await gate;
      });
      holds.push(hold);
      await Promise.race([ready, hold]);
    }
    const received = new Set<number>();
    buses.forEach((bus, i) =>
      bus.subscribe((event) => {
        if (event?.id === key) received.add(i);
      }),
    );
    const leader = createPostgresLeaderLease(pg);
    assert.equal(
      await leader.hold(key, async () => {
        assert.deepEqual(await pg.q("SELECT 1 AS one"), [{ one: 1 }]);
        const deadline = Date.now() + 2_000;
        while (received.size < buses.length && Date.now() < deadline) {
          buses.forEach((bus) => bus.emit({ id: key }));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return received.size;
      }),
      3,
    );
  } finally {
    release();
    await Promise.all(holds);
    await Promise.all(buses.map((bus) => bus.close?.()));
    await pg.close();
  }
});

test("full coordination pool leaves operation and query capacity available", { skip: !url }, async () => {
  const pg = createPgPool(url!);
  const clients = [];
  try {
    const coordination = await pg.pool("coordination");
    for (let i = 0; i < coordination.options.max!; i++) clients.push(await coordination.connect());
    const lock = createPostgresAdvisoryLock(pg);
    assert.deepEqual(await lock.withLock(randomUUID(), () => pg.q("SELECT 1 AS one")), [{ one: 1 }]);
  } finally {
    clients.forEach((client) => client.release());
    await pg.close();
  }
});
