import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalRecord, type GoalRecord } from "../src/harness/goal.ts";
import { createSwarmGoalContinuation } from "../src/swarms/swarm-goal-continuation.ts";
import type { SwarmCaller } from "../src/swarms/swarm-service.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

async function goalWorker(settings?: { messages: number; notifications: number }) {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, {
    requestId: "initial",
    text: "work",
    ...(settings ? { settings } : {}),
  });
  await f.service.sweep();
  const member = (await f.store.get(f.root.id))!.members.find((peer) => peer.id === worker!.id)!;
  const continuation = createSwarmGoalContinuation(f.serviceOptions);
  const setGoal = async (goal: GoalRecord) => {
    const { lease } = await f.sessions.acquireLease(member.sessionId!);
    await f.sessions.setGoal(lease!, goal);
    await f.sessions.releaseLease(lease!);
  };
  const workerRuns = async () => (await f.runs.list()).filter((run) => run.request.swarm?.recipientId === member.id);
  const claimOpenRun = async () => {
    await f.service.sweep();
    const run = (await workerRuns()).find((item) => item.status === "pending")!;
    return (await f.runs.claimById(run.id, "test", 60_000))!;
  };
  const finishOpenRun = async (whileRunning?: () => Promise<void>) => {
    const run = await claimOpenRun();
    await whileRunning?.();
    await f.runs.complete(run.id, run.leaseToken!, {
      status: "ok",
      reply: "(stopped)",
      stopped: true,
      sessionId: member.sessionId!,
    });
  };
  const continuations = async () =>
    (await f.store.get(f.root.id))!.messages.filter(
      (message) => message.senderId === member.id && message.audience.join() === member.id,
    );
  return { f, member, setGoal, workerRuns, claimOpenRun, finishOpenRun, continuation, continuations };
}

test("a worker whose turn is interrupted while its goal is active is woken to continue until it stops making progress", async () => {
  const { f, member, setGoal, workerRuns, finishOpenRun, continuation, continuations } = await goalWorker();
  const goal = { ...createGoalRecord({ objective: "Exhaust the lane" }), tokensUsed: 10 };
  await setGoal(goal);
  await finishOpenRun();
  await continuation.sweep();
  await continuation.sweep();
  const [first, ...rest] = await continuations();
  assert.equal(rest.length, 0);
  assert.equal(first!.notifications[member.id]?.state, "pending");
  await f.service.sweep();
  const resumed = (await workerRuns()).find((run) => run.request.swarm?.messageId === first!.id)!;
  assert.ok(await f.service.binding({ ...resumed.request, runId: resumed.id }));

  await setGoal({ ...goal, tokensUsed: 20 });
  await finishOpenRun();
  await continuation.sweep();
  assert.equal((await continuations()).length, 2);

  await finishOpenRun();
  await continuation.sweep();
  assert.equal((await continuations()).length, 2);
  assert.equal((await workerRuns()).filter((run) => run.status === "pending").length, 0);
});

test("a goal continuation is queued outside the swarm's message and notification budgets", async () => {
  const { f, member, setGoal, finishOpenRun, continuation, continuations } = await goalWorker({
    messages: 2,
    notifications: 1,
  });
  await setGoal({ ...createGoalRecord({ objective: "Exhaust the lane" }), tokensUsed: 10 });
  await finishOpenRun();
  await assert.rejects(
    f.service.send(f.caller, { requestId: "over", audience: [member.id], text: "more", notify: true }),
    /budget/,
  );
  await continuation.sweep();
  assert.equal((await continuations()).length, 1);
  assert.equal((await f.store.get(f.root.id))!.notificationCount, 1);
  await f.service.send(f.caller, { requestId: "mailbox", audience: [member.id], text: "later", notify: false });
});

for (const [name, prepare] of [
  [
    "its goal is paused",
    async (w: Awaited<ReturnType<typeof goalWorker>>) => {
      await w.setGoal({ ...createGoalRecord({ objective: "Wait for a decision" }), status: "paused", tokensUsed: 5 });
    },
  ],
  [
    "its goal token cap is spent",
    async (w: Awaited<ReturnType<typeof goalWorker>>) => {
      await w.setGoal({ ...createGoalRecord({ objective: "Capped", capTokens: 100 }), tokensUsed: 100 });
    },
  ],
  [
    "the worker is stopped",
    async (w: Awaited<ReturnType<typeof goalWorker>>) => {
      await w.setGoal({ ...createGoalRecord({ objective: "Exhaust the lane" }), tokensUsed: 5 });
      await w.f.service.control(w.f.caller, { memberId: w.member.id, state: "stopped" });
    },
  ],
  ["it has no goal", async () => {}],
] as const)
  test(`a worker is not woken to continue when ${name}`, async () => {
    const w = await goalWorker();
    await w.finishOpenRun(() => prepare(w));
    await w.continuation.sweep();
    assert.equal((await w.continuations()).length, 0);
  });

test("a swarm turn resumed after an interruption keeps its dispatch provenance", async () => {
  const { f, workerRuns } = await goalWorker();
  const [run] = await workerRuns();
  assert.ok(await f.service.binding({ ...run!.request, runId: run!.id, resumeCause: { kind: "shutdown" } }));
});

test("a run that failed after a shutdown hand-back is continued, but an ordinary failure is not", async () => {
  for (const handedBack of [true, false]) {
    const { f, setGoal, claimOpenRun, continuation, continuations } = await goalWorker();
    await setGoal({ ...createGoalRecord({ objective: "Exhaust the lane" }), tokensUsed: 10 });
    let run = await claimOpenRun();
    if (handedBack) {
      await f.runs.releaseLease(run.id, run.leaseToken!, { kind: "shutdown" });
      run = (await f.runs.claimById(run.id, "test", 60_000))!;
    }
    await f.runs.fail(run.id, run.leaseToken!, "swarm claim budget exhausted", { retry: false });
    await continuation.sweep();
    assert.equal((await continuations()).length, handedBack ? 1 : 0);
  }
});

const PAUSE_REASON = "Which region should the survey cover?";

function pausedGoal(createdAt: number, pausedAt: number): GoalRecord {
  return {
    ...createGoalRecord({ objective: "Map the lane", now: createdAt }),
    status: "paused",
    tokensUsed: 50,
    updatedAt: pausedAt,
    pauseReason: PAUSE_REASON,
    governor: { verdict: "pause", reasons: PAUSE_REASON },
  };
}

async function pausedWorkerSwarm() {
  const f = await swarmFixture();
  const [worker, lead] = await f.service.spawn(f.caller, { requestId: "initial", count: 2, text: "work" });
  await f.service.sweep();
  const member = (await f.store.get(f.root.id))!.members.find((peer) => peer.id === worker!.id)!;
  const setGoal = async (goal: GoalRecord) => {
    const { lease } = await f.sessions.acquireLease(member.sessionId!);
    await f.sessions.setGoal(lease!, goal);
    await f.sessions.releaseLease(lease!);
  };
  const finishRuns = async () => {
    await f.service.sweep();
    for (const run of await f.runs.list()) {
      if (run.request.swarm?.recipientId !== member.id) continue;
      const claimed = run.status === "pending" ? await f.runs.claimById(run.id, "test", 60_000) : run;
      if (claimed?.status !== "running") continue;
      await f.runs.complete(run.id, claimed.leaseToken!, {
        status: "ok",
        reply: "paused",
        sessionId: member.sessionId!,
      });
    }
  };
  const notices = async () =>
    (await f.store.get(f.root.id))!.messages.filter(
      (message) => message.senderId === member.id && message.text.includes(PAUSE_REASON),
    );
  return {
    f,
    member,
    lead: lead!,
    setGoal,
    finishRuns,
    notices,
    continuation: createSwarmGoalContinuation(f.serviceOptions),
  };
}

test("a governor pause wakes the agent that gave the goal with the reason, once per pause", async () => {
  const { f, member, lead, setGoal, finishRuns, notices, continuation } = await pausedWorkerSwarm();
  const assigned = await f.service.send(await f.workerCaller(lead.id), {
    requestId: "goal",
    audience: [member.id],
    text: "survey",
    goal: { objective: "Map the lane" },
  });
  await setGoal(pausedGoal(assigned.createdAt, assigned.createdAt + 1));
  await finishRuns();
  await continuation.sweep();
  await continuation.sweep();
  const [notice, ...rest] = await notices();
  assert.equal(rest.length, 0);
  assert.deepEqual(notice!.audience, [lead.id]);
  assert.equal(notice!.notifications[lead.id]?.state, "pending");

  await setGoal(pausedGoal(assigned.createdAt, assigned.createdAt + 2));
  await continuation.sweep();
  assert.equal((await notices()).length, 2);
});

test("a worker that gave itself the goal has the pause sent to its parent", async () => {
  const { f, member, setGoal, finishRuns, notices, continuation } = await pausedWorkerSwarm();
  const self = await f.service.send(await f.workerCaller(member.id), {
    requestId: "own-goal",
    audience: [member.id],
    text: "next",
    goal: { objective: "Map the lane" },
  });
  await setGoal(pausedGoal(self.createdAt, self.createdAt + 1));
  await finishRuns();
  await continuation.sweep();
  const [notice] = await notices();
  assert.deepEqual(notice!.audience, [f.root.id]);
});

test("only a message to the worker from its goal's owner or the root, sent after the pause, lets it resume", async () => {
  const f = await swarmFixture();
  const [worker, lead, peer] = await f.service.spawn(f.caller, { requestId: "initial", count: 3, text: "work" });
  await f.service.sweep();
  const leadCaller = await f.workerCaller(lead!.id);
  const assigned = await f.service.send(leadCaller, {
    requestId: "goal",
    audience: [worker!.id],
    text: "survey",
    goal: { objective: "Map the lane" },
  });
  await f.service.sweep();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  await tick();
  const paused = pausedGoal(assigned.createdAt, Date.now());
  await tick();
  const send = async (caller: SwarmCaller, requestId: string, audience: string[], text: string) => {
    await f.service.send(caller, { requestId, audience, text, notify: true });
  };
  const run = (await f.runs.list()).find((item) => item.request.swarm?.messageId === assigned.id)!;
  const replied = (goal: GoalRecord) => f.service.goalOwnerReplied({ ...run.request, runId: run.id }, goal);
  assert.equal(await replied(paused), false);
  await send(
    await f.workerCaller(peer!.id),
    "relay",
    [worker!.id],
    `From ${lead!.id}: north region; resume your goal.`,
  );
  await send(leadCaller, "elsewhere", [peer!.id], "north region");
  assert.equal(await replied(paused), false);
  await send(leadCaller, "answer", [worker!.id], "north region");
  assert.equal(await replied(paused), true);
  assert.equal(await replied({ ...paused, governor: undefined }), false);
  const later = { ...paused, updatedAt: Date.now() + 1 };
  assert.equal(await replied(later), false);
  await tick();
  await send(f.caller, "root", [worker!.id], "north region");
  assert.equal(await replied(later), true);
});
