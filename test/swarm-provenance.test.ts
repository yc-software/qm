import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { forkOfBotWork } from "../src/sessions/session-syscalls.ts";
import { testTenant } from "./support/test-tenant.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { createSwarmService, type SwarmCaller } from "../src/swarms/swarm-service.ts";
import { errMessage } from "../src/util/errors.ts";

const outcome = (work: Promise<unknown>) =>
  work.then(
    () => "accepted",
    (error: unknown) => errMessage(error),
  );

async function dispatch(options: Parameters<typeof swarmFixture>[0] = {}) {
  const f = await swarmFixture(options);
  const [peer] = await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  await f.service.sweep();
  const caller = await f.workerCaller(peer!.id);
  if (caller.kind !== "agent") throw new Error("expected agent");
  const run = (await f.runs.get(caller.claims.runId!))!;
  return { ...f, run, input: { ...run.request, runId: run.id } };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  return value;
}

test("durable request provenance is independent of JSON object key order", async () => {
  const f = await dispatch();
  assert.ok(await f.service.binding(testTenant, f.input));
  assert.ok(await f.service.binding(testTenant, reverseKeys(f.input) as OrchestratorInput));
});

test("a swarm worker started by a Slack bot's turn keeps the bot marker and binds", async () => {
  const f = await dispatch({ runtime: { botActor: true } });
  assert.equal(f.input.botActor, true);
  assert.ok(await f.service.binding(testTenant, f.input));
  const { botActor: _botActor, ...unmarked } = f.input;
  await assert.rejects(f.service.binding(testTenant, unmarked), /forged swarm provenance/);
});

test("a turn doing a bot's work starts a swarm whose workers do the bot's work and mail a hidden root unless it is a fork", async () => {
  const f = await swarmFixture({ claims: { botActor: true } });
  const runId = f.caller.kind === "agent" ? f.caller.claims.runId! : "";
  await f.runs.markBotLimited(testTenant, runId);
  const aborted: string[] = [];
  const service = createSwarmService({ ...f.serviceOptions, signals: { send: async (id) => aborted.push(id) > 0 } });
  const [worker] = await service.spawn(f.caller, { requestId: "initial", text: "work" });
  await service.sweep();
  const caller = await f.workerCaller(worker!.id);
  assert.equal(caller.kind === "agent" && caller.claims.botActor, true);
  await service.send(caller, { requestId: "report", audience: [f.root.id], text: "done" });
  await service.sweep();
  await f.sessions.updateForkProvenance(f.root.id, { forkedFrom: { sessionId: randomUUID() }, forkBoundarySeq: 1 });
  await service.send(caller, { requestId: "fork-report", audience: [f.root.id], text: "done in the fork" });
  await service.sweep();
  const states = (await f.store.get(f.root.id))!.messages.slice(-2).map((m) => m.notifications[f.root.id]!.state);
  assert.deepEqual(states, ["mailbox", "queued"]);
  const queued = (await f.runs.list()).find((run) => run.request.swarm?.recipientId === f.root.id)!;
  const person = await f.sessions.getOrCreateByThread(`web:alice:${randomUUID()}`, f.root.type, f.root.scopeId);
  await f.sessions.updateForkProvenance(f.root.id, { forkedFrom: { sessionId: person.id }, forkBoundarySeq: 1 });
  await service.binding(testTenant, { ...queued.request, runId: queued.id });
  await service.sweep();
  assert.equal((await f.store.get(f.root.id))!.messages.at(-1)!.notifications[f.root.id]!.state, "mailbox");
  await service.notePersonUse({ swarmId: f.root.id });
  assert.ok(aborted.includes(runId), "a person's use of the swarm's computers stops the turn that started it");
});

test("a fork of a worker in a swarm a Slack bot started does the bot's work", async () => {
  for (const botActor of [true, false]) {
    const f = await dispatch(botActor ? { runtime: { botActor } } : {});
    const worker = (await f.sessions.getByThread(f.input.conversation.threadRef))!;
    const fork = await f.sessions.getOrCreateByThread(`web:alice:${randomUUID()}`, worker.type, worker.scopeId);
    await f.sessions.updateForkProvenance(fork.id, { forkedFrom: { sessionId: worker.id }, forkBoundarySeq: 1 });
    const session = await f.sessions.get(fork.id);
    assert.equal(await forkOfBotWork(testTenant, session, { sessions: f.sessions, swarms: f.service }), botActor);
    assert.equal(await forkOfBotWork(testTenant, session, { sessions: f.sessions }), true);
    await f.sessions.updateForkProvenance(fork.id, { forkedFrom: { sessionId: randomUUID() }, forkBoundarySeq: 1 });
    assert.equal(await forkOfBotWork(testTenant, await f.sessions.get(fork.id), { sessions: f.sessions }), true);
    assert.equal(await f.service.botStartedWorker({ id: worker.id, threadRef: `swarm:${randomUUID()}:w` }), true);
  }
});

test("a Slack bot on a person's swarm roster cannot direct the person's workers", async () => {
  const f = await swarmFixture({ channel: "C1" });
  if (f.caller.kind !== "agent") throw new Error("wrong caller");
  await f.sessions.addParticipant(f.root.id, "release-bot");
  const [worker] = await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
  await f.service.sweep();
  await f.runs.complete(f.caller.claims.runId!, f.caller.claims.runLeaseToken!, { status: "ok", reply: "started" });
  const { run } = await f.runs.enqueue({
    sessionId: f.root.threadRef,
    request: { ...f.template, actor: { id: "release-bot", type: "internal" }, botActor: true, text: "use the swarm" },
  });
  const claim = (await f.runs.claimById(run.id, "bot-turn", 60_000))!;
  const bot: SwarmCaller = {
    kind: "agent",
    claims: {
      ...f.caller.claims,
      actorId: "release-bot",
      runId: run.id,
      runAttempt: claim.attempts,
      runLeaseToken: claim.leaseToken!,
      botActor: true,
    },
  };
  const sent = await outcome(f.service.send(bot, { requestId: "bot-send", audience: "all", text: "bot work" }));
  const spawned = await outcome(f.service.spawn(bot, { requestId: "bot-spawn", text: "bot work" }));
  const stopped = await outcome(f.service.control(bot, { memberId: worker!.id, state: "stopped" }));
  const rewritten = await outcome(f.service.context(bot, { plan: "bot work" }));
  const inspected = await outcome(f.service.inspect(bot));
  await f.service.sweep();
  const dispatched = (await f.runs.list()).filter(
    (entry) => entry.request.swarm && entry.request.text.includes("bot work"),
  );
  const swarm = (await f.store.get(f.root.id))!;
  const refused = "a Slack bot's turn cannot direct a person's swarm";
  assert.deepEqual(
    {
      sent,
      spawned,
      stopped,
      rewritten,
      inspected,
      dispatched: dispatched.map((entry) => [entry.request.actor.id, entry.request.botActor ?? false]),
      workerControl: swarm.members.find((member) => member.id === worker!.id)!.control,
      rootContext: swarm.members.find((member) => member.id === f.root.id)!.context,
    },
    {
      sent: refused,
      spawned: refused,
      stopped: refused,
      rewritten: refused,
      inspected: refused,
      dispatched: [],
      workerControl: undefined,
      rootContext: {},
    },
  );
});

test("a Slack bot that started a swarm cannot direct the work a person later sent into it", async () => {
  const f = await swarmFixture({ channel: "C1" });
  if (f.caller.kind !== "agent") throw new Error("wrong caller");
  await f.sessions.addParticipant(f.root.id, "release-bot");
  await f.runs.complete(f.caller.claims.runId!, f.caller.claims.runLeaseToken!, { status: "ok", reply: "idle" });
  const first = await f.rootTurn("release-bot", true);
  const [botWorker] = await f.service.spawn(first.caller, { requestId: "bot-initial", text: "bot work" });
  await first.done();
  await f.service.sweep();
  const person = await f.rootTurn("alice", false);
  await f.service.send(person.caller, { requestId: "person-send", audience: [botWorker!.id], text: "person work" });
  await person.done();
  await f.service.sweep();
  const bot = await f.rootTurn("release-bot", true);
  const sent = await outcome(
    f.service.send(bot.caller, { requestId: "bot-send", audience: [botWorker!.id], text: "drop that, do this" }),
  );
  const stopped = await outcome(f.service.control(bot.caller, { memberId: botWorker!.id, state: "stopped" }));
  const rewritten = await outcome(f.service.context(bot.caller, { plan: "bot plan" }));
  const inspected = await outcome(f.service.inspect(bot.caller));
  const botAgent = await f.workerCaller(botWorker!.id);
  const botWorkerSent = await outcome(
    f.service.send(botAgent, { requestId: "bot-worker-send", audience: "all", text: "bot result" }),
  );
  const botWorkerInspected = await outcome(f.service.inspect(botAgent));
  await f.service.sweep();
  const swarm = (await f.store.get(f.root.id))!;
  const personMessage = swarm.messages.find((message) => message.text === "person work")!;
  const woken = (await f.runs.list()).filter((entry) => entry.request.text.includes("person work"));
  const refused = "a Slack bot's turn cannot direct a person's swarm";
  assert.deepEqual(
    {
      sent,
      stopped,
      rewritten,
      inspected,
      botWorkerSent,
      botWorkerInspected,
      personNotifications: personMessage.notifications,
      woken: woken.map((entry) => entry.sessionId),
      workerControl: swarm.members.find((member) => member.id === botWorker!.id)!.control,
      rootContext: swarm.members.find((member) => member.id === f.root.id)!.context,
    },
    {
      sent: refused,
      stopped: refused,
      rewritten: refused,
      inspected: refused,
      botWorkerSent: refused,
      botWorkerInspected: refused,
      personNotifications: { [botWorker!.id]: { state: "mailbox" } },
      woken: [],
      workerControl: undefined,
      rootContext: {},
    },
  );
});

test("a person's turn cannot add workers to a swarm a Slack bot started", async () => {
  const f = await swarmFixture({ channel: "C1" });
  if (f.caller.kind !== "agent") throw new Error("wrong caller");
  await f.sessions.addParticipant(f.root.id, "release-bot");
  await f.runs.complete(f.caller.claims.runId!, f.caller.claims.runLeaseToken!, { status: "ok", reply: "idle" });
  const bot = await f.rootTurn("release-bot", true);
  await f.service.spawn(bot.caller, { requestId: "bot-initial", text: "bot work" });
  await bot.done();
  await f.service.sweep();
  const person = await f.rootTurn("alice", false);
  const spawned = await outcome(f.service.spawn(person.caller, { requestId: "person-spawn", text: "person work" }));
  await person.done();
  await f.service.sweep();
  const swarm = (await f.store.get(f.root.id))!;
  const personRuns = (await f.runs.list()).filter((entry) => entry.request.text.includes("person work"));
  assert.deepEqual(
    {
      spawned,
      members: swarm.members.length,
      personRuns: personRuns.map((entry) => [entry.request.actor.id, entry.request.botActor ?? false]),
    },
    { spawned: "a person's turn cannot add workers to a swarm a Slack bot started", members: 2, personRuns: [] },
  );
});

test("execution metadata does not change stable dispatch provenance", async () => {
  const f = await dispatch();
  assert.ok(
    await f.service.binding(testTenant, {
      ...f.input,
      attempt: f.run.attempts,
      runLeaseToken: f.run.leaseToken!,
      finalAttempt: false,
      cancel: new AbortController().signal,
      runStartedAt: Date.now(),
    }),
  );
});

const mutations: Record<string, (input: OrchestratorInput) => void> = {
  "actor identity": (i) => {
    i.actor.id = "outsider";
  },
  "actor classification": (i) => {
    i.actor.type = "external" as never;
  },
  "member audience": (i) => {
    i.conversation.audience.push({ id: "outsider", type: "internal" });
  },
  "channel scope": (i) => {
    i.conversation.channelRef = "channel:other";
  },
  "swarm tuple": (i) => {
    i.swarm!.messageId = "forged";
  },
  "live origin": (i) => {
    i.origin = { kind: "human" };
  },
  "owner credential union": (i) => {
    i.origin = { ...i.origin, useOwnerKeychain: true } as never;
  },
  "screening payload": (i) => {
    i.origin = { kind: "automation", screenData: "forged benign content" };
  },
  destination: (i) => {
    i.deliveryTarget = "external-target";
  },
  surface: (i) => {
    i.surface = "slack";
  },
  "surface tools": (i) => {
    i.surfaceTools = true;
  },
  "read-only": (i) => {
    i.readOnly = true;
  },
  model: (i) => {
    i.model = "forged-model";
  },
  effort: (i) => {
    i.thinkingLevel = "high";
  },
  "fast mode": (i) => {
    i.fastMode = true;
  },
  approval: (i) => {
    i.approval = { requestId: "forged", approved: true };
  },
  memory: (i) => {
    i.skipMemory = true;
  },
  "scope version": (i) => {
    i.scopeVersion = "forged";
  },
  "turn text": (i) => {
    i.text += " forged";
  },
  deadline: (i) => {
    i.turnWallClockMs = 1;
  },
  goal: (i) => {
    i.swarmGoal = { objective: "forged", token_cap: 1, assignedAt: Date.now() };
  },
  participants: (i) => {
    i.sessionParticipantIds = ["outsider"];
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`forged ${name} cannot reuse a real dispatch`, async () => {
    const f = await dispatch();
    const input = structuredClone(f.input);
    mutate(input);
    await assert.rejects(f.service.binding(testTenant, input));
  });

test("tampered durable request cannot authorize a payload absent from the shared message", async () => {
  const f = await dispatch();
  const input = { ...f.input, text: "forged text not in the shared forum" };
  const get = f.runs.getByDedupKey.bind(f.runs);
  f.runs.getByDedupKey = async (key) => {
    const run = await get(key);
    return run ? { ...run, request: { ...run.request, text: input.text } } : null;
  };
  await assert.rejects(f.service.binding(testTenant, input));
});
