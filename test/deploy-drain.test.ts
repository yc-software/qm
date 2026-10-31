import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnRunner } from "../src/turns/turn-runner.ts";
import { TURN_QUEUES } from "../src/turns/absurd-schema.ts";
import { createDrainController } from "../src/runs/drain.ts";
import type { InstanceRegistry } from "../src/runs/instance-registry.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal, TurnResult } from "../src/types.ts";
import { testRunStore } from "./support/turns.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};
const ok = (sessionId: string): TurnResult => ({ status: "ok", sessionId, reply: "done" });

test("a superseded worker stops claiming; in-flight turns finish; claiming resumes when the newer build dies", async () => {
  const store = testRunStore();
  const { runs } = store;
  let superseded = false;
  const registry: InstanceRegistry = { beat: async () => superseded };
  const drain = createDrainController({ registry, sweepMs: 10 });
  drain.start();

  let release: (() => void) | null = null;
  const turns: Promise<void>[] = [];
  const orchestrator = {
    handleTurn: (input: OrchestratorInput) =>
      new Promise<TurnResult>((resolve) => {
        const p = new Promise<void>((r) => (release = () => (resolve(ok(input.conversation.threadRef)), r())));
        turns.push(p);
      }),
  } as unknown as Orchestrator;
  const worker = createTurnRunner({
    ledger: store.ledger,
    orchestrator,
    queues: TURN_QUEUES,
    slots: 4,
    pollMs: 5,
    canClaim: () => drain.canClaim(),
  });
  worker.start();

  await runs.enqueue({
    sessionId: "s1",
    request: { ...turn, conversation: { ...turn.conversation, threadRef: "s1" } },
    maxAttempts: 3,
  });
  await sleep(50);
  assert.equal(turns.length, 1, "the first run was claimed");

  superseded = true;
  await sleep(50);
  await runs.enqueue({
    sessionId: "s2",
    request: { ...turn, conversation: { ...turn.conversation, threadRef: "s2" } },
    maxAttempts: 3,
  });
  release!();
  await sleep(80);
  const statuses = (await runs.list()).map((r) => r.status).sort();
  assert.deepEqual(
    statuses,
    ["done", "pending"],
    "the in-flight turn finished and the new run was NOT claimed while superseded",
  );

  superseded = false;
  await sleep(80);
  assert.equal(turns.length, 2, "claiming resumed once the newer build disappeared");
  release!();
  await worker.stopClaims();
  await worker.drained(5_000);
  await drain.stop();
  await store.close();
});
