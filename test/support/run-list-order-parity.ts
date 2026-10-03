import assert from "node:assert/strict";
import type { RunStore } from "../../src/runs/run-store.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";

export async function assertRunListOrderParity(
  runs: RunStore,
  threadRef: string,
  turn: (text: string) => OrchestratorInput,
): Promise<void> {
  const wallClock = Date.now;
  const created: string[] = [];
  let now = Date.UTC(2100, 0, 1);
  Date.now = () => now;
  try {
    const enqueue = async (sessionId: string, text: string) => {
      const run = (await runs.enqueue({ sessionId, request: turn(text) })).run;
      created.push(run.id);
      return run;
    };
    const tiedOlder = await enqueue(threadRef, "tied older");
    const excluded = await enqueue(`${threadRef}-neighbor`, "excluded");
    const tiedNewer = await enqueue(threadRef, "tied newer");
    now -= 1;
    const ordinaryOlder = await enqueue(`${threadRef}:task:older`, "ordinary older");

    assert.deepEqual(
      (await runs.list({ limit: 3 })).map((run) => run.id),
      [tiedNewer.id, excluded.id, tiedOlder.id],
    );
    assert.deepEqual(
      (await runs.list({ threadRef, limit: 2 })).map((run) => run.id),
      [tiedNewer.id, tiedOlder.id],
    );
    assert.deepEqual(
      (await runs.list({ threadRef })).map((run) => run.id),
      [tiedNewer.id, tiedOlder.id, ordinaryOlder.id],
    );
    assert.equal((await runs.latestForThread(threadRef))?.id, tiedNewer.id);
  } finally {
    Date.now = wallClock;
    await Promise.all(created.map((runId) => runs.withdraw(runId)));
  }
}
