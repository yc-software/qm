import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import {
  createMemoryCoordinationRepository,
  createPostgresCoordinationRepository,
} from "../src/coordination/repository.ts";
import { createPeerIdentity } from "../src/coordination/identity.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  test(
    `live peer paging: ${backend} bounded cursor traversal excludes tombstones`,
    { skip: backend === "postgres" && !database },
    async (t) => {
      const pool = createPgPool(database ?? "postgres://unused");
      t.after(() => pool.close());
      const repository =
        backend === "memory"
          ? createMemoryCoordinationRepository()
          : createPostgresCoordinationRepository(pool, randomUUID());
      const identity = createPeerIdentity(repository);
      for (const id of ["A", "a", "b", "c", "z"]) await identity.ensure({ id, scopeId: "personal:owner" });
      await repository.transaction(["peer:b"], async (tx) => {
        const peer = (await tx.get("peer", "b"))!;
        await tx.put("peer", { ...peer, state: "deleted" });
      });
      assert.deepEqual(await repository.livePeerIds("", 2), ["A", "a"]);
      assert.deepEqual(await repository.livePeerIds("a", 2), ["c", "z"]);
      assert.deepEqual(await repository.livePeerIds("z", 2), []);
      assert.deepEqual(await repository.transaction([], (tx) => tx.livePeerIds("A", 1)), ["a"]);
      for (const limit of [0, 201, 1.5])
        await assert.rejects(repository.livePeerIds("", limit), /invalid coordination event window/);
    },
  );
}
