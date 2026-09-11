import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import {
  createMemoryCoordinationRepository,
  createPostgresCoordinationRepository,
} from "../src/coordination/repository.ts";
import { createPeerIdentity } from "../src/coordination/identity.ts";
import { createPeerSpawning } from "../src/coordination/spawning.ts";
import { createSpawnLease } from "../src/coordination/spawn-lease.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  test(
    `spawn leases: ${backend} expired workers cannot overwrite recovery`,
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
      await createPeerIdentity(repository).ensure({
        id: "parent",
        scopeId: "personal:owner",
        authority: {
          actor: { id: "owner", type: "internal" },
          conversation: { kind: "dm", threadRef: "parent", audience: [] },
          surface: "web",
        },
      });
      const spawn = await createPeerSpawning(repository).reserve({
        parentId: "parent",
        parentRunId: "run",
        backend: "local",
        idempotencyKey: "one",
        name: "Worker",
        task: "Build",
      });
      const leases = [createSpawnLease(repository), createSpawnLease(other)];
      assert.deepEqual(
        (await repository.pendingSpawns(100, 1)).map((row) => row.id),
        [spawn.id],
      );
      const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => leases[i % 2]!.claim(spawn.id, 100, 10)));
      assert.equal(claims.filter(Boolean).length, 1);
      const old = claims.find(Boolean)!;
      assert.deepEqual(await repository.pendingSpawns(109, 1), []);
      assert.equal((await repository.pendingSpawns(110, 1))[0]?.id, spawn.id);
      assert.equal(await leases[1]!.claim(spawn.id, 109, 10), null);
      await assert.rejects(leases[0]!.save(spawn.id, old.leaseToken!, { state: "ready" }, 110), {
        code: "spawn_lease_lost",
      });
      const recovered = (await leases[1]!.claim(spawn.id, 110, 10))!;
      assert.equal(recovered.attempts, 2);
      assert.notEqual(recovered.leaseToken, old.leaseToken);
      await assert.rejects(leases[0]!.save(spawn.id, old.leaseToken!, { state: "failed" }, 111), {
        code: "spawn_lease_lost",
      });
      const done = await leases[1]!.save(
        spawn.id,
        recovered.leaseToken!,
        { state: "ready", runId: "initial-run" },
        111,
      );
      assert.equal(done.leaseToken, null);
      assert.equal(done.leaseUntil, 0);
      assert.equal(await leases[0]!.claim(spawn.id, 1000), null);
      assert.equal((await repository.get("spawn", spawn.id))?.runId, "initial-run");
      assert.deepEqual(await repository.pendingSpawns(1000, 1), []);
      const second = await createPeerSpawning(repository).reserve({
        parentId: "parent",
        parentRunId: "run",
        backend: "local",
        idempotencyKey: "two",
        name: "Worker",
        task: "Build",
      });
      let clock = 10_000;
      t.mock.method(Date, "now", () => clock);
      const held = (await leases[0]!.claim(second.id, undefined, 100))!;
      let release!: () => void;
      let entered!: () => void;
      const acquired = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocking = repository.transaction([`spawn:${second.id}`], async () => {
        entered();
        await gate;
      });
      await acquired;
      const queued = assert.rejects(leases[1]!.save(second.id, held.leaseToken!, { state: "ready" }), {
        code: "spawn_lease_lost",
      });
      clock = 10_101;
      release();
      await blocking;
      await queued;
      assert.equal((await repository.get("spawn", second.id))?.state, "reserved");
      const retry = (await leases[1]!.claim(second.id))!;
      await leases[1]!.save(second.id, retry.leaseToken!, { state: "failed" });
      assert.deepEqual(await repository.pendingSpawns(clock + 4999, 10), []);
      assert.equal((await repository.pendingSpawns(clock + 5000, 10))[0]?.id, second.id);
    },
  );
}
