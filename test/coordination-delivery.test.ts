import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPeerDeliveryLedger } from "../src/coordination/delivery.ts";
import {
  createMemoryCoordinationRepository,
  createPostgresCoordinationRepository,
} from "../src/coordination/repository.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  test(
    `peer delivery: ${backend} leases fence stale workers and completed enqueue is terminal`,
    { skip: backend === "postgres" && !database },
    async (t) => {
      const pools = [createPgPool(database ?? "postgres://unused"), createPgPool(database ?? "postgres://unused")];
      t.after(async () => {
        await Promise.all(pools.map((pool) => pool.close()));
      });
      const org = randomUUID();
      const repository =
        backend === "memory"
          ? createMemoryCoordinationRepository()
          : createPostgresCoordinationRepository(pools[0]!, org);
      const other = backend === "memory" ? repository : createPostgresCoordinationRepository(pools[1]!, org);
      await repository.transaction(["setup"], async (tx) => {
        await tx.put("delivery", {
          id: "message:recipient",
          messageId: "message",
          recipientId: "recipient",
          state: "queued",
          attempts: 0,
          runId: null,
          reason: null,
          createdAt: 0,
          updatedAt: 0,
          leaseToken: null,
          leaseUntil: 0,
        });
      });
      const first = createPeerDeliveryLedger(repository);
      const second = createPeerDeliveryLedger(other);
      const id = "message:recipient";
      const claims = await Promise.all([first.claim(id, 100, 10), second.claim(id, 100, 10)]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claim = claims.find(Boolean)!;
      assert.equal(await second.claim(id, 109), null);
      const replacement = (await second.claim(id, 110, 10))!;
      assert.equal(replacement.attempts, 2);
      assert.notEqual(replacement.leaseToken, claim.leaseToken);
      assert.equal(await first.bind(id, claim.leaseToken!, "stale-run", 111), false);
      assert.equal(await first.settle(id, claim.leaseToken!, "failed", "stale failure", 111), false);
      assert.equal(await second.bind(id, replacement.leaseToken!, "run", 111), true);
      assert.equal(await second.settle(id, replacement.leaseToken!, "delivered", null, 112), true);
      const events = await repository.events(0, 200);
      assert.equal(await first.settle(id, claim.leaseToken!, "failed", "stale failure", 113), false);
      assert.equal(await second.settle(id, replacement.leaseToken!, "queued", null, 114), false);
      assert.deepEqual(await repository.events(0, 200), events);
      assert.equal((await other.get("delivery", id))?.state, "delivered");
      assert.equal(await second.claim(id, 1_000), null);
      await repository.transaction(["pending-fixtures"], async (tx) => {
        const template = (await tx.get("delivery", id))!;
        for (const [rowId, state, updatedAt, leaseUntil] of [
          ["oldest", "blocked", 1, 0],
          ["second", "queued", 2, 0],
          ["third", "queued", 3, 100],
          ["leased", "queued", 0, 101],
          ["failed", "failed", 0, 0],
        ] as const) {
          await tx.put("delivery", { ...template, id: rowId, state, updatedAt, leaseUntil });
        }
      });
      assert.deepEqual(
        (await other.pendingDeliveries(100, 2)).map((row) => row.id),
        ["second", "third"],
      );
      assert.deepEqual(
        (await other.pendingDeliveries(100, 200)).map((row) => row.id),
        ["second", "third"],
      );
      assert.deepEqual(
        (await other.pendingDeliveries(101, 1)).map((row) => row.id),
        ["leased"],
      );
      assert.equal(
        (await other.pendingDeliveries(5_000, 200)).some((row) => row.id === "oldest"),
        false,
      );
      assert.equal(
        (await other.pendingDeliveries(5_001, 200)).some((row) => row.id === "oldest"),
        true,
      );
      const beforeRead = await repository.events(0, 200);
      await other.pendingDeliveries(5_001, 200);
      assert.deepEqual(await repository.events(0, 200), beforeRead);
      await assert.rejects(other.pendingDeliveries(100, 0), /invalid/);
      await assert.rejects(other.pendingDeliveries(100, 201), /invalid/);
      await assert.rejects(other.pendingDeliveries(Number.NaN, 10), /invalid/);
    },
  );
}
