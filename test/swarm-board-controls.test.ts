import { test } from "node:test";
import assert from "node:assert/strict";
import { createSwarmService } from "../src/swarms/swarm-service.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

test("a swarm provisions one shared board computer that the root and every worker share", async () => {
  const fixture = await swarmFixture();
  const workers = await fixture.service.spawn(fixture.caller, { requestId: "pool", text: "Work", count: 2 });
  await fixture.service.sweep();
  const swarm = (await fixture.store.get(fixture.root.id))!;
  const board = (await fixture.records.get(swarm.board!.sandboxId))!;
  assert.equal(board.ownerScopeId, fixture.root.scopeId);
  assert.equal(board.name, "Swarm board");
  for (const worker of workers)
    assert.equal(swarm.members.find((m) => m.id === worker.id)!.forumSandboxId, swarm.board!.sandboxId);
  const inspected = await fixture.service.inspect(fixture.caller);
  assert.equal(inspected.board?.sandboxId, swarm.board!.sandboxId);
  const worker = await fixture.service.inspect(await fixture.workerCaller(workers[0]!.id));
  assert.equal(worker.self.forumSandboxId, swarm.board!.sandboxId);
});

test("an explicit forum computer replaces the automatic board", async () => {
  const fixture = await swarmFixture();
  const forum = await fixture.sandboxes.create("alice", fixture.root.scopeId as never, "modal", "Forum");
  await fixture.service.spawn(fixture.caller, { requestId: "one", text: "Work", forumSandboxId: forum.id });
  await fixture.service.sweep();
  const swarm = (await fixture.store.get(fixture.root.id))!;
  assert.equal(swarm.board, undefined);
  assert.equal(swarm.members[1]!.forumSandboxId, forum.id);
});

test("pausing holds delivery, resuming releases it, and stopping is terminal", async () => {
  const fixture = await swarmFixture();
  const [worker] = await fixture.service.spawn(fixture.caller, { requestId: "one", text: "Work" });
  await fixture.service.control(fixture.caller, { memberId: worker!.id, state: "paused" });
  await fixture.service.sweep();
  let swarm = (await fixture.store.get(fixture.root.id))!;
  assert.equal(swarm.members[1]!.state, "ready");
  assert.equal(swarm.messages[0]!.notifications[worker!.id]!.state, "pending");
  assert.equal((await fixture.service.inspect(fixture.caller)).peers[1]!.control, "paused");
  await fixture.service.control(fixture.caller, { memberId: worker!.id, state: "active" });
  await fixture.service.sweep();
  swarm = (await fixture.store.get(fixture.root.id))!;
  const notification = swarm.messages[0]!.notifications[worker!.id]!;
  assert.equal(notification.state, "queued");
  await fixture.service.control(fixture.caller, { memberId: worker!.id, state: "stopped" });
  assert.equal(await fixture.runs.get(notification.runId!), null);
  await assert.rejects(
    fixture.service.control(fixture.caller, { memberId: worker!.id, state: "active" }),
    /cannot be resumed/,
  );
  await assert.rejects(
    fixture.service.control(fixture.caller, { memberId: fixture.root.id, state: "stopped" }),
    /root session/,
  );
});

test("a worker cannot control a sibling", async () => {
  const fixture = await swarmFixture();
  const [first, second] = await fixture.service.spawn(fixture.caller, { requestId: "pool", text: "Work", count: 2 });
  await fixture.service.sweep();
  await assert.rejects(
    fixture.service.control(await fixture.workerCaller(first!.id), { memberId: second!.id, state: "stopped" }),
    /descendants/,
  );
});

test("a swarm owner without the flag gets no reconciliation", async () => {
  const fixture = await swarmFixture();
  let enabled = true;
  const service = createSwarmService({ ...fixture.serviceOptions, enabled: async () => enabled });
  await service.spawn(fixture.caller, { requestId: "one", text: "Work" });
  enabled = false;
  await service.sweep();
  const swarm = (await fixture.store.get(fixture.root.id))!;
  assert.equal(swarm.members[1]!.state, "reserved");
  assert.equal((await fixture.records.get(swarm.board!.sandboxId)) ?? null, null);
  assert.equal(await service.enabledFor("alice"), false);
});

test("pausing and stopping the root's direct children cascades across a 120-worker swarm", async () => {
  const fixture = await swarmFixture();
  const workers = await fixture.service.spawn(fixture.caller, {
    requestId: "wide",
    text: "Work",
    count: 120,
    settings: { agents: 128 },
  });
  assert.equal(workers.length, 120);
  const children = workers.filter((worker) => worker.parentId === fixture.root.id);
  await Promise.all(children.map((w) => fixture.service.control(fixture.caller, { memberId: w.id, state: "paused" })));
  await fixture.service.sweep();
  let swarm = (await fixture.store.get(fixture.root.id))!;
  assert.ok(workers.every((w) => swarm.messages[0]!.notifications[w.id]?.state !== "queued"));
  await Promise.all(children.map((w) => fixture.service.control(fixture.caller, { memberId: w.id, state: "stopped" })));
  await fixture.service.sweep();
  swarm = (await fixture.store.get(fixture.root.id))!;
  assert.ok(workers.every((w) => swarm.messages[0]!.notifications[w.id]?.state !== "queued"));
  assert.equal((await fixture.service.inspect(fixture.caller)).peers.length, 121);
});
