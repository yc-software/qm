import assert from "node:assert/strict";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import type { RunStore } from "../../src/runs/run-store.ts";
import { testDatabaseUrl } from "./test-database.ts";

export function testRuns(): RunStore {
  return createPostgresRunStore(testDatabaseUrl()).runs;
}

export async function holdThread(runs: RunStore, threadRef: string): Promise<() => Promise<void>> {
  const request = {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "a live turn",
    origin: { kind: "human" },
  } as unknown as OrchestratorInput;
  const { run } = await runs.enqueue({ sessionId: threadRef, request });
  const claimed = await runs.claimById(run.id, "test-worker", 60_000);
  assert.ok(claimed?.leaseToken, "the live turn's run is claimed");
  return async () => {
    assert.ok(await runs.complete(run.id, claimed.leaseToken!, { status: "ok" }));
  };
}
