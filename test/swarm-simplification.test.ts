import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";
import { createSwarmService } from "../src/swarms/swarm-service.ts";

test("initial persistence includes settings, pool, message and pending work in one write", async () => {
  const f = await swarmFixture();
  const create = f.store.create.bind(f.store);
  f.store.create = async (swarm, fence) => {
    assert.equal(swarm.members.length, 3);
    assert.equal(swarm.messages.length, 1);
    assert.equal(Object.keys(swarm.spawnRequests).length, 1);
    assert.equal(swarm.notificationCount, 2);
    assert.equal(swarm.pending, true);
    assert.equal(swarm.settings.turnMs, 777);
    return create(swarm, fence);
  };
  f.store.update = async () => {
    throw new Error("initial pool must not need a second write");
  };
  const workers = await f.service.spawn(f.caller, {
    requestId: "initial",
    count: 2,
    text: "work",
    settings: { turnMs: 777 },
  });
  assert.equal(workers.length, 2);
  assert.equal(f.provisioned.length, 0);
  assert.equal((await f.store.pending()).length, 1);
});

test("inspect, immediate read and send reuse one authorized swarm snapshot", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  const get = f.store.get.bind(f.store);
  let reads = 0;
  f.store.get = async (id) => {
    reads++;
    return get(id);
  };
  for (const operation of [
    () => f.service.inspect(f.caller),
    () => f.service.read(f.caller, {}),
    () => f.service.send(f.caller, { requestId: "message", audience: [], text: "note" }),
  ]) {
    reads = 0;
    await operation();
    assert.equal(reads, 1);
  }
});

test("waiting reads reauthorize after sleeping and separate requests never cache authorization", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  const checked = Promise.withResolvers<void>();
  const service = createSwarmService({
    ...f.serviceOptions,
    authorize: async () => {
      checked.resolve();
      return f.state.allowed;
    },
  });
  const read = service.read(f.caller, { after: 1, waitMs: 500 });
  const rejected = assert.rejects(read, /scope access denied/);
  await checked.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.state.allowed = false;
  await rejected;
  await assert.rejects(service.inspect(f.caller), /scope access denied/);
});

test("a replaced run cannot commit the initial pool after admission", async () => {
  const f = await swarmFixture();
  if (f.caller.kind !== "agent") throw new Error("wrong caller");
  const run = (await f.runs.get(f.caller.claims.runId!))!;
  const create = f.store.create.bind(f.store);
  f.store.create = async (...args) => {
    await f.runs.releaseLease(run.id, run.leaseToken!);
    await f.runs.claimById(run.id, "replacement", 60_000);
    return create(...args);
  };
  await assert.rejects(
    f.service.spawn(f.caller, { requestId: "initial", text: "work" }),
    /active capability run required/,
  );
  assert.equal(await f.store.get(f.root.id), null);
});

test("lost initial commit acknowledgment retries without duplicating reservations", async () => {
  const f = await swarmFixture();
  const create = f.store.create.bind(f.store);
  f.store.create = async (...args) => {
    await create(...args);
    throw new Error("lost acknowledgment");
  };
  const input = { requestId: "initial", text: "work", settings: { turnMs: 777 } };
  await assert.rejects(f.service.spawn(f.caller, input), /lost acknowledgment/);
  const committed = (await f.store.get(f.root.id))!;
  assert.equal(committed.members.length, 2);
  const restarted = createSwarmService(f.serviceOptions);
  const workers = await restarted.spawn(f.caller, input);
  assert.equal(workers[0]!.id, committed.members[1]!.id);
  assert.deepEqual(await f.store.get(f.root.id), committed);
  await assert.rejects(restarted.spawn(f.caller, { ...input, text: "changed" }), /reused/);
});

for (const duplicate of [true, false]) {
  test(`simultaneous initial pools ${duplicate ? "deduplicate one request" : "reserve both distinct requests"}`, async () => {
    const f = await swarmFixture();
    const second = createSwarmService(f.serviceOptions);
    const ready = Promise.withResolvers<void>();
    const create = f.store.create.bind(f.store);
    let arrivals = 0;
    f.store.create = async (...args) => {
      if (++arrivals === 2) ready.resolve();
      await ready.promise;
      return create(...args);
    };
    const results = await Promise.all([
      f.service.spawn(f.caller, { requestId: "initial", text: "work" }),
      second.spawn(f.caller, { requestId: duplicate ? "initial" : "other", text: "work" }),
    ]);
    const swarm = (await f.store.get(f.root.id))!;
    assert.equal(swarm.members.length, duplicate ? 2 : 3);
    assert.equal(swarm.messages.length, duplicate ? 1 : 2);
    assert.equal(new Set(results.flat().map((m) => m.id)).size, duplicate ? 1 : 2);
    assert.equal(swarm.pending, true);
    await second.sweep();
    assert.equal((await f.runs.list()).filter((r) => r.request.swarm).length, duplicate ? 1 : 2);
  });
}

test("initial pool cannot commit after its work window expires", async (context) => {
  const f = await swarmFixture();
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const create = f.store.create.bind(f.store);
  f.store.create = async (...args) => {
    context.mock.timers.tick(2);
    return create(...args);
  };
  await assert.rejects(
    f.service.spawn(f.caller, { requestId: "initial", text: "work", settings: { lifetimeMs: 1 } }),
    /work window expired/,
  );
  assert.equal(await f.store.get(f.root.id), null);
});

test("initial work window uses one timestamp even when the clock advances between reads", async (context) => {
  const f = await swarmFixture();
  let now = Date.now();
  context.mock.method(Date, "now", () => now++);
  await f.service.spawn(f.caller, { requestId: "initial", text: "work", settings: { lifetimeMs: 60_000 } });
  const swarm = (await f.store.get(f.root.id))!;
  assert.equal(swarm.expiresAt - swarm.createdAt, 60_000);
});
