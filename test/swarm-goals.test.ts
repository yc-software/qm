import { test } from "node:test";
import assert from "node:assert/strict";
import { assignedGoal, createGoalRecord } from "../src/harness/goal.ts";
import { createSwarmGoalInbox } from "../src/swarms/swarm-goal-inbox.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

const goal = { objective: "Survey every archive for the lane", floor: { minMs: 3_600_000 }, token_cap: 2_000_000 };

test("a spawn goal reaches the worker turn without the swarm turn deadline", async () => {
  const f = await swarmFixture();
  await f.service.spawn(f.caller, { requestId: "initial", text: "work", goal });
  await f.service.sweep();
  const run = (await f.runs.list()).find((item) => item.request.swarm)!;
  const message = (await f.store.get(f.root.id))!.messages[0]!;
  assert.deepEqual(run.request.swarmGoal, { ...goal, assignedAt: message.createdAt });
  assert.equal(run.request.turnWallClockMs, undefined);
  assert.ok(await f.service.binding({ ...run.request, runId: run.id }));
  await assert.rejects(f.service.binding({ ...run.request, runId: run.id, turnWallClockMs: 600_000 }));
});

test("goals are validated, and any member can give any worker, itself included, a goal that wakes it", async () => {
  const f = await swarmFixture();
  const [first, second] = await f.service.spawn(f.caller, { requestId: "initial", count: 2, text: "work" });
  await f.service.sweep();
  const { token_cap: _cap, ...uncapped } = goal;
  const [uncappedWorker] = await f.service.spawn(f.caller, { requestId: "uncapped", text: "work", goal: uncapped });
  assert.ok(uncappedWorker);
  await assert.rejects(
    f.service.spawn(f.caller, { requestId: "bad", text: "work", goal: { ...goal, token_cap: "lots" } }),
    /invalid goal/,
  );
  await assert.rejects(
    f.service.send(f.caller, { requestId: "silent", audience: [first!.id], text: "go", notify: false, goal }),
    /needs notify/,
  );
  await assert.rejects(
    f.service.send(f.caller, { requestId: "root", audience: [f.root.id], text: "go", goal }),
    /assigned to workers/,
  );
  const everyone = await f.service.send(f.caller, { requestId: "all", audience: "all", text: "go", goal });
  assert.deepEqual(
    [first!.id, second!.id, f.root.id].map((id) => everyone.notifications[id]?.state),
    ["pending", "pending", undefined],
  );
  const peer = await f.workerCaller(first!.id);
  const sibling = await f.service.send(peer, { requestId: "sibling", audience: [second!.id], text: "go", goal });
  const next = { objective: "Pick the next lane" };
  const self = await f.service.send(peer, { requestId: "self", audience: [first!.id], text: "next", goal: next });
  await f.service.sweep();
  const runFor = async (id: string) => (await f.runs.list()).find((run) => run.request.swarm?.messageId === id);
  assert.deepEqual((await runFor(sibling.id))?.request.swarmGoal, { ...goal, assignedAt: sibling.createdAt });
  assert.equal((await runFor(self.id))?.request.swarm?.recipientId, first!.id);
  assert.deepEqual((await runFor(self.id))?.request.swarmGoal, { ...next, assignedAt: self.createdAt });
});

test("each goal message installs once, and a later goal message wins", () => {
  const a = { objective: "A", token_cap: 100, assignedAt: 1_000 };
  const b = { objective: "B", token_cap: 100, assignedAt: 2_000 };
  const installedA = assignedGoal(undefined, a)!;
  assert.equal(installedA.objective, "A");
  assert.equal(assignedGoal({ ...installedA, status: "complete", tokensUsed: 100 }, a), null);
  const installedB = assignedGoal(installedA, b)!;
  assert.equal(installedB.objective, "B");
  assert.equal(assignedGoal(installedB, a), null);
});

test("goal fields outside the goal schema are rejected", async () => {
  const f = await swarmFixture();
  await assert.rejects(
    f.service.spawn(f.caller, { requestId: "extra", text: "work", goal: { ...goal, surprise: 1 } }),
    /invalid goal/,
  );
});

test("a running goal turn takes its worker's queued messages once, under its lease, and their runs never start", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "lane A", goal });
  await f.service.sweep();
  const first = (await f.runs.list()).find((run) => run.request.swarm)!;
  const claimed = (await f.runs.claimById(first.id, "worker", 60_000))!;
  const input = {
    ...claimed.request,
    runId: claimed.id,
    runLeaseToken: claimed.leaseToken!,
    attempt: claimed.attempts,
  };
  const send = (requestId: string, text: string, extra = {}) =>
    f.service.send(f.caller, { requestId, audience: [worker!.id], text, notify: true, ...extra });
  const earlier = await send("earlier", "already handled in its own turn");
  await f.service.sweep();
  const earlierRun = (await f.runs.list()).find((run) => run.request.swarm?.messageId === earlier.id)!;
  await f.runs.withdraw(earlierRun.id);
  const replacement = await f.service.send(await f.workerCaller(worker!.id), {
    requestId: "replace",
    audience: [worker!.id],
    text: "take lane B",
    goal: { objective: "Survey lane B" },
  });
  const note = await send("note", "lane B starts at the north gate");
  await f.service.sweep();
  const unacknowledged = await send("late", "not delivered yet");
  const runFor = async (id: string) => (await f.runs.list()).find((run) => run.request.swarm?.messageId === id);
  const noteRun = (await runFor(note.id))!;
  const withdraw = f.runs.withdraw.bind(f.runs);
  f.runs.withdraw = async (runId, options) => runId !== noteRun.id && withdraw(runId, options);
  assert.deepEqual(
    (await f.service.queuedMessages(input)).map((message) => message.id),
    [replacement.id, note.id],
    "only acknowledged deliveries, in order, never the turn's own message or one still being delivered",
  );
  await assert.rejects(f.service.handOver({ ...input, runLeaseToken: "stale" }, [replacement.id]));
  const handed = await f.service.handOver(input, [replacement.id, note.id, unacknowledged.id]);
  assert.deepEqual(
    handed.map((message) => message.id),
    [replacement.id, note.id],
  );
  assert.deepEqual(handed[0]!.goal, { objective: "Survey lane B" });
  assert.equal(await runFor(replacement.id), undefined, "the handed message's queued run is withdrawn");
  assert.deepEqual(await f.service.handOver(input, [replacement.id, note.id]), []);
  await f.service.sweep();
  assert.equal(await runFor(replacement.id), undefined, "a handed message is never delivered again");
  await f.runs.complete(claimed.id, claimed.leaseToken!, { status: "ok" });
  const straggler = (await f.runs.claimById(noteRun.id, "late-worker", 60_000))!;
  await assert.rejects(
    f.service.binding({ ...straggler.request, runId: straggler.id }),
    /already handed/,
    "a run that could not be withdrawn still never replays a handed message",
  );
});

test("the goal inbox holds a blocked message and everything after it, and settles only what it handed over", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "lane A", goal });
  await f.service.sweep();
  const first = (await f.runs.list()).find((run) => run.request.swarm)!;
  const claimed = (await f.runs.claimById(first.id, "worker", 60_000))!;
  const input = {
    ...claimed.request,
    runId: claimed.id,
    runLeaseToken: claimed.leaseToken!,
    attempt: claimed.attempts,
  };
  const send = (requestId: string, text: string) =>
    f.service.send(f.caller, { requestId, audience: [worker!.id], text, notify: true });
  const ok = await send("ok", "first note");
  const blocked = await send("blocked", "BLOCK this one");
  const after = await send("after", "after the blocked one");
  await f.service.sweep();
  const { inbox, settle } = createSwarmGoalInbox({
    swarms: f.service,
    input,
    screen: async (text) => (text.includes("BLOCK") ? null : text),
    saveGoal: async () => {},
  });
  const current = createGoalRecord({ objective: "lane A", now: 0 });
  assert.deepEqual(
    (await inbox.receive(current)).map(({ id }) => id),
    [ok.id],
  );
  assert.deepEqual(await inbox.receive(current), []);
  await inbox.acknowledge([ok.id], current);
  await settle();
  const states = Object.fromEntries(
    (await f.store.get(f.root.id))!.messages.map((message) => [message.id, message.notifications[worker!.id]?.state]),
  );
  assert.deepEqual([states[ok.id], states[blocked.id], states[after.id]], ["handed", "queued", "queued"]);
});

test("a goal message is still handed over when saving its adopted goal fails mid-turn", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "lane A", goal });
  await f.service.sweep();
  const first = (await f.runs.list()).find((run) => run.request.swarm)!;
  const claimed = (await f.runs.claimById(first.id, "worker", 60_000))!;
  const input = {
    ...claimed.request,
    runId: claimed.id,
    runLeaseToken: claimed.leaseToken!,
    attempt: claimed.attempts,
  };
  const replacement = await f.service.send(f.caller, {
    requestId: "replace",
    audience: [worker!.id],
    text: "take lane B",
    goal: { objective: "Survey lane B" },
  });
  await f.service.sweep();
  const { inbox, settle } = createSwarmGoalInbox({
    swarms: f.service,
    input,
    screen: async (text) => text,
    saveGoal: async () => {
      throw new Error("database blip");
    },
  });
  const current = createGoalRecord({ objective: "lane A", now: 0 });
  const [shown] = await inbox.receive(current);
  assert.match(shown!.text, /assigns you a new goal[\s\S]*Survey lane B/);
  await inbox.acknowledge([replacement.id], current);
  assert.equal(current.objective, "Survey lane B");
  await settle();
  const message = (await f.store.get(f.root.id))!.messages.find((item) => item.id === replacement.id)!;
  assert.equal(message.notifications[worker!.id]?.state, "handed");
});

test("a worker's goal turn is held while it or an ancestor is paused or stopped, and only on swarm runs", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "lane A", goal });
  await f.service.sweep();
  const [child] = await f.service.spawn(await f.workerCaller(worker!.id), { requestId: "child", text: "lane A1" });
  await f.service.sweep();
  const runOf = async (id: string) =>
    (await f.runs.list()).find((run) => run.request.swarm?.recipientId === id)!.request;
  const input = await runOf(worker!.id);
  const childInput = await runOf(child!.id);
  assert.equal(await f.service.held(input), false);
  await f.service.control(f.caller, { memberId: worker!.id, state: "paused" });
  assert.equal(await f.service.held(input), true);
  assert.equal(await f.service.held(childInput), true, "a paused ancestor holds its descendants");
  const { swarm: _swarm, ...threadTurn } = input;
  assert.equal(await f.service.held(threadTurn), false, "a person's own turn in the worker thread is never held");
  await f.service.control(f.caller, { memberId: worker!.id, state: "active" });
  assert.equal(await f.service.held(input), false);
  await f.service.control(f.caller, { memberId: child!.id, state: "stopped" });
  assert.equal(await f.service.held(childInput), true);
});

test("pausing a worker withdraws its unstarted deliveries and resuming delivers them again", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "lane A" });
  await f.service.sweep();
  const note = await f.service.send(f.caller, { requestId: "n", audience: [worker!.id], text: "next", notify: true });
  await f.service.sweep();
  const runFor = async () => (await f.runs.list()).find((run) => run.request.swarm?.messageId === note.id);
  assert.ok(await runFor());
  await f.service.control(f.caller, { memberId: worker!.id, state: "paused" });
  assert.equal(await runFor(), undefined, "the queued run is withdrawn while paused");
  await f.service.sweep();
  assert.equal(await runFor(), undefined, "nothing is delivered while paused");
  await f.service.control(f.caller, { memberId: worker!.id, state: "active" });
  await f.service.sweep();
  assert.ok(await runFor(), "the message is delivered once resumed");
});

test("a message a paused goal turn already saw is handed over, not delivered again on resume", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "lane A", goal });
  await f.service.sweep();
  const first = (await f.runs.list()).find((run) => run.request.swarm)!;
  const claimed = (await f.runs.claimById(first.id, "worker", 60_000))!;
  const input = {
    ...claimed.request,
    runId: claimed.id,
    runLeaseToken: claimed.leaseToken!,
    attempt: claimed.attempts,
  };
  const note = await f.service.send(f.caller, { requestId: "n", audience: [worker!.id], text: "next", notify: true });
  await f.service.sweep();
  assert.deepEqual(
    (await f.service.queuedMessages(input)).map((message) => message.id),
    [note.id],
  );
  await f.service.control(f.caller, { memberId: worker!.id, state: "paused" });
  assert.deepEqual(
    (await f.service.handOver(input, [note.id])).map((message) => message.id),
    [note.id],
  );
  await f.service.control(f.caller, { memberId: worker!.id, state: "active" });
  await f.service.sweep();
  assert.equal(
    (await f.runs.list()).find((run) => run.request.swarm?.messageId === note.id),
    undefined,
  );
});

test("a message handed over while its run is being withdrawn by a pause stays handed", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "lane A", goal });
  await f.service.sweep();
  const first = (await f.runs.list()).find((run) => run.request.swarm)!;
  const claimed = (await f.runs.claimById(first.id, "worker", 60_000))!;
  const input = {
    ...claimed.request,
    runId: claimed.id,
    runLeaseToken: claimed.leaseToken!,
    attempt: claimed.attempts,
  };
  const note = await f.service.send(f.caller, { requestId: "n", audience: [worker!.id], text: "next", notify: true });
  await f.service.sweep();
  const withdraw = f.runs.withdraw.bind(f.runs);
  f.runs.withdraw = async (runId, options) => {
    const withdrawn = await withdraw(runId, options);
    await f.service.handOver(input, [note.id]);
    return withdrawn;
  };
  await f.service.control(f.caller, { memberId: worker!.id, state: "paused" });
  f.runs.withdraw = withdraw;
  await f.service.control(f.caller, { memberId: worker!.id, state: "active" });
  await f.service.sweep();
  assert.equal(
    (await f.runs.list()).find((run) => run.request.swarm?.messageId === note.id),
    undefined,
  );
});

test("a pause that loses its process mid-withdraw still delivers the message on resume", async () => {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "lane A" });
  await f.service.sweep();
  const note = await f.service.send(f.caller, { requestId: "n", audience: [worker!.id], text: "next", notify: true });
  await f.service.sweep();
  const runFor = async () => (await f.runs.list()).find((run) => run.request.swarm?.messageId === note.id);
  assert.ok(await runFor());
  const withdraw = f.runs.withdraw.bind(f.runs);
  f.runs.withdraw = async (runId, options) => {
    await withdraw(runId, options);
    throw new Error("process lost after the withdraw");
  };
  await f.service.control(f.caller, { memberId: worker!.id, state: "paused" });
  f.runs.withdraw = withdraw;
  assert.equal(await runFor(), undefined);
  await f.service.control(f.caller, { memberId: worker!.id, state: "active" });
  await f.service.sweep();
  assert.ok(await runFor(), "the message is delivered once resumed");
});
