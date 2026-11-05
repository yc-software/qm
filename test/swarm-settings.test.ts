import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { createSwarmService } from "../src/swarms/swarm-service.ts";
import { resolveSwarmSettings, SWARM_DEFAULTS } from "../src/swarms/swarm-settings.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

test("backend defaults validate every setting and preserve unspecified defaults", () => {
  assert.deepEqual(loadConfig({}).swarmDefaults, SWARM_DEFAULTS);
  assert.deepEqual(loadConfig({ SWARM_DEFAULTS: '{"agents":12,"turnMs":900000}' }).swarmDefaults, {
    ...SWARM_DEFAULTS,
    agents: 12,
    turnMs: 900_000,
  });
  for (const settings of ["null", "[]", '"wrong"', '{"surprise":1}', '{"turnMs":0}', "{"])
    assert.throws(() => loadConfig({ SWARM_DEFAULTS: settings }));
  for (const key of Object.keys(SWARM_DEFAULTS) as Array<keyof typeof SWARM_DEFAULTS>) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => resolveSwarmSettings({ [key]: value }), new RegExp(key));
  }
  assert.throws(() => resolveSwarmSettings({ turnMs: 2_147_483_648 }), /turnMs/);
  const large = { agents: 10_000, depth: 100, messages: 100_000, lifetimeMs: 30 * 86_400_000, turnMs: 2_147_483_647 };
  assert.deepEqual(resolveSwarmSettings(large), { ...SWARM_DEFAULTS, ...large });
});

test("budget settings are optional, off by default, and honored from SWARM_DEFAULTS", () => {
  const caps = { messages: 128, notifications: 256, spawnRequests: 32, lifetimeMs: 28_800_000 };
  assert.deepEqual(resolveSwarmSettings({}), SWARM_DEFAULTS);
  for (const key of Object.keys(caps)) {
    assert.equal(key in SWARM_DEFAULTS, false);
    for (const value of [0, -1, 1.5, "1", null])
      assert.throws(() => resolveSwarmSettings({ [key]: value }), new RegExp(key));
  }
  assert.deepEqual(resolveSwarmSettings(caps), { ...SWARM_DEFAULTS, ...caps });
  const swarmDefaults = loadConfig({ SWARM_DEFAULTS: JSON.stringify(caps) }).swarmDefaults;
  assert.deepEqual(swarmDefaults, { ...SWARM_DEFAULTS, ...caps });
  assert.deepEqual(resolveSwarmSettings({ messages: 500 }, swarmDefaults), { ...swarmDefaults, messages: 500 });
});

test("resolved defaults, initial overrides, children, and restarted services share one immutable settings contract", async () => {
  const f = await swarmFixture();
  const defaults = resolveSwarmSettings({
    agents: 3,
    depth: 1,
    messages: 4,
    notifications: 4,
    spawnRequests: 2,
    textBytes: 8,
    contextBytes: 16,
    waitMs: 2,
    lifetimeMs: 60_000,
  });
  const service = createSwarmService({ ...f.serviceOptions, defaults });
  const [worker] = await service.spawn(f.caller, { requestId: "pool", text: "work", settings: { turnMs: 777 } });
  await service.sweep();
  const caller = await f.workerCaller(worker!.id);
  const restarted = createSwarmService({ ...f.serviceOptions, defaults: resolveSwarmSettings({ turnMs: 999 }) });
  assert.deepEqual((await restarted.inspect(caller)).settings, { ...defaults, turnMs: 777 });
  await assert.rejects(
    restarted.spawn(caller, { requestId: "change", text: "work", settings: { depth: 5 } }),
    /only the root/,
  );
  await assert.rejects(restarted.spawn(caller, { requestId: "child", text: "work" }), /depth/);
  await assert.rejects(restarted.context(caller, { long: "x".repeat(20) }), /context/);
  await assert.rejects(restarted.send(caller, { requestId: "long", text: "x".repeat(9), audience: "all" }), /text/);
  await assert.rejects(restarted.read(caller, { waitMs: 3 }), /bounds/);
  const [sibling] = await restarted.spawn(f.caller, { requestId: "sibling", text: "work" });
  await restarted.sweep();
  const run = (await f.runs.list()).find((r) => r.request.swarm?.recipientId === sibling!.id)!;
  assert.equal(run.request.turnWallClockMs, 777);
  await assert.rejects(restarted.spawn(f.caller, { requestId: "excess", text: "work" }), /agent budget/);
  await assert.rejects(
    restarted.spawn(f.caller, { requestId: "turn", text: "work", settings: { agents: 4, turnMs: 999 } }),
    /turnMs cannot change/,
  );
  const [extra] = await restarted.spawn(f.caller, {
    requestId: "raise",
    text: "work",
    settings: { agents: 4, spawnRequests: 3 },
  });
  assert.ok(extra);
  assert.deepEqual((await restarted.inspect(f.caller)).settings, {
    ...defaults,
    turnMs: 777,
    agents: 4,
    spawnRequests: 3,
  });
  const swarm = (await f.store.get(f.root.id))!;
  assert.equal(swarm.expiresAt! - swarm.createdAt, 60_000);
});

test("canonical recipient sets deduplicate retries but reject changed sets", async () => {
  const f = await swarmFixture();
  const peers = await f.service.spawn(f.caller, { requestId: "pool", count: 2, text: "work" });
  await f.service.sweep();
  const input = { requestId: "message", audience: [peers[0]!.id, peers[1]!.id], text: "work" };
  const first = await f.service.send(f.caller, input);
  const second = await f.service.send(f.caller, { ...input, audience: [peers[1]!.id, peers[0]!.id, peers[0]!.id] });
  assert.equal(first.id, second.id);
  await assert.rejects(f.service.send(f.caller, { ...input, audience: [peers[1]!.id] }), /reused/);
  const none = await f.service.send(f.caller, { requestId: "none", audience: [], text: "shared only" });
  assert.deepEqual(none.audience, []);
  assert.deepEqual(none.notifications, {});
  assert.ok((await f.service.read(await f.workerCaller(peers[0]!.id), {})).some((m) => m.id === none.id));
});

test("conflicting concurrent initialization never silently changes the winning settings", async () => {
  const f = await swarmFixture();
  const results = await Promise.allSettled(
    [111, 222].map((turnMs) => f.service.spawn(f.caller, { requestId: "same", text: "work", settings: { turnMs } })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.store.get(f.root.id))!.members.length, 2);
});

test("unknown and unsupported providers reject before creating a swarm", async () => {
  const f = await swarmFixture();
  await assert.rejects(f.service.spawn(f.caller, { requestId: "bad", backend: "unknown", text: "work" }), /backend/);
  assert.equal(await f.store.get(f.root.id), null);
  const list = f.sandboxes.list.bind(f.sandboxes);
  f.sandboxes.list = async (...args) => {
    const inventory = await list(...args);
    return { ...inventory, providers: inventory.providers.map((p) => ({ ...p, actions: ["create"] })) };
  };
  await assert.rejects(f.service.spawn(f.caller, { requestId: "bad", text: "work" }), /retiring/);
  assert.equal(await f.store.get(f.root.id), null);
});

test("failed initial persistence leaves no configuration and a complete pool can be retried", async () => {
  const f = await swarmFixture();
  const create = f.store.create.bind(f.store);
  let interrupted = false;
  f.store.create = async (...args) => {
    if (!interrupted) {
      interrupted = true;
      throw new Error("simulated reservation interruption");
    }
    return create(...args);
  };
  const request = { requestId: "initial", text: "work", backend: "modal", settings: { turnMs: 700_000 } };
  await assert.rejects(f.service.spawn(f.caller, request), /interruption/);
  assert.equal(await f.store.get(f.root.id), null);
  const [worker] = await f.service.spawn(f.caller, request);
  assert.ok(worker);
  await assert.rejects(f.service.spawn(f.caller, { ...request, settings: { turnMs: 800_000 } }), /reused/);
  const swarm = (await f.store.get(f.root.id))!;
  assert.equal(swarm.members.length, 2);
  assert.equal(swarm.messages.length, 1);
  assert.equal(swarm.settings.turnMs, 700_000);
});

test("operators can disable swarms without changing other background work", () => {
  assert.equal(loadConfig({}).swarmsEnabled, true);
  assert.equal(loadConfig({ SWARMS_ENABLED: "true" }).swarmsEnabled, true);
  const disabled = loadConfig({ SWARMS_ENABLED: "false" });
  assert.equal(disabled.swarmsEnabled, false);
  assert.equal(disabled.backgroundWorkEnabled, true);
  assert.throws(() => loadConfig({ SWARMS_ENABLED: "invalid" }), /SWARMS_ENABLED/);
});

test("concurrent root settings changes both apply", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "pool", text: "work" });
  await f.service.sweep();
  const update = f.store.update.bind(f.store);
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  f.store.update = async (...args) => {
    if (++arrivals === 2) ready.resolve();
    await ready.promise;
    return update(...args);
  };
  await Promise.all([
    f.service.spawn(f.caller, { requestId: "agents", text: "work", settings: { agents: 64 } }),
    f.service.spawn(f.caller, { requestId: "depth", text: "work", settings: { depth: 8 } }),
  ]);
  const { settings } = (await f.store.get(f.root.id))!;
  assert.equal(settings.agents, 64);
  assert.equal(settings.depth, 8);
});
