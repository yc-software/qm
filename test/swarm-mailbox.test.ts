import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalRecord } from "../src/harness/goal.ts";
import { createSwarmGoalInbox } from "../src/swarms/swarm-goal-inbox.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

test("an agent's messages wait in each recipient's mailbox whatever their lineage; notify:true wakes", async () => {
  const f = await swarmFixture();
  const [first, second] = await f.service.spawn(f.caller, { requestId: "initial", count: 2, text: "work" });
  await f.service.sweep();
  const brief = (await f.store.get(f.root.id))!.messages[0]!;
  const worker = await f.workerCaller(first!.id);
  const runsFor = async (messageId: string) =>
    (await f.runs.list()).filter((run) => run.request.swarm?.messageId === messageId);
  const ack = await f.service.send(worker, {
    requestId: "ack",
    audience: [f.root.id],
    replyTo: brief.id,
    text: "read",
  });
  const peer = await f.service.send(worker, { requestId: "peer", audience: [second!.id], text: "fyi" });
  const done = await f.service.send(worker, { requestId: "done", audience: [f.root.id], notify: true, text: "done" });
  const quiet = await f.service.send(f.caller, {
    requestId: "quiet",
    audience: [first!.id],
    notify: false,
    text: "for the record",
  });
  const order = await f.service.send(f.caller, { requestId: "order", audience: [first!.id], text: "next lane" });
  await f.service.sweep();
  assert.deepEqual(ack.notifications, { [f.root.id]: { state: "mailbox" } });
  assert.deepEqual(peer.notifications, { [second!.id]: { state: "mailbox" } });
  assert.deepEqual(quiet.notifications, {});
  assert.deepEqual(await runsFor(ack.id), []);
  assert.deepEqual(await runsFor(peer.id), []);
  assert.deepEqual(order.notifications, { [first!.id]: { state: "mailbox" } });
  assert.deepEqual(await runsFor(order.id), []);
  assert.equal((await runsFor(done.id)).length, 1);
  assert.equal((await f.store.get(f.root.id))!.pending, false);
});

test("a root turn outside swarm delivery sees its mailbox only while the swarm roster is unchanged", async () => {
  const f = await swarmFixture();
  const [member] = await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  await f.service.sweep();
  const ack = await f.service.send(await f.workerCaller(member!.id), {
    requestId: "ack",
    audience: [f.root.id],
    text: "read the brief",
  });
  const human = { ...f.template, text: "status?" };
  assert.deepEqual(
    (await f.service.queuedMessages(human)).map((message) => message.id),
    [ack.id],
  );
  await f.sessions.addParticipant(f.root.id, "mallory");
  assert.deepEqual(await f.service.queuedMessages(human), []);
});

test("a running goal turn shows a mailbox message once and hands it over when it settles", async () => {
  const f = await swarmFixture();
  const [busy, peer] = await f.service.spawn(f.caller, {
    requestId: "initial",
    count: 2,
    text: "work",
    goal: { objective: "Survey the lane" },
  });
  await f.service.sweep();
  const note = await f.service.send(await f.workerCaller(peer!.id), {
    requestId: "note",
    audience: [busy!.id],
    text: "north gate is closed",
  });
  const run = (await f.runs.list()).find((item) => item.request.swarm?.recipientId === busy!.id)!;
  const claimed = (await f.runs.claimById(run.id, "worker", 60_000))!;
  const input = {
    ...claimed.request,
    runId: claimed.id,
    runLeaseToken: claimed.leaseToken!,
    attempt: claimed.attempts,
  };
  const { inbox, settle } = createSwarmGoalInbox({
    swarms: f.service,
    input,
    screen: async (text) => text,
    saveGoal: async () => {},
  });
  const goal = createGoalRecord({ objective: "Survey the lane", now: 0 });
  const [shown] = await inbox.receive(goal);
  assert.match(shown!.text, /north gate is closed/);
  await inbox.acknowledge([note.id], goal);
  assert.deepEqual(await inbox.receive(goal), []);
  await settle();
  const message = (await f.store.get(f.root.id))!.messages.find((item) => item.id === note.id)!;
  assert.equal(message.notifications[busy!.id]?.state, "handed");
});
