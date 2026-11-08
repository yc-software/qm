import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { SwarmCaller } from "../src/swarms/swarm-service.ts";
import { errMessage } from "../src/util/errors.ts";

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
  assert.ok(await f.service.binding(f.input));
  assert.ok(await f.service.binding(reverseKeys(f.input) as OrchestratorInput));
});

test("a swarm worker started by a Slack bot's turn keeps the bot marker and binds", async () => {
  const f = await dispatch({ runtime: { botActor: true } });
  assert.equal(f.input.botActor, true);
  assert.ok(await f.service.binding(f.input));
  const { botActor: _botActor, ...unmarked } = f.input;
  await assert.rejects(f.service.binding(unmarked), /forged swarm provenance/);
});

test("a Slack bot on a person's swarm roster cannot send or spawn work for the person's workers", async () => {
  const f = await swarmFixture({ channel: "C1" });
  if (f.caller.kind !== "agent") throw new Error("wrong caller");
  await f.sessions.addParticipant(f.root.id, "release-bot");
  await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
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
  const outcome = (work: Promise<unknown>) =>
    work.then(
      () => "accepted",
      (error: unknown) => errMessage(error),
    );
  const sent = await outcome(f.service.send(bot, { requestId: "bot-send", audience: "all", text: "bot work" }));
  const spawned = await outcome(f.service.spawn(bot, { requestId: "bot-spawn", text: "bot work" }));
  await f.service.sweep();
  const dispatched = (await f.runs.list()).filter(
    (entry) => entry.request.swarm && entry.request.text.includes("bot work"),
  );
  assert.deepEqual(
    { sent, spawned, dispatched: dispatched.map((entry) => [entry.request.actor.id, entry.request.botActor ?? false]) },
    {
      sent: "a Slack bot's turn cannot send work to a person's swarm",
      spawned: "a Slack bot's turn cannot send work to a person's swarm",
      dispatched: [],
    },
  );
});

test("execution metadata does not change stable dispatch provenance", async () => {
  const f = await dispatch();
  assert.ok(
    await f.service.binding({
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
  grants: (i) => {
    i.unattendedGrants = ["forged"];
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
    await assert.rejects(f.service.binding(input));
  });

test("tampered durable request cannot authorize a payload absent from the shared message", async () => {
  const f = await dispatch();
  const input = { ...f.input, text: "forged text not in the shared forum" };
  const get = f.runs.getByDedupKey.bind(f.runs);
  f.runs.getByDedupKey = async (key) => {
    const run = await get(key);
    return run ? { ...run, request: { ...run.request, text: input.text } } : null;
  };
  await assert.rejects(f.service.binding(input));
});
