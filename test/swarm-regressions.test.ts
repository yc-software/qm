import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";

test("explicit self-recipient remains in shared history without waking itself", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  const sent = await f.service.send(f.caller, { requestId: "self", audience: [f.root.id], text: "self" });
  assert.deepEqual(sent.audience, [f.root.id]);
  assert.deepEqual(Object.keys(sent.notifications), []);
});
test("all means every eligible member including the sender", async () => {
  const f = await swarmFixture();
  const peers = await f.service.spawn(f.caller, { requestId: "initial", count: 3, text: "work" });
  await f.service.sweep();
  const sent = await f.service.send(f.caller, { requestId: "all", audience: "all", text: "all" });
  assert.deepEqual(new Set(sent.audience), new Set([f.root.id, ...peers.map((p) => p.id)]));
});
test("same initial request and settings can be retried without reserving more workers", async () => {
  const f = await swarmFixture();
  const input = { requestId: "initial", settings: { turnMs: 600_000 }, text: "work" };
  const first = await f.service.spawn(f.caller, input);
  const second = await f.service.spawn(f.caller, input);
  assert.deepEqual(
    first.map((p) => p.id),
    second.map((p) => p.id),
  );
  assert.equal((await f.store.get(f.root.id))!.members.length, 2);
});
test("the default resolved worker deadline is ten minutes", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  const swarm = (await f.store.get(f.root.id))!;
  assert.equal(swarm.settings.turnMs, 600_000);
  assert.equal(swarm.template.turnWallClockMs, 600_000);
});
test("settings validate shape before creating a swarm", async () => {
  for (const settings of [
    null,
    [],
    12,
    "600000",
    { turnMs: 0 },
    { turnMs: NaN },
    { turnMs: Infinity },
    { typoMs: 600_000 },
  ]) {
    const f = await swarmFixture();
    await assert.rejects(
      f.service.spawn(f.caller, { requestId: "initial", settings: settings as never, text: "work" }),
    );
    assert.equal(await f.store.get(f.root.id), null);
  }
});
test("selected provider is durably pinned at creation", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", backend: "modal", text: "work" });
  assert.equal((await f.store.get(f.root.id))!.backend, "modal");
});
test("eligible and forged recipients reject atomically rather than partially sending", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  const before = (await f.store.get(f.root.id))!.messages.length;
  await assert.rejects(
    f.service.send(f.caller, { requestId: "forged", audience: [f.root.id, "forged"], text: "reject" }),
  );
  assert.equal((await f.store.get(f.root.id))!.messages.length, before);
});

test("provider default is pinned before retries and child provisioning, with no Modal fallback", async () => {
  const { createMemoryMap } = await import("../src/persistence/durable-map.ts");
  const { createSandboxResources } = await import("../src/sandbox/sandbox-resources.ts");
  const { createSwarmService } = await import("../src/swarms/swarm-service.ts");
  const f = await swarmFixture();
  const options: Parameters<typeof createSandboxResources>[0] = {
    enabled: true,
    rollout: createMemoryMap(),
    records: f.records,
    defaults: createMemoryMap(),
    routes: createMemoryMap(),
    backends: { aws: { ...f.backend, profile: { ...f.backend.profile, backend: "aws" } } },
    defaultBackend: "aws",
    lock: f.serviceOptions.lock,
    canUseScope: async () => true,
  };
  const sandboxes = createSandboxResources(options);
  const service = createSwarmService({ ...f.serviceOptions, sandboxes });
  const [peer] = await service.spawn(f.caller, { requestId: "initial", text: "work" });
  assert.equal((await f.store.get(f.root.id))!.backend, "aws");
  options.defaultBackend = "modal";
  await service.sweep();
  assert.equal((await f.records.get(peer!.id))!.backend, "aws");
  const worker = await f.workerCaller(peer!.id);
  const restarted = createSwarmService({ ...f.serviceOptions, sandboxes });
  const [child] = await restarted.spawn(worker, { requestId: "child", text: "work" });
  await restarted.sweep();
  assert.equal((await f.records.get(child!.id))!.backend, "aws");
  assert.equal((await f.store.get(f.root.id))!.backend, "aws");
});

test("selected scope computer determines new worker provider, but its private disk is not reused", async () => {
  const { createMemoryMap } = await import("../src/persistence/durable-map.ts");
  const { createSandboxResources } = await import("../src/sandbox/sandbox-resources.ts");
  const { createSwarmService } = await import("../src/swarms/swarm-service.ts");
  const f = await swarmFixture();
  const sandboxes = createSandboxResources({
    enabled: true,
    rollout: createMemoryMap(),
    records: f.records,
    defaults: createMemoryMap(),
    routes: createMemoryMap(),
    backends: { modal: f.backend, aws: { ...f.backend, profile: { ...f.backend.profile, backend: "aws" } } },
    defaultBackend: "modal",
    lock: f.serviceOptions.lock,
    canUseScope: async () => true,
  });
  const selected = await sandboxes.create("alice", "personal:alice", "aws", "selected");
  await sandboxes.setDefault("alice", "personal:alice", selected.id);
  const service = createSwarmService({ ...f.serviceOptions, sandboxes });
  const [peer] = await service.spawn(f.caller, { requestId: "initial", text: "work" });
  await service.sweep();
  const record = (await f.records.get(peer!.id))!;
  assert.equal(record.backend, "aws");
  assert.notEqual(record.backingScopeId, selected.backingScopeId);
  assert.equal((await sandboxes.resolve("personal:alice"))!.id, selected.id);
});
