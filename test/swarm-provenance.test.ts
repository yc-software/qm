import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

async function dispatch() {
  const f = await swarmFixture();
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

test("execution metadata does not change stable dispatch provenance", async () => {
  const f = await dispatch();
  assert.ok(
    await f.service.binding({
      ...f.input,
      attempt: f.run.attempts,
      runLeaseToken: f.run.leaseToken!,
      background: true,
      finalAttempt: false,
      cancel: new AbortController().signal,
      handoff: new AbortController().signal,
      handoffDeadline: new AbortController().signal,
      queueMs: 7,
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
  harness: (i) => {
    i.harness = "codex";
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
