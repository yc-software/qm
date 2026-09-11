import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createSwarmStore, type SwarmStorage } from "../src/swarms/swarm-store.ts";
import { createSwarmService } from "../src/swarms/swarm-service.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL to a disposable Postgres database";

test(
  "Postgres completed runs cannot authorize agent operations but remain valid human initialization history",
  { skip },
  async () => {
    const factory = createPostgresMapFactory(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const backing = factory.map<SwarmStorage>("swarms");
    const store = createSwarmStore(backing);
    let rootId: string | undefined;
    try {
      const fixture = await swarmFixture({
        store,
        sessions,
        runs: runtime.runs,
        lock: createPostgresAdvisoryLock(factory.pool),
      });
      rootId = fixture.root.id;
      if (fixture.caller.kind !== "agent") throw new Error("wrong caller");
      const run = (await runtime.runs.get(fixture.caller.claims.runId!))!;
      assert.equal(run.status, "running");
      assert.equal(await runtime.runs.complete(run.id, run.leaseToken!, { status: "ok", reply: "Done" }), true);
      assert.equal((await runtime.runs.get(run.id))!.status, "done");
      await assert.rejects(
        fixture.service.spawn(fixture.caller, { requestId: "completed", text: "Work" }),
        /active capability run required/,
      );
      assert.equal(await store.get(rootId), null);
      const human = { kind: "human" as const, actorId: "alice", sessionId: rootId, runId: run.id };
      await fixture.service.spawn(human, { requestId: "human", text: "Work" });
      await assert.rejects(fixture.service.inspect(fixture.caller), /active capability run required/);
    } finally {
      if (rootId) await backing.delete(rootId);
      await runtime.close();
      await factory.pool.close();
    }
  },
);

test("Postgres swarms atomically bound concurrent pools across independent clients", { skip }, async () => {
  const first = createPostgresMapFactory(databaseUrl!);
  const second = createPostgresMapFactory(databaseUrl!);
  const sessions = createPostgresSessionStore(databaseUrl!);
  const runtime = createPostgresRunStore(databaseUrl!);
  const store = createSwarmStore(first.map<SwarmStorage>("swarms"));
  try {
    const fixture = await swarmFixture({
      store,
      sessions,
      runs: runtime.runs,
      lock: createPostgresAdvisoryLock(first.pool),
    });
    const sibling = createSwarmService({
      ...fixture.serviceOptions,
      store: createSwarmStore(second.map<SwarmStorage>("swarms")),
      lock: createPostgresAdvisoryLock(second.pool),
    });
    const attempts = await Promise.allSettled([
      fixture.service.spawn(fixture.caller, { requestId: "first", count: 20, text: "Work" }),
      sibling.spawn(fixture.caller, { requestId: "second", count: 20, text: "Work" }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal((await sibling.inspect(fixture.caller)).peers.length, 21);
    await assert.rejects(
      store.update(fixture.root.id, (swarm) => {
        swarm.notificationCount = 999;
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal((await store.get(fixture.root.id))!.notificationCount, 20);
    const applied = await first.pool.q("SELECT id FROM qm_schema_migrations WHERE id = 'durable-map/swarms/0001'");
    assert.equal(applied.length, 1);
    await first.map<SwarmStorage>("swarms").delete(fixture.root.id);
  } finally {
    await runtime.close();
    await Promise.all([first.pool.close(), second.pool.close()]);
  }
});

test("Postgres session, message, reservation and outbox recovery deduplicate durable work", { skip }, async () => {
  const first = createPostgresMapFactory(databaseUrl!);
  const second = createPostgresMapFactory(databaseUrl!);
  const sessions = createPostgresSessionStore(databaseUrl!);
  const restoredSessions = createPostgresSessionStore(databaseUrl!);
  const runtime = createPostgresRunStore(databaseUrl!);
  const restoredRuntime = createPostgresRunStore(databaseUrl!);
  const store = createSwarmStore(first.map<SwarmStorage>("swarms"));
  try {
    const fixture = await swarmFixture({
      store,
      sessions,
      runs: runtime.runs,
      lock: createPostgresAdvisoryLock(first.pool),
    });
    const [member] = await fixture.service.spawn(fixture.caller, {
      requestId: "pool",
      text: "Work",
      context: { role: "worker" },
    });
    await fixture.service.sweep();
    const initial = (await store.get(fixture.root.id))!;
    const notification = initial.messages[0]!.notifications[member!.id]!;
    assert.ok(notification.runId);
    const sibling = createSwarmService({
      ...fixture.serviceOptions,
      sessions: restoredSessions,
      runs: restoredRuntime.runs,
      store: createSwarmStore(second.map<SwarmStorage>("swarms")),
      lock: createPostgresAdvisoryLock(second.pool),
    });
    await store.update(initial.id, (swarm) => {
      swarm.messages[0]!.notifications[member!.id] = { state: "pending" };
    });
    await Promise.all([fixture.service.sweep(), sibling.sweep()]);
    const recovered = (await store.get(initial.id))!;
    assert.equal(recovered.messages[0]!.notifications[member!.id]!.runId, notification.runId);
    const recoveredRun = (await restoredRuntime.runs.get(notification.runId!))!;
    assert.ok(await sibling.binding({ ...recoveredRun.request, runId: recoveredRun.id, attempt: 1, background: true }));
    const session = await restoredSessions.get(recovered.members[1]!.sessionId!);
    assert.equal(session?.scopeId, initial.scopeId);
    assert.ok(await restoredSessions.getForParticipant(session!.id, "alice"));
    const message = { requestId: "message", audience: ".[]", text: "Question" };
    const sent = await Promise.all([
      fixture.service.send(fixture.caller, message),
      sibling.send(fixture.caller, message),
    ]);
    assert.equal(sent[0]!.id, sent[1]!.id);
    assert.equal((await store.get(initial.id))!.messages.length, 2);
    const arbitrary = JSON.parse('{"__proto__":{"role":"worker"},"values":[null,"\\u0000","\\ud800"]}') as unknown;
    await sibling.context(fixture.caller, arbitrary);
    assert.deepEqual((await fixture.service.inspect(fixture.caller)).self.context, arbitrary);
    const binaryText = await sibling.send(fixture.caller, {
      requestId: "unicode",
      audience: "empty",
      text: "body\u0000\ud800",
      notify: false,
    });
    assert.equal(
      (await fixture.service.read(fixture.caller, { after: binaryText.seq - 1 }))[0]!.text,
      "body\u0000\ud800",
    );
    await first.map<SwarmStorage>("swarms").delete(initial.id);
  } finally {
    await Promise.all([runtime.close(), restoredRuntime.close()]);
    await Promise.all([first.pool.close(), second.pool.close()]);
  }
});
