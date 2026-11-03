import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../src/runs/worker.ts";
import { createDrainController } from "../src/runs/drain.ts";
import type { InstanceRegistry } from "../src/runs/instance-registry.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal, TurnResult } from "../src/types.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await sleep(5);
  }
}
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};
const ok: TurnResult = { status: "ok", reply: "done" };

test("a superseded worker stops claiming; in-flight turns finish; claiming resumes when the newer build dies", async (t) => {
  const store = createPostgresRunStore(testDatabaseUrl());
  const { runs } = store;
  let superseded = false;
  const registry: InstanceRegistry = { beat: async () => superseded };
  const drain = createDrainController({ registry, sweepMs: 10 });
  drain.start();

  const releases: (() => void)[] = [];
  const orchestrator = {
    handleTurn: () => new Promise<TurnResult>((resolve) => releases.push(() => resolve(ok))),
  } as unknown as Orchestrator;
  const worker = createWorker({
    runs,
    orchestrator,
    leaseTtlMs: 10_000,
    pollMs: 5,
    canClaim: () => drain.canClaim(),
  });
  t.after(async () => {
    for (const release of releases) release();
    await worker.stop();
    await drain.stop();
    await store.close();
  });
  worker.start();
  const statuses = async (): Promise<string[]> => (await runs.list()).map((r) => r.status).sort();

  await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 });
  await until("the first run is claimed", () => releases.length === 1);

  superseded = true;
  await until("the drain controller sees the newer build", () => !drain.canClaim());
  await runs.enqueue({ sessionId: "s2", request: turn, maxAttempts: 3 });
  releases[0]!();
  await until("the in-flight turn finishes", async () => (await statuses()).includes("done"));
  await sleep(100);
  assert.deepEqual(await statuses(), ["done", "pending"], "the new run was NOT claimed while superseded");
  assert.equal(releases.length, 1);

  superseded = false;
  await until("claiming resumes once the newer build disappears", () => releases.length === 2);
});
