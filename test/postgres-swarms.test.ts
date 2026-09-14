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
    const message = { requestId: "message", audience: "all" as const, text: "Question" };
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
      audience: [],
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

for (const scenario of ["same request", "distinct requests", "conflicting settings"] as const) {
  test(`Postgres complete initial pools race safely across independent clients: ${scenario}`, { skip }, async () => {
    const first = createPostgresMapFactory(databaseUrl!);
    const second = createPostgresMapFactory(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const stores = [first, second].map((factory) =>
      createSwarmStore(factory.map<SwarmStorage>("swarms"), {
        runs: runtime.runs,
        sessions,
        pg: factory.pool,
      }),
    );
    try {
      const f = await swarmFixture({ store: stores[0]!, sessions, runs: runtime.runs });
      const sibling = createSwarmService({ ...f.serviceOptions, store: stores[1]! });
      const ready = Promise.withResolvers<void>();
      let arrivals = 0;
      for (const store of stores) {
        const create = store.create.bind(store);
        store.create = async (...args) => {
          if (++arrivals === 2) ready.resolve();
          await ready.promise;
          return create(...args);
        };
      }
      const results = await Promise.allSettled([
        f.service.spawn(f.caller, { requestId: "initial", text: "work", settings: { turnMs: 777 } }),
        sibling.spawn(f.caller, {
          requestId: scenario === "same request" ? "initial" : "other",
          text: "work",
          settings: { turnMs: scenario === "conflicting settings" ? 888 : 777 },
        }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, scenario === "conflicting settings" ? 1 : 2);
      const swarm = (await stores[0]!.get(f.root.id))!;
      const pools = scenario === "distinct requests" ? 2 : 1;
      assert.equal(swarm.members.length, pools + 1);
      assert.equal(swarm.messages.length, pools);
      assert.equal(Object.keys(swarm.spawnRequests).length, pools);
      assert.equal(swarm.notificationCount, pools);
      assert.equal(swarm.pending, true);
      assert.equal(swarm.template.turnWallClockMs, swarm.settings.turnMs);
      if (scenario === "same request") assert.deepEqual(results[0], results[1]);
      await first.map<SwarmStorage>("swarms").delete(f.root.id);
    } finally {
      await runtime.close();
      await Promise.all([first.pool.close(), second.pool.close()]);
    }
  });
}

test(
  "Postgres lost initial acknowledgment leaves one complete pool that a new client can retry",
  { skip },
  async () => {
    const first = createPostgresMapFactory(databaseUrl!);
    const second = createPostgresMapFactory(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const store = createSwarmStore(first.map<SwarmStorage>("swarms"), { runs: runtime.runs, sessions, pg: first.pool });
    try {
      const f = await swarmFixture({ store, sessions, runs: runtime.runs });
      const create = store.create.bind(store);
      store.create = async (...args) => {
        await create(...args);
        throw new Error("lost acknowledgment");
      };
      const request = { requestId: "initial", text: "work", settings: { turnMs: 777 } };
      await assert.rejects(f.service.spawn(f.caller, request), /lost acknowledgment/);
      const restartedStore = createSwarmStore(second.map<SwarmStorage>("swarms"), {
        runs: runtime.runs,
        sessions,
        pg: second.pool,
      });
      const restarted = createSwarmService({ ...f.serviceOptions, store: restartedStore });
      const committed = (await restartedStore.get(f.root.id))!;
      assert.equal(committed.members.length, 2);
      assert.equal(committed.messages.length, 1);
      assert.equal(committed.pending, true);
      const workers = await restarted.spawn(f.caller, request);
      assert.equal(workers[0]!.id, committed.members[1]!.id);
      assert.deepEqual(await restartedStore.get(f.root.id), committed);
      await first.map<SwarmStorage>("swarms").delete(f.root.id);
    } finally {
      await runtime.close();
      await Promise.all([first.pool.close(), second.pool.close()]);
    }
  },
);

test("Postgres initial pool expires atomically while waiting for the write lock", { skip }, async (context) => {
  const factory = createPostgresMapFactory(databaseUrl!);
  const runtime = createPostgresRunStore(databaseUrl!);
  const sessions = createPostgresSessionStore(databaseUrl!);
  const store = createSwarmStore(factory.map<SwarmStorage>("swarms"), {
    runs: runtime.runs,
    sessions,
    pg: factory.pool,
  });
  const f = await swarmFixture({ store, sessions, runs: runtime.runs });
  const client = await (await factory.pool.pool()).connect();
  const entered = Promise.withResolvers<void>();
  const create = store.create.bind(store);
  store.create = async (...args) => {
    entered.resolve();
    return create(...args);
  };
  try {
    await store.get(f.root.id);
    await client.query("INSERT INTO durable_map_versions (tbl,v) VALUES ('swarms',1) ON CONFLICT DO NOTHING");
    await client.query("BEGIN");
    await client.query("SELECT v FROM durable_map_versions WHERE tbl='swarms' FOR UPDATE");
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const rejected = assert.rejects(
      f.service.spawn(f.caller, { requestId: "initial", text: "work", settings: { lifetimeMs: 10_000 } }),
      /work window expired/,
    );
    await entered.promise;
    context.mock.timers.tick(20_000);
    await client.query("COMMIT");
    await rejected;
    assert.equal(await store.get(f.root.id), null);
  } finally {
    context.mock.timers.reset();
    await client.query("ROLLBACK");
    client.release();
    await runtime.close();
    await factory.pool.close();
  }
});

test(
  "Postgres public identities survive new connections, preserve private context, and serialize version updates",
  { skip },
  async () => {
    const first = createPostgresMapFactory(databaseUrl!);
    const second = createPostgresMapFactory(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const store = createSwarmStore(first.map<SwarmStorage>("swarms"), { runs: runtime.runs, sessions, pg: first.pool });
    const otherStore = createSwarmStore(second.map<SwarmStorage>("swarms"), {
      runs: runtime.runs,
      sessions,
      pg: second.pool,
    });
    try {
      const fixture = await swarmFixture({ store, sessions, runs: runtime.runs });
      const other = createSwarmService({ ...fixture.serviceOptions, store: otherStore });
      const input = { version: 0, name: "Public researcher", character: { role: "research", emoji: "🧪" } };
      const results = await Promise.allSettled([
        fixture.service.character(fixture.caller, input),
        other.character(fixture.caller, input),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(
        results.filter((result) => result.status === "rejected" && /version conflict/.test(String(result.reason)))
          .length,
        1,
      );
      const firstIdentity = (await other.discover(fixture.caller, { search: "Public researcher" })).peers[0]!;
      assert.deepEqual(firstIdentity.character, input.character);
      await fixture.service.context(fixture.caller, { secret: "never-public", nul: "\u0000", surrogate: "\ud800" });
      const changes = await Promise.allSettled([
        fixture.service.character(fixture.caller, { ...input, version: 1, name: "Edit A" }),
        other.character(fixture.caller, { ...input, version: 1, name: "Edit B" }),
      ]);
      assert.equal(changes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(changes.filter((result) => result.status === "rejected").length, 1);
      const latest = (await other.discover(fixture.caller, { search: "Edit" })).peers.find(
        (peer) => peer.id === firstIdentity.id,
      )!;
      assert.equal(latest.version, 2);
      assert.ok(!JSON.stringify(latest).includes("never-public"));
      assert.deepEqual((await otherStore.get(fixture.root.id))!.members[0]!.context, {
        secret: "never-public",
        nul: "\u0000",
        surrogate: "\ud800",
      });
      assert.equal((await otherStore.get(fixture.root.id))!.messages.length, 0);
      assert.equal((await otherStore.get(fixture.root.id))!.pending, false);
      await first.pool.close();
      assert.deepEqual(
        (await other.discover(fixture.caller, { search: latest.name })).peers.find((peer) => peer.id === latest.id),
        latest,
      );
    } finally {
      await runtime.close();
      await Promise.all([first.pool.close(), second.pool.close()]);
    }
  },
);

test("Postgres public discovery filters foreign revoked roots before the visible page cursor", { skip }, async () => {
  const factory = createPostgresMapFactory(databaseUrl!);
  const runtime = createPostgresRunStore(databaseUrl!);
  const sessions = createPostgresSessionStore(databaseUrl!);
  const store = createSwarmStore(factory.map<SwarmStorage>("swarms"), {
    runs: runtime.runs,
    sessions,
    pg: factory.pool,
  });
  try {
    const viewer = await swarmFixture({ store, sessions, runs: runtime.runs });
    const bob = await swarmFixture({ actorId: "bob", store, sessions, runs: runtime.runs });
    const carol = await swarmFixture({ actorId: "carol", store, sessions, runs: runtime.runs });
    await bob.service.character(bob.caller, { version: 0, name: "Cross-scope Bob", character: {} });
    const visible = await carol.service.character(carol.caller, {
      version: 0,
      name: "Cross-scope Carol",
      character: {},
    });
    viewer.state.blockedActors.add("bob");
    assert.deepEqual(await viewer.service.discover(viewer.caller, { limit: 1, search: "Cross-scope" }), {
      peers: [visible],
    });
    await assert.rejects(
      viewer.service.read({ kind: "human", actorId: "alice", sessionId: carol.root.id }, {}),
      /access denied/,
    );
    await store.update(carol.root.id, (swarm) => {
      swarm.expiresAt = Date.now() - 1;
    });
    assert.deepEqual(await viewer.service.discover(viewer.caller, { limit: 1, search: "Cross-scope" }), { peers: [] });
  } finally {
    await runtime.close();
    await factory.pool.close();
  }
});

test(
  "Postgres public character rolls back when its source lease expires at the write lock",
  { skip },
  async (context) => {
    const factory = createPostgresMapFactory(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const store = createSwarmStore(factory.map<SwarmStorage>("swarms"), {
      runs: runtime.runs,
      sessions,
      pg: factory.pool,
    });
    const fixture = await swarmFixture({ store, sessions, runs: runtime.runs });
    const client = await (await factory.pool.pool()).connect();
    const observer = await (await factory.pool.pool()).connect();
    try {
      await fixture.service.character(fixture.caller, { version: 0, name: "Before", character: {} });
      await client.query("BEGIN");
      await client.query("SELECT v FROM durable_map_versions WHERE tbl='swarms' FOR UPDATE");
      context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const rejected = assert.rejects(
        fixture.service.character(fixture.caller, { version: 1, name: "After", character: {} }),
        /active capability run required/,
      );
      const blockerId = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const observed = await observer.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE 'INSERT INTO durable_map_versions%') AS waiting",
          [blockerId],
        );
        waiting = observed.rows[0]!.waiting;
        if (!waiting) await sleep(5);
      }
      assert.ok(waiting, "publication must wait for the write lock after validating its active run");
      context.mock.timers.tick(120_000);
      await client.query("COMMIT");
      await rejected;
      const identity = (await store.get(fixture.root.id))!.members[0]!.publicIdentity!;
      assert.equal(identity.name, "Before");
      assert.equal(identity.version, 1);
    } finally {
      context.mock.timers.reset();
      await client.query("ROLLBACK");
      client.release();
      observer.release();
      await runtime.close();
      await factory.pool.close();
    }
  },
);

test(
  "Postgres public outbox survives independent writers, lost acknowledgment, and recipient metadata edits",
  { skip },
  async () => {
    const first = createPostgresMapFactory(databaseUrl!);
    const second = createPostgresMapFactory(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const store = createSwarmStore(first.map<SwarmStorage>("swarms"), { runs: runtime.runs, sessions, pg: first.pool });
    const otherStore = createSwarmStore(second.map<SwarmStorage>("swarms"), {
      runs: runtime.runs,
      sessions,
      pg: second.pool,
    });
    try {
      const alice = await swarmFixture({
        store,
        sessions,
        runs: runtime.runs,
        lock: createPostgresAdvisoryLock(first.pool),
      });
      const bob = await swarmFixture({ actorId: "pg-bob", store, sessions, runs: runtime.runs });
      const sender = await alice.service.character(alice.caller, {
        version: 0,
        name: "PG public source",
        character: {},
      });
      const recipient = await bob.service.character(bob.caller, {
        version: 0,
        name: "PG public recipient",
        character: { before: true },
      });
      const restart = createSwarmService({
        ...alice.serviceOptions,
        store: otherStore,
        lock: createPostgresAdvisoryLock(second.pool),
      });
      const input = {
        requestId: "pg-public",
        audience: [recipient.id],
        versions: { [recipient.id]: 1 },
        text: "Durable public work 🧪",
      };
      const [message, replay] = await Promise.all([
        alice.service.publish(alice.caller, input),
        restart.publish(alice.caller, input),
      ]);
      assert.deepEqual(message, replay);
      await bob.service.character(bob.caller, { version: 1, name: "Changed PG recipient", character: { after: true } });
      assert.deepEqual(await restart.publish(alice.caller, input), message);
      const enqueue = runtime.runs.enqueue.bind(runtime.runs);
      let lostAck = false;
      runtime.runs.enqueue = async (input) => {
        const result = await enqueue(input);
        if (!lostAck && input.request.swarm?.messageId === message.id) {
          lostAck = true;
          throw new Error("injected public enqueue acknowledgment loss");
        }
        return result;
      };
      await alice.service.sweep();
      assert.equal(lostAck, true);
      await first.pool.close();
      await restart.sweep();
      const queued = (await runtime.runs.getByDedupKey(`swarm:${message.id}:${recipient.id}`))!;
      assert.ok(queued);
      assert.equal(queued.request.actor.id, "pg-bob");
      assert.equal(queued.request.swarm?.swarmId, bob.root.id);
      assert.ok(!JSON.stringify(queued.request).includes(alice.root.id));
      assert.equal((await otherStore.get(bob.root.id))!.notificationCount, 1);
      const read = await restart.readPublic(alice.caller, { id: message.id });
      assert.equal(read.messages.length, 1);
      assert.deepEqual(read.messages[0]!.sender, sender);
      assert.deepEqual(read.messages[0]!.audience, [recipient]);
      assert.equal(read.messages[0]!.text, input.text);
      assert.equal(read.messages[0]!.notifications[recipient.id]!.state, "queued");
      assert.ok(!JSON.stringify(read).includes(bob.root.id));
      await runtime.runs.complete(bob.caller.claims.runId!, bob.caller.claims.runLeaseToken!, {
        status: "ok",
        reply: "Done",
      });
      const claimed = (await runtime.runs.claimById(queued.id, "public-pg", 60_000))!;
      assert.equal(
        (
          await restart.binding({
            ...claimed.request,
            runId: claimed.id,
            runLeaseToken: claimed.leaseToken!,
            attempt: claimed.attempts,
          })
        )?.publicMessage,
        true,
      );
    } finally {
      await runtime.close();
      await Promise.all([first.pool.close(), second.pool.close()]);
    }
  },
);

test("Postgres public reads use visible chronological cursors and never return private targets", { skip }, async () => {
  const factory = createPostgresMapFactory(databaseUrl!);
  const runtime = createPostgresRunStore(databaseUrl!);
  const sessions = createPostgresSessionStore(databaseUrl!);
  const store = createSwarmStore(factory.map<SwarmStorage>("swarms"), {
    runs: runtime.runs,
    sessions,
    pg: factory.pool,
  });
  try {
    const fixture = await swarmFixture({ store, sessions, runs: runtime.runs });
    await fixture.service.character(fixture.caller, { version: 0, name: "PG page author", character: {} });
    const privateMessage = await fixture.service.send(fixture.caller, {
      requestId: "private-page",
      audience: [],
      text: "Never public",
    });
    const first = await fixture.service.publish(fixture.caller, {
      requestId: "public-page-a",
      audience: [],
      text: "PG chronological paging A",
    });
    await sleep(2);
    const second = await fixture.service.publish(fixture.caller, {
      requestId: "public-page-b",
      audience: [],
      text: "PG chronological paging B",
    });
    const page = await fixture.service.readPublic(fixture.caller, { limit: 1, search: "PG chronological paging" });
    assert.deepEqual(page.messages, [second]);
    assert.ok(page.nextAfter?.endsWith(second.id));
    const older = await fixture.service.readPublic(fixture.caller, {
      after: page.nextAfter,
      limit: 1,
      search: "PG chronological paging",
    });
    assert.deepEqual(older.messages, [first]);
    assert.equal(older.nextAfter, undefined);
    assert.deepEqual(await fixture.service.readPublic(fixture.caller, { id: privateMessage.id }), { messages: [] });
  } finally {
    await runtime.close();
    await factory.pool.close();
  }
});

test(
  "Postgres controls and held runs survive independent connections without losing payloads, dedupe, or claim budgets",
  { skip },
  async () => {
    const first = createPostgresMapFactory(databaseUrl!);
    const second = createPostgresMapFactory(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const otherRuntime = createPostgresRunStore(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    const store = createSwarmStore(first.map<SwarmStorage>("swarms"), { runs: runtime.runs, sessions, pg: first.pool });
    const otherStore = createSwarmStore(second.map<SwarmStorage>("swarms"), {
      runs: otherRuntime.runs,
      sessions,
      pg: second.pool,
    });
    const { createPostgresRunSignalStore } = await import("../src/runs/postgres-run-signal-store.ts");
    const signals = createPostgresRunSignalStore(databaseUrl!);
    try {
      const fixture = await swarmFixture({
        store,
        sessions,
        runs: runtime.runs,
        lock: createPostgresAdvisoryLock(first.pool, { pollMs: 5 }),
      });
      const service = createSwarmService({ ...fixture.serviceOptions, signals });
      const restarted = createSwarmService({
        ...fixture.serviceOptions,
        signals,
        runs: otherRuntime.runs,
        store: otherStore,
        lock: createPostgresAdvisoryLock(second.pool, { pollMs: 5 }),
      });
      const caller = { kind: "human" as const, actorId: "alice", sessionId: fixture.root.id };
      const [member] = await service.spawn(fixture.caller, {
        requestId: "pg-control",
        text: "Durable controlled work",
      });
      await service.sweep();
      const pending = (await runtime.runs.inFlightForThread(member!.threadRef))[0]!;
      const original = structuredClone(pending);
      const claims = await Promise.all([
        runtime.runs.claimById(pending.id, "one", 60_000),
        otherRuntime.runs.claimById(pending.id, "two", 60_000),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claimed = claims.find(Boolean)!;
      const changes = await Promise.allSettled([
        service.control(caller, { memberId: member!.id, command: "pause", version: 0 }),
        restarted.control(caller, { memberId: member!.id, command: "pause", version: 0 }),
      ]);
      assert.equal(changes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(changes.filter((result) => result.status === "rejected").length, 1);
      await assert.rejects(
        restarted.binding({
          ...claimed.request,
          runId: claimed.id,
          runLeaseToken: claimed.leaseToken!,
          attempt: claimed.attempts,
        }),
        /paused/,
      );
      const held = (await otherRuntime.runs.get(pending.id))!;
      assert.equal(held.status, "pending");
      assert.equal(held.held, true);
      assert.equal(held.attempts, 0);
      assert.equal(held.errorAttempts, 0);
      assert.deepEqual(held.request, original.request);
      assert.equal(await otherRuntime.runs.claimById(pending.id, "blocked", 60_000), null);
      assert.equal(
        await otherRuntime.runs.setHeld(pending.id, true, claimed.leaseToken!),
        false,
        "old lease cannot refund twice",
      );
      await first.pool.close();
      await runtime.close();
      await restarted.control(caller, { memberId: member!.id, command: "resume", version: 1 });
      assert.equal((await otherRuntime.runs.get(pending.id))!.held, undefined);
      await signals.send(pending.id, {
        kind: "abort",
        dedupeKey: `swarm-control:${fixture.root.id}:${pending.id}:crash`,
      });
      await signals.send(pending.id, { kind: "abort", dedupeKey: "pg-user-stop" });
      const resumed = (await otherRuntime.runs.claimById(pending.id, "resumed", 60_000))!;
      assert.equal(resumed.attempts, 1);
      assert.ok(
        await restarted.binding({
          ...resumed.request,
          runId: resumed.id,
          runLeaseToken: resumed.leaseToken!,
          attempt: resumed.attempts,
        }),
      );
      assert.deepEqual(
        (await signals.takePending(pending.id)).map((signal) => signal.dedupeKey),
        ["pg-user-stop"],
      );
      assert.ok(await otherRuntime.runs.setHeld(resumed.id, true, resumed.leaseToken!));
      await restarted.control(caller, { memberId: member!.id, command: "stop" });
      const cancelled = (await otherRuntime.runs.get(pending.id))!;
      assert.equal(cancelled.result?.stopped, true);
      assert.equal(cancelled.errorAttempts, 0);
      assert.equal((await otherRuntime.runs.getByDedupKey(original.dedupKey!))!.id, pending.id);
      await assert.rejects(restarted.control(caller, { memberId: member!.id, command: "resume" }), /cannot resume/);
    } finally {
      await signals.close?.();
      await runtime.close();
      await otherRuntime.close();
      await Promise.all([first.pool.close(), second.pool.close()]);
    }
  },
);

test(
  "Postgres lowered descendant caps persist and serialize concurrent reservations without a second counter",
  { skip },
  async () => {
    const a = createPostgresMapFactory(databaseUrl!);
    const b = createPostgresMapFactory(databaseUrl!);
    const runtime = createPostgresRunStore(databaseUrl!);
    const sessions = createPostgresSessionStore(databaseUrl!);
    try {
      const options = { runs: runtime.runs, sessions };
      const f = await swarmFixture({
        ...options,
        store: createSwarmStore(a.map<SwarmStorage>("swarms"), { ...options, pg: a.pool }),
        lock: createPostgresAdvisoryLock(a.pool),
      });
      const other = createSwarmService({
        ...f.serviceOptions,
        store: createSwarmStore(b.map<SwarmStorage>("swarms"), { ...options, pg: b.pool }),
        lock: createPostgresAdvisoryLock(b.pool),
      });
      await f.service.character(f.caller, { version: 0, name: "Capped", character: {} });
      await f.service.limit(f.caller, 1);
      const results = await Promise.allSettled([
        f.service.spawn(f.caller, { requestId: "a", text: "Work" }),
        other.spawn(f.caller, { requestId: "b", text: "Work" }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      assert.equal((await other.inspect(f.caller)).self.descendantLimit, 1);
      await other.sweep();
      const caller = { kind: "human" as const, actorId: "alice", sessionId: f.root.id };
      const listing = await other.board(caller, { visibility: "private" });
      assert.equal(listing.members.length, 2);
      assert.equal(listing.members[0]!.descendantLimit, 1);
      assert.equal(listing.messages.length, 1);
      const detail = await other.board(caller, { visibility: "private", id: listing.messages[0]!.id });
      assert.equal(detail.deliveries![0]!.execution, "queued");
      assert.ok(detail.deliveries![0]!.sessionId);
      assert.ok(detail.deliveries![0]!.runId);
      await assert.rejects(other.limit(f.caller, 2), /only be lowered/);
      const live = (await runtime.runs.get(f.caller.claims.runId!))!;
      assert.ok(await runtime.runs.complete(live.id, live.leaseToken!, { status: "ok" }));
      await assert.rejects(other.limit(f.caller, 0), /active|lease/);
      assert.equal((await f.store.get(f.root.id))!.members[0]!.descendantLimit, 1);
    } finally {
      await runtime.close();
      await a.pool.close();
      await b.pool.close();
    }
  },
);
