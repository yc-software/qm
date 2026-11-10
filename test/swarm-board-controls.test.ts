import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";
import { processRun } from "../src/runs/worker.ts";
import { SWARM_LIMITS } from "../src/swarms/swarm-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

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

test("a pause landing while delivery enqueues holds the run instead of dispatching it", async () => {
  const fixture = await swarmFixture();
  const [worker] = await fixture.service.spawn(fixture.caller, { requestId: "one", text: "Work" });
  const enqueue = fixture.runs.enqueue.bind(fixture.runs);
  fixture.runs.enqueue = async (input) => {
    const result = await enqueue(input);
    if (input.dedupKey?.endsWith(worker!.id))
      await fixture.service.control(fixture.caller, { memberId: worker!.id, state: "paused" });
    return result;
  };
  await fixture.service.sweep();
  const notification = (await fixture.store.get(fixture.root.id))!.messages[0]!.notifications[worker!.id]!;
  assert.equal(notification.state, "pending");
  assert.equal(await fixture.runs.get(notification.runId!), null);
});

test("a paused worker's held notification does not keep the swarm in the outbox sweep", async () => {
  const fixture = await swarmFixture();
  const [worker] = await fixture.service.spawn(fixture.caller, { requestId: "one", text: "Work" });
  await fixture.service.control(fixture.caller, { memberId: worker!.id, state: "paused" });
  await fixture.service.sweep();
  assert.equal((await fixture.store.get(fixture.root.id))!.messages[0]!.notifications[worker!.id]!.state, "pending");
  assert.deepEqual(await fixture.store.pending(), []);
  await fixture.service.control(fixture.caller, { memberId: worker!.id, state: "active" });
  assert.deepEqual(
    (await fixture.store.pending()).map((swarm) => swarm.id),
    [fixture.root.id],
  );
});

test("an expired swarm fails a paused worker's held notifications and keeps their run ids", async () => {
  const fixture = await swarmFixture();
  const [first, second] = await fixture.service.spawn(fixture.caller, { requestId: "pool", text: "Work", count: 2 });
  await fixture.service.sweep();
  const queued = (await fixture.store.get(fixture.root.id))!.messages[0]!.notifications[second!.id]!;
  assert.equal(queued.state, "queued");
  await fixture.service.control(fixture.caller, { memberId: second!.id, state: "paused" });
  await fixture.service.send(fixture.caller, { requestId: "status", text: "Status?", audience: "all" });
  await fixture.store.update(fixture.root.id, (swarm) => {
    swarm.expiresAt = Date.now() - 1;
  });
  await fixture.service.sweep();
  const swarm = (await fixture.store.get(fixture.root.id))!;
  assert.deepEqual(swarm.messages[0]!.notifications[second!.id], { state: "failed", runId: queued.runId });
  assert.equal(swarm.messages.at(-1)!.notifications[second!.id]!.state, "failed");
  assert.equal(swarm.messages.at(-1)!.notifications[first!.id]!.state, "failed");
  assert.deepEqual(await fixture.store.pending(), []);
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

test("a run claimed before a pause lands is held at the start gate and runs once after resume", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "one", text: "Work" });
  await f.service.sweep();
  const runId = (await f.store.get(f.root.id))!.messages[0]!.notifications[worker!.id]!.runId!;
  const turns: string[] = [];
  const handleTurn = async (input: OrchestratorInput) => {
    await f.service.binding(input);
    turns.push(input.runId!);
    return { status: "completed", sessionId: input.conversation.threadRef, runId: input.runId! } as never;
  };
  const run = async (claimed: Parameters<typeof processRun>[1] | null) =>
    processRun({ runs: f.runs, leaseTtlMs: 60_000, orchestrator: { handleTurn } as never }, claimed!);
  const claimed = await f.runs.claimById(runId, "t", 60_000);
  await f.service.control(f.caller, { memberId: worker!.id, state: "paused" });
  await run(claimed);
  assert.deepEqual([turns, (await f.runs.get(runId))!.status], [[], "pending"]);
  await f.service.control(f.caller, { memberId: worker!.id, state: "active" });
  await f.service.sweep();
  const now = Date.now;
  Date.now = () => now() + SWARM_LIMITS.pausedRecheckMs + 1_000;
  await run(await f.runs.claimById(runId, "t", 60_000)).finally(() => (Date.now = now));
  assert.deepEqual([turns, (await f.runs.get(runId))!.status], [[runId], "done"]);
});
