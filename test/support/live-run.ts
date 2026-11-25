import assert from "node:assert/strict";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import type { RunStore } from "../../src/runs/run-store.ts";
import { testDatabaseUrl } from "./test-database.ts";
import { testTenant } from "./test-tenant.ts";

export function testRuns(): RunStore {
  return createPostgresRunStore(testDatabaseUrl()).runs;
}

export async function startedBy(url: string, id: string, botActor = false) {
  const actor = { id, type: "internal" as const };
  const conversation = { kind: "dm" as const, threadRef: id, audience: [actor] };
  const request = { actor, conversation, origin: { kind: "direct" as const }, text: "run it", botActor };
  const { run } = await createPostgresRunStore(url).runs.enqueue({ sessionId: id, request });
  return { starter: { tenant: testTenant, actorId: id, botActor }, runId: run.id };
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

const RUN = { runAttempt: 1, runLeaseToken: "live", threadRef: "dm:live" };
const running = { status: "running", leaseToken: "live", attempts: 1, sessionId: "dm:live", leaseExpiresAt: Infinity };

export const liveRunBinding = (actorId: string) => ({ ...RUN, runId: `live:${actorId}` });
export const liveRunClaims = (actorId: string) => ({
  ...liveRunBinding(actorId),
  internalAudience: true,
  personAuthority: true,
});
export const liveRun = (id: string, sessionId = "dm:live") => {
  const actor = { id, type: "internal" as const };
  return {
    ...running,
    sessionId,
    request: {
      surface: "test",
      actor,
      conversation: { kind: "dm" as const, threadRef: sessionId, audience: [actor] },
      origin: { kind: "human" as const },
      text: "run it",
    },
  };
};

export const liveRunStore = (runs?: RunStore) =>
  ({
    ...runs,
    get: async (id: string) => (id.startsWith("live:") ? liveRun(id.slice(5)) : (runs?.get(id) ?? null)),
  }) as never;
