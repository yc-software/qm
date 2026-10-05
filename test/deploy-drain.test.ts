import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createWorker } from "../src/runs/worker.ts";
import { createDrainController } from "../src/runs/drain.ts";
import type { InstanceRegistry } from "../src/runs/instance-registry.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal, TurnResult } from "../src/types.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};
const ok: TurnResult = { status: "ok", reply: "done" };

test("a superseded worker stops claiming; in-flight turns finish; claiming resumes when the newer build dies", async () => {
  const { runs } = createMemoryRunStore();
  let superseded = false;
  const registry: InstanceRegistry = { beat: async () => superseded };
  const drain = createDrainController({ registry, sweepMs: 10 });
  drain.start();

  let release: (() => void) | null = null;
  const turns: Promise<void>[] = [];
  const orchestrator = {
    handleTurn: () =>
      new Promise<TurnResult>((resolve) => {
        const p = new Promise<void>((r) => (release = () => (resolve(ok), r())));
        turns.push(p);
      }),
  } as unknown as Orchestrator;
  const worker = createWorker({
    runs,
    orchestrator,
    leaseTtlMs: 10_000,
    pollMs: 5,
    canClaim: () => drain.canClaim(),
  });
  worker.start();

  await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 });
  await sleep(50);
  assert.equal(turns.length, 1, "the first run was claimed");

  superseded = true;
  await sleep(50);
  await runs.enqueue({ sessionId: "s2", request: turn, maxAttempts: 3 });
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
  await worker.stop();
  await drain.stop();
});
