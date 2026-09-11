import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemoryCoordinationRepository,
  createPostgresCoordinationRepository,
} from "../src/coordination/repository.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { randomUUID } from "node:crypto";
import { createPeerIdentity } from "../src/coordination/identity.ts";
import { createPeerSpawning } from "../src/coordination/spawning.ts";
import { createPeerSpawnWorker } from "../src/coordination/spawn-worker.ts";
import { createPeerBoard } from "../src/coordination/board.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { conversationScope } from "../src/resolution/resolution-service.ts";
import { publicSpawn } from "../src/coordination/types.ts";

for (const target of ["parent", "child"] as const) {
  test(`memory binding holds ${target} deletion until its commit`, async (t) => {
    const repository = createMemoryCoordinationRepository();
    const sessions = createMemorySessionStore();
    const parent = await sessions.getOrCreateByThread("binding-lock", "dm", "personal:owner");
    const authority = {
      actor: { id: "owner", type: "internal" as const },
      conversation: { kind: "dm" as const, threadRef: parent.threadRef, audience: [] },
      surface: "web",
    };
    await createPeerIdentity(repository).ensure({ id: parent.id, scopeId: parent.scopeId, authority });
    const spawn = await createPeerSpawning(repository).reserve({
      parentId: parent.id,
      parentRunId: "run",
      backend: "local",
      idempotencyKey: "lock",
      name: "Child",
      task: "Work",
    });
    const deletedId = target === "parent" ? parent.id : spawn.childId;
    let deletion: Promise<void> | undefined;
    let deleted = false;
    const transaction = repository.transaction.bind(repository);
    t.mock.method(
      repository,
      "transaction",
      (locks: Parameters<typeof transaction>[0], action: Parameters<typeof transaction>[1]) =>
        transaction(locks, async (tx) => {
          const put = tx.put.bind(tx);
          t.mock.method(tx, "put", async (kind: Parameters<typeof put>[0], row: Parameters<typeof put>[1]) => {
            if (kind === "peer" && row.id === spawn.childId && "sandboxId" in row && row.sandboxId && !deletion) {
              deletion = sessions.deleteSession(deletedId).then(() => {
                deleted = true;
              });
              await new Promise((resolve) => setImmediate(resolve));
              assert.equal(deleted, false);
              assert.ok(await sessions.get(deletedId));
            }
            return put(kind, row);
          });
          return action(tx);
        }),
    );
    const worker = createPeerSpawnWorker({
      repository,
      sessions,
      authorize: async () => authority,
      participants: async () => ["owner"],
      resources: {
        async create() {
          return {
            id: spawn.childId,
            ownerScopeId: parent.scopeId,
            backingScopeId: `sandbox-${spawn.childId}`,
            backend: "local",
            name: "Child",
            createdBy: "owner",
            createdAt: new Date().toISOString(),
            legacy: false,
            state: "ready",
          };
        },
      },
      board: {
        async publish() {
          throw new Error("stop after binding");
        },
      },
      dispatcher: {
        async dispatch() {
          assert.fail("not reached");
        },
      },
    });
    await assert.rejects(worker.advance(spawn.id), /stop after binding/);
    assert.ok(deletion);
    await deletion;
    assert.equal(deleted, true);
    assert.equal((await repository.get("peer", spawn.childId))?.sandboxId, spawn.childId);
    assert.equal(await sessions.get(deletedId), null);
  });
  for (const backend of ["memory", "postgres"] as const) {
    test(
      `${backend} spawn binding rejects ${target} deletion after final authority lookup`,
      { skip: backend === "postgres" && !process.env.COORDINATION_TEST_DATABASE_URL },
      async (t) => {
        const database = process.env.COORDINATION_TEST_DATABASE_URL;
        const pool = createPgPool(database ?? "postgres://unused");
        t.after(() => pool.close());
        const repository =
          backend === "memory"
            ? createMemoryCoordinationRepository()
            : createPostgresCoordinationRepository(pool, randomUUID(), { postgresSessions: true });
        const sessions = backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(database!);
        const parent = await sessions.getOrCreateByThread(`parent-binding:${randomUUID()}`, "dm", "personal:owner");
        const authority = {
          actor: { id: "owner", type: "internal" as const },
          conversation: { kind: "dm" as const, threadRef: parent.threadRef, audience: [] },
          surface: "web",
        };
        await createPeerIdentity(repository).ensure({ id: parent.id, scopeId: parent.scopeId, authority });
        const spawning = createPeerSpawning(repository);
        const spawn = await spawning.reserve({
          parentId: parent.id,
          parentRunId: "run",
          backend: "local",
          idempotencyKey: "binding",
          name: "Child",
          task: "Work",
        });
        let authorizations = 0;
        const worker = createPeerSpawnWorker({
          repository,
          sessions,
          board: createPeerBoard(repository),
          authorize: async () => {
            if (++authorizations === 2) await sessions.deleteSession(target === "parent" ? parent.id : spawn.childId);
            return authority;
          },
          participants: async () => ["owner"],
          resources: {
            async create() {
              return {
                id: spawn.childId,
                ownerScopeId: parent.scopeId,
                backingScopeId: `sandbox-${spawn.childId}`,
                backend: "local",
                name: "Child",
                createdBy: "owner",
                createdAt: new Date().toISOString(),
                legacy: false,
                state: "ready",
              };
            },
          },
          dispatcher: {
            async dispatch() {
              assert.fail("deleted session must not dispatch");
            },
          },
        });
        await assert.rejects(worker.advance(spawn.id), /spawn session was deleted/);
        assert.equal((await repository.get("peer", spawn.childId))?.sandboxId, null);
        assert.equal((await repository.list("message")).length, 0);
        assert.equal((await spawning.inspect(parent.id)).count, 1);
      },
    );
  }
  test(`spawn recovery does not resurrect a deleted ${target}`, async () => {
    const repository = createMemoryCoordinationRepository();
    const sessions = createMemorySessionStore();
    const authority = {
      actor: { id: "owner", type: "internal" as const },
      conversation: { kind: "dm" as const, threadRef: "web:owner:parent", audience: [] },
      surface: "web",
    };
    const scope = conversationScope(authority.conversation, "owner");
    const parent = await sessions.getOrCreateByThread(authority.conversation.threadRef, "dm", scope);
    await createPeerIdentity(repository).ensure({ id: parent.id, scopeId: scope, authority });
    const spawning = createPeerSpawning(repository);
    const spawn = await spawning.reserve({
      parentId: parent.id,
      parentRunId: "run",
      backend: "local",
      idempotencyKey: "deleted-recovery",
      name: "Worker",
      task: "Build",
    });
    let provisions = 0;
    const worker = createPeerSpawnWorker({
      repository,
      sessions,
      board: createPeerBoard(repository),
      authorize: async () => authority,
      participants: async () => ["owner"],
      resources: {
        async create() {
          provisions++;
          throw new Error("provision unavailable");
        },
      },
      dispatcher: {
        async dispatch() {
          assert.fail("deleted spawn must not dispatch");
        },
      },
    });
    await assert.rejects(worker.advance(spawn.id), /provision unavailable/);
    assert.ok(await sessions.get(spawn.childId));
    await sessions.deleteSession(spawn.childId);
    if (target === "parent") await sessions.deleteSession(parent.id);
    await assert.rejects(worker.advance(spawn.id), target === "parent" ? /parent is unavailable/ : /deleted session/);
    assert.equal(await sessions.get(spawn.childId), null);
    assert.equal(provisions, 1);
    assert.equal((await spawning.inspect(parent.id)).count, 1);
    assert.equal((await repository.get("peer", spawn.childId))?.parentId, parent.id);
    assert.equal((await repository.list("message")).length, 0);
  });
}

for (const kind of ["dm", "group", "channel"] as const) {
  for (const explicitRef of [false, true]) {
    test(`spawn recovery preserves one child, computer, task and scope (${kind}, explicitRef=${explicitRef})`, async () => {
      const repository = createMemoryCoordinationRepository();
      const identity = createPeerIdentity(repository);
      const authority = {
        actor: { id: "owner", type: "internal" as const },
        conversation: {
          kind,
          threadRef: "web:owner:parent",
          audience: [],
          ...(explicitRef ? { channelRef: "shared" } : {}),
        },
        surface: "web",
      };
      const scope = conversationScope(authority.conversation, "owner");
      const sessions = createMemorySessionStore();
      const parent = await sessions.getOrCreateByThread(authority.conversation.threadRef, kind, scope);
      await identity.ensure({ id: parent.id, scopeId: scope, authority });
      const spawning = createPeerSpawning(repository);
      const spawn = await spawning.reserve({
        parentId: parent.id,
        parentRunId: "parent-run",
        backend: "local",
        idempotencyKey: "spawn",
        name: "Builder",
        character: { role: "worker" },
        task: "Build the thing",
      });
      const computers = new Map<string, SandboxResource>();
      let failProvision = true;
      let failDispatch = true;
      const deps: Parameters<typeof createPeerSpawnWorker>[0] = {
        repository,
        sessions,
        board: createPeerBoard(repository),
        authorize: async () => authority,
        participants: async () => ["owner"],
        resources: {
          async create(actor, scope, backend, name, id) {
            assert.ok(id);
            const resource: SandboxResource = {
              id,
              ownerScopeId: scope,
              backend: "local",
              backingScopeId: `sandbox-${id}`,
              name: name!,
              createdBy: actor,
              createdAt: new Date().toISOString(),
              legacy: false,
              state: "ready",
            };
            computers.set(id, computers.get(id) ?? resource);
            if (failProvision) {
              failProvision = false;
              throw new Error("lost provision response");
            }
            return computers.get(id)!;
          },
        },
        dispatcher: {
          async dispatch(id) {
            await repository.transaction([`delivery:${id}`], async (tx) => {
              const delivery = (await tx.get("delivery", id))!;
              const child = (await tx.get("peer", delivery.recipientId))!;
              assert.ok(child.authority);
              assert.equal(child.sandboxId, spawn.childId);
              await tx.put("delivery", { ...delivery, runId: "initial-run" });
            });
            if (failDispatch) {
              failDispatch = false;
              throw new Error("lost enqueue response");
            }
          },
        },
      };
      await assert.rejects(createPeerSpawnWorker(deps).advance(spawn.id), /lost provision response/);
      assert.equal((await repository.get("spawn", spawn.id))?.state, "failed");
      const failedNode = (await spawning.tree(parent.id)).find((node) => node.peer.id === spawn.childId)!;
      assert.equal(failedNode.spawn?.state, "failed");
      assert.equal(failedNode.spawn?.attempts, 1);
      assert.equal(failedNode.spawn?.reason, "spawn_provisioning_failed");
      assert.ok(!JSON.stringify(failedNode).includes("lost provision response"));
      assert.equal(
        publicSpawn({ ...spawn, reason: "private credential material" }).reason,
        "spawn_provisioning_failed",
      );
      assert.equal((await repository.list("message")).length, 0);
      await assert.rejects(createPeerSpawnWorker(deps).advance(spawn.id), /lost enqueue response/);
      const worker = createPeerSpawnWorker(deps);
      const retries = await Promise.all(Array.from({ length: 10 }, () => worker.advance(spawn.id)));
      assert.ok(retries.some((result) => result.state === "ready" && result.runId === "initial-run"));
      assert.equal((await repository.get("spawn", spawn.id))?.state, "ready");
      assert.equal(computers.size, 1);
      const readyNode = (await spawning.tree(parent.id)).find((node) => node.peer.id === spawn.childId)!;
      assert.equal(readyNode.spawn?.state, "ready");
      assert.equal(readyNode.spawn?.attempts, 3);
      assert.equal(readyNode.spawn?.reason, null);
      assert.ok(!Object.hasOwn(readyNode.spawn!, "task"));
      assert.ok(!Object.hasOwn(readyNode.spawn!, "leaseToken"));
      assert.equal((await repository.list("message")).length, 1);
      assert.equal((await repository.list("delivery")).length, 1);
      const child = (await repository.get("peer", spawn.childId))!;
      assert.equal(child.authority?.conversation.threadRef, (await sessions.get(child.id))?.threadRef);
      assert.equal(child.authority?.actor.id, "owner");
      assert.equal(conversationScope(child.authority!.conversation, "owner"), scope);
      assert.equal((await sessions.get(child.id))?.scopeId, scope);
      assert.equal((await sessions.getEntries(child.id)).length, 0);
      const message = (await repository.list("message"))[0]!;
      assert.equal(message.senderRunId, "parent-run");
      assert.equal(message.text, "Build the thing");
      assert.deepEqual(message.recipientIds, [child.id]);
      assert.equal((await spawning.inspect(parent.id)).count, 1);
    });
  }
}
