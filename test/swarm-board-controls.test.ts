import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";
import { processRun } from "../src/runs/worker.ts";
import { SWARM_LIMITS } from "../src/swarms/swarm-store.ts";

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

type Fixture = Awaited<ReturnType<typeof swarmFixture>>;
type Claimed = NonNullable<Awaited<ReturnType<Fixture["runs"]["claimById"]>>>;

function startClaimed(fixture: Fixture, claimed: Claimed, turns: string[]) {
  return processRun(
    {
      runs: fixture.runs,
      leaseTtlMs: 60_000,
      orchestrator: {
        async handleTurn(input) {
          await fixture.service.binding(input);
          turns.push(input.runId!);
          return { status: "completed", sessionId: claimed.sessionId, runId: input.runId! } as never;
        },
        screenSecuritySteer: async () => "allow",
        regenerateTitle: async () => null,
        suggestNextPrompt: async () => null,
      },
    },
    claimed,
  );
}

async function resumeAndRun(fixture: Fixture, workerId: string, runId: string, turns: string[]) {
  await fixture.service.control(fixture.caller, { memberId: workerId, state: "active" });
  await fixture.service.sweep();
  const notification = (await fixture.store.get(fixture.root.id))!.messages[0]!.notifications[workerId]!;
  assert.equal(notification.state, "queued");
  assert.equal(notification.runId, runId);
  assert.equal((await fixture.runs.get(runId))!.status, "pending");
  assert.equal(await fixture.runs.claimById(runId, "gate-test", 60_000), null);
  const realNow = Date.now;
  Date.now = () => realNow() + SWARM_LIMITS.pausedRecheckMs + 1_000;
  try {
    await startClaimed(fixture, (await fixture.runs.claimById(runId, "gate-test", 60_000))!, turns);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(turns, [runId]);
  assert.equal((await fixture.runs.get(runId))!.status, "done");
}

test("a run claimed before the delivery write does not start a turn for a worker paused in between", async () => {
  const fixture = await swarmFixture();
  const [worker] = await fixture.service.spawn(fixture.caller, { requestId: "one", text: "Work" });
  const turns: string[] = [];
  let claimed: Claimed | null = null;
  const enqueue = fixture.runs.enqueue.bind(fixture.runs);
  fixture.runs.enqueue = async (input) => {
    const result = await enqueue(input);
    if (input.dedupKey?.endsWith(worker!.id)) {
      claimed = await fixture.runs.claimById(result.run.id, "gate-test", 60_000);
      await fixture.service.control(fixture.caller, { memberId: worker!.id, state: "paused" });
    }
    return result;
  };
  await fixture.service.sweep();
  fixture.runs.enqueue = enqueue;
  const runId = claimed!.id;
  assert.equal((await fixture.store.get(fixture.root.id))!.messages[0]!.notifications[worker!.id]!.state, "pending");
  await startClaimed(fixture, claimed!, turns);
  assert.deepEqual(turns, []);
  assert.equal((await fixture.runs.get(runId))!.status, "pending");
  await resumeAndRun(fixture, worker!.id, runId, turns);
});

test("a pause landing after an idle worker claims its delivery holds the run instead of starting it", async () => {
  const fixture = await swarmFixture();
  const [worker] = await fixture.service.spawn(fixture.caller, { requestId: "one", text: "Work" });
  await fixture.service.sweep();
  const runId = (await fixture.store.get(fixture.root.id))!.messages[0]!.notifications[worker!.id]!.runId!;
  const turns: string[] = [];
  const claimed = (await fixture.runs.claimById(runId, "gate-test", 60_000))!;
  await fixture.service.control(fixture.caller, { memberId: worker!.id, state: "paused" });
  assert.equal((await fixture.store.get(fixture.root.id))!.messages[0]!.notifications[worker!.id]!.state, "pending");
  await startClaimed(fixture, claimed, turns);
  assert.deepEqual(turns, []);
  assert.equal((await fixture.runs.get(runId))!.status, "pending");
  await resumeAndRun(fixture, worker!.id, runId, turns);
});
