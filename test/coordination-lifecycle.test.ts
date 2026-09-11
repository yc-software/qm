import assert from "node:assert/strict";
import { test } from "node:test";
import { createPeerLifecycle } from "../src/coordination/lifecycle.ts";
import { createPeerSpawning } from "../src/coordination/spawning.ts";
import { createPeerIdentity } from "../src/coordination/identity.ts";
import { createMemoryCoordinationRepository } from "../src/coordination/repository.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { randomUUID } from "node:crypto";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresCoordinationRepository } from "../src/coordination/repository.ts";

test(
  "concurrent Postgres deletion reconciliation fits a two-connection pool",
  { skip: !process.env.COORDINATION_TEST_DATABASE_URL },
  async (t) => {
    const database = process.env.COORDINATION_TEST_DATABASE_URL!;
    configurePgPooling({ databaseUrl: database, queryMax: 2 });
    const pool = createPgPool(database);
    t.after(async () => {
      await pool.close();
      configurePgPooling({});
    });
    const repository = createPostgresCoordinationRepository(pool, randomUUID(), { postgresSessions: true });
    const sessions = createPostgresSessionStore(database);
    const session = await sessions.getOrCreateByThread(randomUUID(), "dm", "personal:owner");
    await createPeerIdentity(repository).ensure({ id: session.id, scopeId: session.scopeId });
    await sessions.deleteSession(session.id);
    const { runs } = createMemoryRunStore();
    const deps = {
      repository,
      sessions,
      runs,
      signals: createMemoryRunSignalStore(),
      spawning: createPeerSpawning(repository),
    };
    await Promise.all(Array.from({ length: 30 }, () => createPeerLifecycle(deps).reconcileDeleted(session.id)));
    assert.equal((await repository.get("peer", session.id))?.state, "deleted");
  },
);

test("lifecycle cancellation recovers committed state, isolates individual stops, and prevents inactive admission", async () => {
  const repository = createMemoryCoordinationRepository();
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const signals = createMemoryRunSignalStore();
  const identity = createPeerIdentity(repository);
  const spawning = createPeerSpawning(repository);
  const deps = { repository, sessions, runs, signals, spawning };
  const parent = await sessions.getOrCreateByThread("parent", "dm", "personal:owner");
  const authority = {
    actor: { id: "owner", type: "internal" as const },
    conversation: { kind: "dm" as const, threadRef: parent.threadRef, audience: [] },
    surface: "web",
  };
  await identity.ensure({ id: parent.id, scopeId: parent.scopeId, authority });
  const operation = await spawning.reserve({
    parentId: parent.id,
    parentRunId: "source",
    backend: "local",
    name: "Child",
    task: "Work",
    idempotencyKey: "child",
  });
  const child = await sessions.getOrCreateByThread("child", "dm", parent.scopeId, undefined, "web", operation.childId);
  const lifecycle = createPeerLifecycle(deps);
  assert.equal(await lifecycle.canRun(child.threadRef), false);
  await repository.transaction([`peer:${child.id}`], async (tx) => {
    const peer = (await tx.get("peer", child.id))!;
    await tx.put("peer", { ...peer, sandboxId: "dedicated" });
  });
  const enqueue = async (threadRef: string) =>
    (
      await runs.enqueue({
        sessionId: threadRef,
        request: {
          ...authority,
          conversation: { ...authority.conversation, threadRef },
          text: "Work",
          origin: { kind: "human" },
        },
      })
    ).run;
  const parentRun = await enqueue(parent.threadRef);
  const childRun = await enqueue(child.threadRef);
  await runs.claimById(parentRun.id, "worker", 60_000);
  await runs.claimById(childRun.id, "worker", 60_000);
  await lifecycle.transition(parent.id, "stop");
  assert.deepEqual(
    (await signals.takePending(parentRun.id)).map((signal) => signal.kind),
    ["abort"],
  );
  assert.deepEqual(await signals.takePending(childRun.id), []);
  assert.equal(await lifecycle.canRun(parent.threadRef), false);
  assert.equal(await lifecycle.canRun(child.threadRef), true);
  await spawning.transition(parent.id, "pause", true);
  const pending = await enqueue(child.threadRef);
  await createPeerLifecycle(deps).sweep();
  assert.equal((await runs.get(pending.id))?.status, "pending");
  assert.deepEqual(
    (await signals.takePending(pending.id)).map((signal) => signal.kind),
    ["abort"],
  );
  assert.deepEqual(
    (await signals.takePending(childRun.id)).map((signal) => signal.kind),
    ["abort"],
  );
  assert.equal(await lifecycle.canRun(child.threadRef), false);
  assert.equal((await spawning.inspect(parent.id)).count, 1);
  await lifecycle.transition(parent.id, "resume", true);
  assert.equal(await lifecycle.canRun(parent.threadRef), true);
  assert.equal(await lifecycle.canRun(child.threadRef), true);
  assert.equal((await spawning.inspect(parent.id)).count, 1);
});

test("deleted intermediate sessions retain ancestry and unfinished reservations retain capacity", async () => {
  const repository = createMemoryCoordinationRepository();
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const signals = createMemoryRunSignalStore();
  const spawning = createPeerSpawning(repository);
  const lifecycle = createPeerLifecycle({ repository, sessions, runs, signals, spawning });
  const root = await sessions.getOrCreateByThread("root", "dm", "personal:owner");
  const authority = {
    actor: { id: "owner", type: "internal" as const },
    conversation: { kind: "dm" as const, threadRef: "root", audience: [] },
    surface: "web",
  };
  await createPeerIdentity(repository).ensure({ id: root.id, scopeId: root.scopeId, authority });
  const reserve = (parentId: string, key: string) =>
    spawning.reserve({ parentId, parentRunId: "run", backend: "local", task: "Work", name: key, idempotencyKey: key });
  const child = await reserve(root.id, "child");
  await sessions.getOrCreateByThread("child", "dm", root.scopeId, undefined, "web", child.childId);
  await repository.transaction([`tree:${root.id}`], async (tx) => {
    const peer = (await tx.get("peer", child.childId))!;
    await tx.put("peer", { ...peer, authority, sandboxId: "computer" });
    await tx.put("spawn", { ...child, state: "ready" });
  });
  const grandchild = await reserve(child.childId, "grandchild");
  await sessions.getOrCreateByThread("grandchild", "dm", root.scopeId, undefined, "web", grandchild.childId);
  await repository.transaction([`tree:${root.id}`], async (tx) => {
    const peer = (await tx.get("peer", grandchild.childId))!;
    await tx.put("peer", { ...peer, authority, sandboxId: "grandchild-computer" });
    await tx.put("spawn", { ...grandchild, state: "ready" });
  });
  const pending = await reserve(root.id, "pending");
  await spawning.lowerLimit(child.childId, 1);
  await sessions.deleteSession(child.childId);
  await lifecycle.sweep();
  const tombstone = (await repository.get("peer", child.childId))!;
  assert.equal(tombstone.state, "deleted");
  assert.equal(tombstone.authority, null);
  assert.equal(tombstone.rootId, root.id);
  assert.equal(tombstone.descendantLimit, 1);
  assert.deepEqual((await repository.get("peer", grandchild.childId))?.ancestors, [root.id, child.childId]);
  assert.equal((await spawning.inspect(root.id)).count, 2);
  assert.equal((await repository.get("peer", grandchild.childId))?.state, "active");
  assert.ok(
    (await spawning.tree(root.id)).some((node) => node.peer.id === child.childId && node.peer.state === "deleted"),
  );
  assert.equal((await repository.get("peer", pending.childId))?.state, "active");
  await assert.rejects(reserve(grandchild.childId, "too-deep"), /subtree descendant limit reached/);
  await lifecycle.sweep();
  assert.equal((await spawning.inspect(root.id)).count, 2);
  await assert.rejects(reserve(child.childId, "cannot-resurrect"), /agent not found/);
  await sessions.getOrCreateByThread("partial-child", "dm", root.scopeId, undefined, "web", pending.childId);
  await sessions.deleteSession(pending.childId);
  await lifecycle.sweep();
  assert.equal((await repository.get("peer", pending.childId))?.state, "deleted");
  assert.equal((await spawning.inspect(root.id)).count, 2);
  assert.ok(
    (await spawning.tree(root.id)).some((node) => node.peer.id === pending.childId && node.peer.state === "deleted"),
  );
  await assert.rejects(spawning.lowerLimit(root.id, 1), /limits may only decrease/);
  await spawning.lowerLimit(root.id, 2);
  await assert.rejects(reserve(root.id, "cannot-reuse-reservation"), /subtree descendant limit reached/);
});
