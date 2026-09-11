import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPeerIdentity } from "../src/coordination/identity.ts";
import { createPeerSpawning } from "../src/coordination/spawning.ts";
import {
  createMemoryCoordinationRepository,
  createPostgresCoordinationRepository,
} from "../src/coordination/repository.ts";
import { scopeId } from "../src/types.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  test(
    `spawn admission: ${backend} recursive caps, multi-instance races and idempotency`,
    {
      skip: backend === "postgres" && !database,
    },
    async (t) => {
      const pools = [createPgPool(database ?? "postgres://unused"), createPgPool(database ?? "postgres://unused")];
      t.after(async () => {
        await Promise.all(pools.map((pool) => pool.close()));
      });
      const org = randomUUID();
      const first =
        backend === "memory"
          ? createMemoryCoordinationRepository()
          : createPostgresCoordinationRepository(pools[0]!, org);
      const second = backend === "memory" ? first : createPostgresCoordinationRepository(pools[1]!, org);
      const identity = createPeerIdentity(first);
      const scope = scopeId("personal", "owner");
      const activate = (id: string) =>
        identity.ensure({
          id,
          scopeId: scope,
          authority: {
            actor: { id: "owner", type: "internal" },
            conversation: { kind: "dm", threadRef: `web:owner:${id}`, audience: [] },
            surface: "web",
          },
        });
      await activate("root");
      const services = [createPeerSpawning(first), createPeerSpawning(second)];
      const service = services[0]!;
      const request = {
        parentId: "root",
        parentRunId: "parent-run",
        backend: "local" as const,
        idempotencyKey: "first",
        task: "build",
        name: "Worker",
        character: { group: "feature" },
      };
      const duplicate = await Promise.all(Array.from({ length: 20 }, (_, i) => services[i % 2]!.reserve(request)));
      assert.equal(new Set(duplicate.map((spawn) => spawn.childId)).size, 1);
      const child = duplicate[0]!.childId;
      assert.equal((await service.inspect("root")).count, 1);
      await activate(child);
      await service.lowerLimit(child, 1);
      const grandchild = await service.reserve({ ...request, parentId: child, idempotencyKey: "grandchild" });
      assert.deepEqual((await first.get("peer", grandchild.childId))!.ancestors, ["root", child]);
      assert.equal((await service.inspect("root")).count, 2);
      await assert.rejects(
        service.reserve({ ...request, parentId: child, idempotencyKey: "too-many" }),
        (error: { code: string; details: unknown }) => {
          assert.equal(error.code, "subtree_limit_exceeded");
          assert.deepEqual(error.details, { ancestorId: child, count: 1, cap: 1 });
          return true;
        },
      );
      await assert.rejects(service.lowerLimit(child, 2), { code: "invalid_subtree_limit" });
      await assert.rejects(service.lowerLimit("root", 1), { code: "invalid_subtree_limit" });
      const other = await service.reserve({ ...request, idempotencyKey: "other" });
      await activate(other.childId);
      const raced = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          services[i % 2]!.reserve({
            ...request,
            parentId: i % 2 ? other.childId : "root",
            idempotencyKey: `race-${i}`,
          }),
        ),
      );
      assert.equal(raced.filter((result) => result.status === "fulfilled").length, 13);
      assert.equal((await service.inspect("root")).count, 16);
      await activate("chain-root");
      let tip = "chain-root";
      for (let depth = 0; depth < 16; depth++) {
        if (depth === 1)
          await first.transaction(["tree:chain-root", "peer:chain-root"], async (tx) => {
            const root = (await tx.get("peer", "chain-root"))!;
            await tx.put("peer", { ...root, state: "stopped" });
          });
        const next = await service.reserve({ ...request, parentId: tip, idempotencyKey: `depth-${depth}` });
        tip = next.childId;
        await activate(tip);
      }
      assert.equal((await service.inspect(tip)).count, 0);
      await assert.rejects(
        service.reserve({ ...request, parentId: tip, idempotencyKey: "too-deep" }),
        (error: { code: string; details: { ancestorId: string } }) => {
          assert.equal(error.code, "subtree_limit_exceeded");
          assert.equal(error.details.ancestorId, "chain-root");
          return true;
        },
      );
      const peers = await first.list("peer", { rootId: "root" });
      for (const peer of peers)
        assert.ok(peers.filter((candidate) => candidate.ancestors.includes(peer.id)).length <= peer.descendantLimit);
      await first.transaction(["tree:root", `peer:${grandchild.childId}`], async (tx) => {
        const peer = (await tx.get("peer", grandchild.childId))!;
        await tx.put("peer", { ...peer, state: "archived" });
      });
      assert.equal((await service.inspect("root")).count, 16);
      await assert.rejects(service.reserve({ ...request, idempotencyKey: "overflow" }), {
        code: "subtree_limit_exceeded",
      });
      assert.deepEqual(await service.reserve(request), duplicate[0]);
      await assert.rejects(service.reserve({ ...request, task: "different" }), { code: "spawn_conflict" });
      const original = (await first.get("peer", child))!;
      await identity.replace(child, original.version, { character: { group: "elsewhere" } });
      assert.deepEqual(await service.reserve(request), duplicate[0]);
      assert.equal((await service.inspect("root")).count, 16);
      const descendantsBefore = (await service.tree("root")).filter((row) => row.peer.id !== "root");
      await service.transition("root", "stop");
      assert.deepEqual(
        (await service.tree("root")).filter((row) => row.peer.id !== "root"),
        descendantsBefore,
      );
      assert.equal((await first.get("peer", "root"))?.state, "stopped");
      await service.transition("root", "pause", true);
      assert.ok(
        (await service.tree("root")).every((row) => row.peer.state === "paused" || row.peer.state === "archived"),
      );
      assert.equal((await service.inspect("root")).count, 16);
      const otherPeer = (await first.get("peer", other.childId))!;
      await Promise.all([
        service.transition("root", "resume", true),
        createPeerIdentity(second).replace(other.childId, otherPeer.version, { character: { role: "updated" } }),
      ]);
      assert.deepEqual((await first.get("peer", other.childId))?.character, { role: "updated" });
      assert.equal((await first.get("peer", grandchild.childId))?.state, "archived");
      assert.deepEqual(await service.transition("root", "resume", true), []);
      assert.equal((await service.inspect("root")).count, 16);
      await activate("lifecycle-root");
      const [racingSpawn] = await Promise.allSettled([
        services[1]!.reserve({ ...request, parentId: "lifecycle-root", idempotencyKey: "racing" }),
        service.transition("lifecycle-root", "stop", true),
      ]);
      if (racingSpawn.status === "fulfilled")
        assert.equal((await first.get("peer", racingSpawn.value.childId))?.state, "stopped");
      else assert.equal(racingSpawn.reason.code, "spawn_parent_unavailable");
      await first.transaction(["tree:root"], async (tx) => {
        const peer = (await tx.get("peer", grandchild.childId))!;
        await tx.put("peer", { ...peer, state: "deleted", authority: null });
      });
      assert.equal((await services[1]!.inspect("root")).count, 16);
      await assert.rejects(services[1]!.reserve({ ...request, idempotencyKey: "deleted-reservation-overflow" }), {
        code: "subtree_limit_exceeded",
      });
      await assert.rejects(services[1]!.lowerLimit("root", 15), { code: "invalid_subtree_limit" });
      assert.ok(
        (await services[1]!.tree("root")).some(
          (row) => row.peer.id === grandchild.childId && row.peer.state === "deleted",
        ),
      );
    },
  );
}
