import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createSwarmStore, SWARM_LIMITS, type SwarmStorage } from "../src/swarms/swarm-store.ts";
import { createSwarmService } from "../src/swarms/swarm-service.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

const baseUrl = process.env.DATABASE_URL;
const schema = `swarm_test_${process.pid}`;
const isolatedUrl = baseUrl ? new URL(baseUrl) : undefined;
isolatedUrl?.searchParams.set("options", `-c search_path=${schema}`);
const databaseUrl = isolatedUrl?.toString();
before(async () => {
  if (!baseUrl) return;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: baseUrl });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await pool.end();
  }
});
after(async () => {
  if (!baseUrl) return;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: baseUrl });
  try {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
});
const skip = databaseUrl ? false : "set DATABASE_URL to a disposable Postgres database";

test(
  "Postgres delayed ready acknowledgment cannot roll back a delivered worker across phase locks",
  { skip },
  async (context) => {
    const factory = createPostgresMapFactory(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const backing = factory.map<SwarmStorage>("swarms");
    const fixture = await swarmFixture({
      store: createSwarmStore(backing, { runs: runtime.runs, sessions, pg: factory.pool }),
      sessions,
      runs: runtime.runs,
      lock: createPostgresAdvisoryLock(factory.pool),
    });
    const second = createSwarmService({
      ...fixture.serviceOptions,
      lock: createPostgresAdvisoryLock(factory.pool),
    });
    const [worker] = await fixture.service.spawn(fixture.caller, { requestId: "initial", text: "Work" });
    const update = fixture.store.update.bind(fixture.store);
    const readyWritten = Promise.withResolvers<void>();
    const acknowledgment = Promise.withResolvers<void>();
    const resourceLock = `swarm-reconcile:${fixture.root.id}`;
    let gated = false;
    fixture.store.update = async (id, mutate) => {
      const updated = await update(id, mutate);
      if (!gated && updated.members.find((member) => member.id === worker!.id)?.state === "ready") {
        gated = true;
        readyWritten.resolve();
        await acknowledgment.promise;
      }
      return updated;
    };
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    try {
      const firstSweep = fixture.service.sweep();
      await readyWritten.promise;
      assert.equal(await fixture.serviceOptions.lock.tryWithLock!(resourceLock, async () => true), null);
      await second.sweep();
      const delivered = (await fixture.store.get(fixture.root.id))!;
      const notification = delivered.messages[0]!.notifications[worker!.id]!;
      assert.equal(notification.state, "queued");
      const run = await fixture.runs.claimById(notification.runId!, "delayed-ready-worker", 60_000);
      assert.ok(run);
      assert.ok(await second.binding({ ...run.request, runId: run.id }));
      context.mock.timers.tick(SWARM_LIMITS.reconcileMs + 1);
      await firstSweep;
      assert.equal(await fixture.serviceOptions.lock.tryWithLock!(resourceLock, async () => true), null);
      acknowledgment.resolve();
      context.mock.timers.reset();
      await fixture.serviceOptions.lock.withLock(resourceLock, async () => undefined);
      await second.sweep();
      const final = (await fixture.store.get(fixture.root.id))!;
      const member = final.members.find((peer) => peer.id === worker!.id)!;
      assert.equal(member.state, "ready");
      assert.equal(member.cleanupPending, undefined);
      assert.equal(member.error, undefined);
      assert.equal((await fixture.records.get(worker!.id))!.state, "ready");
      assert.ok(await sessions.get(member.sessionId!));
      assert.equal((await runtime.runs.get(run.id))!.status, "running");
      assert.deepEqual(final.messages[0]!.notifications[worker!.id], notification);
      assert.ok(await second.binding({ ...run.request, runId: run.id }));
    } finally {
      acknowledgment.resolve();
      context.mock.timers.reset();
      await fixture.serviceOptions.lock.withLock(resourceLock, async () => undefined);
      await backing.delete(fixture.root.id);
      const pool = await factory.pool.pool();
      const clients = await Promise.all(Array.from({ length: pool.idleCount }, () => pool.connect()));
      for (const client of clients) client.release(true);
      await runtime.close();
      await factory.pool.close();
    }
  },
);

test("Postgres pending selection retains one live query across sweep timeouts", { skip }, async (context) => {
  const factory = createPostgresMapFactory(databaseUrl!);
  const backing = factory.map<SwarmStorage>("swarms");
  const store = createSwarmStore(backing);
  const { service } = await swarmFixture({ store });
  await backing.select({ limit: 1 });
  const pool = await factory.pool.sessionPool();
  const blocker = await pool.connect();
  const observer = await pool.connect();
  const waiting = async (): Promise<number> => {
    const result = await observer.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1",
      ["SELECT json% FROM swarms%"],
    );
    return result.rows[0]!.count;
  };
  const pending = store.pending.bind(store);
  let selections = 0;
  let selection: ReturnType<typeof pending> | undefined;
  store.pending = (afterId) => {
    selections++;
    selection = pending(afterId);
    return selection;
  };
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE swarms IN ACCESS EXCLUSIVE MODE");
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    for (let iteration = 0; iteration < 6; iteration++) {
      const sweep = assert.rejects(service.sweep(), /swarm pending batch timed out/);
      for (let attempt = 0; attempt < 100 && (await waiting()) === 0; attempt++) await sleep(5);
      context.mock.timers.tick(SWARM_LIMITS.reconcileMs + 1);
      await sweep;
      assert.equal(selections, 1);
      assert.equal(await waiting(), 1);
    }
    await blocker.query("ROLLBACK");
    await selection;
    context.mock.timers.reset();
    await service.sweep();
    assert.equal(selections, 2);
    assert.equal(await waiting(), 0);
  } finally {
    context.mock.timers.reset();
    await blocker.query("ROLLBACK");
    await selection;
    blocker.release();
    observer.release();
    await factory.pool.close();
  }
});

test(
  "Postgres completed runs cannot authorize agent operations but remain valid human initialization history",
  { skip },
  async () => {
    const factory = createPostgresMapFactory(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const backing = factory.map<SwarmStorage>("swarms");
    const store = createSwarmStore(backing, { runs: runtime.runs, sessions, pg: factory.pool });
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
  const store = createSwarmStore(first.map<SwarmStorage>("swarms"), { runs: runtime.runs, sessions, pg: first.pool });
  try {
    const fixture = await swarmFixture({
      store,
      sessions,
      runs: runtime.runs,
      lock: createPostgresAdvisoryLock(first.pool),
    });
    const sibling = createSwarmService({
      ...fixture.serviceOptions,
      store: createSwarmStore(second.map<SwarmStorage>("swarms"), { runs: runtime.runs, sessions, pg: second.pool }),
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
  const store = createSwarmStore(first.map<SwarmStorage>("swarms"), { runs: runtime.runs, sessions, pg: first.pool });
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
      store: createSwarmStore(second.map<SwarmStorage>("swarms"), { runs: runtime.runs, sessions, pg: second.pool }),
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

test("Postgres rolls back a swarm mutation whose run expires while waiting for the write lock", { skip }, async () => {
  const factory = createPostgresMapFactory(databaseUrl!);
  const runtime = createPostgresRunStore(databaseUrl!);
  const sessions = createPostgresSessionStore(databaseUrl!);
  const store = createSwarmStore(factory.map<SwarmStorage>("swarms"), {
    runs: runtime.runs,
    sessions,
    pg: factory.pool,
  });
  const fixture = await swarmFixture({
    store,
    sessions,
    runs: runtime.runs,
    lock: createPostgresAdvisoryLock(factory.pool),
  });
  const client = await (await factory.pool.pool()).connect();
  try {
    await fixture.service.spawn(fixture.caller, { requestId: "initial", text: "Work" });
    if (fixture.caller.kind !== "agent") throw new Error("wrong caller");
    const run = (await runtime.runs.get(fixture.caller.claims.runId!))!;
    const before = await store.get(fixture.root.id);
    await runtime.runs.heartbeat(run.id, run.leaseToken!, 200);
    await client.query("BEGIN");
    await client.query("SELECT v FROM durable_map_versions WHERE tbl='swarms' FOR UPDATE");
    const mutation = assert.rejects(
      fixture.service.context(fixture.caller, { changed: true }),
      /active capability run required/,
    );
    await sleep(300);
    await client.query("COMMIT");
    await mutation;
    assert.deepEqual(await store.get(fixture.root.id), before);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await runtime.close();
    await factory.pool.close();
  }
});
