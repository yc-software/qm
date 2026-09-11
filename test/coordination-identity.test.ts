import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPeerIdentity, characterObject } from "../src/coordination/identity.ts";
import {
  createMemoryCoordinationRepository,
  createPostgresCoordinationRepository,
  type CoordinationRepository,
} from "../src/coordination/repository.ts";
import { scopeId } from "../src/types.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;

for (const backend of ["memory", "postgres"] as const) {
  test(
    `coordination identity: ${backend} transactions, isolation, and compare-and-swap`,
    {
      skip: backend === "postgres" && !database ? "set COORDINATION_TEST_DATABASE_URL" : false,
    },
    async (t) => {
      const org = randomUUID();
      const pools = [createPgPool(database ?? "postgres://unused"), createPgPool(database ?? "postgres://unused")];
      t.after(async () => {
        await Promise.all(pools.map((pool) => pool.close()));
      });
      const first: CoordinationRepository =
        backend === "memory"
          ? createMemoryCoordinationRepository()
          : createPostgresCoordinationRepository(pools[0]!, org);
      const second = backend === "memory" ? first : createPostgresCoordinationRepository(pools[1]!, org);
      const identity = createPeerIdentity(first);
      const peer = await identity.ensure({ id: "session-a", scopeId: scopeId("personal", "alice"), now: 123 });
      assert.equal(peer.rootId, peer.id);
      assert.equal(peer.descendantLimit, 16);
      assert.deepEqual(peer.character, {});
      assert.deepEqual(await second.get("peer", peer.id), peer);

      const responses = await Promise.allSettled([
        identity.replace(peer.id, 1, { character: { group: "launch", role: "worker" }, name: "Builder" }),
        createPeerIdentity(second).replace(peer.id, 1, { character: { role: "reviewer" } }),
      ]);
      assert.equal(responses.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = responses.find((result) => result.status === "rejected");
      assert.equal(rejected?.reason.code, "character_conflict");
      assert.equal((await second.get("peer", peer.id))?.version, 2);

      const current = (await first.get("peer", peer.id))!;
      const previousEvents = await first.events(0, 200);
      await assert.rejects(
        first.transaction(["rollback"], async (tx) => {
          await tx.put("peer", { ...current, name: "Uncommitted" });
          await tx.event("peer", peer.id, 456);
          throw new Error("rollback");
        }),
        /rollback/,
      );
      assert.deepEqual(await second.get("peer", peer.id), current);
      assert.deepEqual(await second.events(0, 200), previousEvents);

      const copy = (await second.get("peer", peer.id))!;
      copy.character.changed = true;
      assert.equal((await first.get("peer", peer.id))!.character.changed, undefined);
      assert.deepEqual(
        Object.keys((await identity.get(peer.id))!).sort(),
        [
          "id",
          "name",
          "character",
          "version",
          "parentId",
          "rootId",
          "descendantLimit",
          "state",
          "createdAt",
          "updatedAt",
        ].sort(),
      );
      assert.equal((await identity.list()).length, 1);
      const events = await second.events(previousEvents.at(-1)!.sequence, 200);
      assert.deepEqual(events, []);
      if (backend === "postgres") {
        const other = createPostgresCoordinationRepository(pools[1]!, randomUUID());
        assert.equal(await other.get("peer", peer.id), null);
        assert.deepEqual(await other.events(0, 200), []);
      }
    },
  );
}

test("character accepts arbitrary JSON including reserved-looking keys and rejects lossy values", () => {
  const character = JSON.parse('{"_qm":{"id":"claimed"},"__proto__":{"role":"admin"},"values":[null,true,1,"🐙"]}');
  assert.deepEqual(characterObject(character), character);
  for (const value of [
    null,
    [],
    "worker",
    { value: NaN },
    { value: undefined },
    { value: "\u0000" },
    { value: "\ud800" },
    { long: "x".repeat(20_000) },
  ])
    assert.throws(() => characterObject(value));
});

test("a persisted execution owner cannot be replaced by ensure or character data", async () => {
  const repository = createMemoryCoordinationRepository();
  const identity = createPeerIdentity(repository);
  const scope = scopeId("personal", "alice");
  const authority = {
    actor: { id: "alice", type: "internal" as const },
    conversation: { kind: "dm" as const, threadRef: "web:alice:a", audience: [] },
    surface: "web",
  };
  await identity.ensure({ id: "a", scopeId: scope });
  await identity.ensure({ id: "a", scopeId: scope, authority });
  await identity.ensure({
    id: "a",
    scopeId: scope,
    authority: { ...authority, actor: { id: "bob", type: "internal" } },
  });
  await identity.replace("a", 1, {
    character: { authority: { actor: "mallory" }, rootId: "different", descendantLimit: 9999 },
  });
  const peer = (await repository.get("peer", "a"))!;
  assert.deepEqual(peer.authority, authority);
  assert.equal(peer.rootId, "a");
  assert.equal(peer.descendantLimit, 16);
  await assert.rejects(identity.ensure({ id: "a", scopeId: scopeId("personal", "bob") }), /scope/);
});
