import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import { createGoalRecord } from "../src/harness/goal.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { ScopeId } from "../src/types.ts";

const scope = "personal:goal@example.com" as ScopeId;

test("compaction leaves the session goal on its row and writes no goal entries", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("goal", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  const goal = {
    ...createGoalRecord({ objective: "verify the result", floor: { minMs: 32_400_000 } }),
    tokensUsed: 1234,
  };
  await sessions.setGoal(lease, goal);
  for (let i = 0; i < 10; i++) {
    await sessions.append(lease, { kind: "UserMessage", text: `message ${i} `.repeat(100) });
  }
  const compaction = createCompaction({
    sessions,
    maxContextTokens: 400,
    harness: { models: { compactHistory: async () => "Earlier work." }, turns: {} },
    modelGateway: { recordCall() {} },
  } as unknown as OrchestratorDeps);
  try {
    for (let round = 0; round < 2; round++) {
      const rebuilt = await compaction.compactContextIfNeeded({
        session,
        lease,
        visibleHistory: forModelContext((await sessions.getContextWindow(session.id)).items),
        scopeId: scope,
        orgScopeId: "org:test",
        actorId: "test",
      });
      assert.ok(rebuilt.some((item) => item.kind === "ContextCompaction"));
      await sessions.append(lease, { kind: "UserMessage", text: "more work ".repeat(1000) });
    }
  } finally {
    await sessions.releaseLease(lease);
  }
  const goalEntries = (await sessions.getItems(session.id)).filter((item) => item.body.kind === "goal");
  assert.equal(goalEntries.length, 0, "compaction does not copy goals into the log");
  assert.deepEqual((await sessions.goals([session.id])).get(session.id), goal);
});

test("background compaction cannot revive an older goal over one closed while it summarized", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("goal-race", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  const goal = createGoalRecord({ objective: "verify the result" });
  await sessions.setGoal(lease, goal);
  for (let i = 0; i < 10; i++) {
    await sessions.append(lease, { kind: "UserMessage", text: `message ${i} `.repeat(100) });
  }
  await sessions.releaseLease(lease);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const compaction = createCompaction({
    sessions,
    maxContextTokens: 400,
    harness: {
      models: {
        compactHistory: async () => {
          started.resolve();
          return finish.promise;
        },
      },
      turns: {},
    },
    modelGateway: { recordCall() {} },
  } as unknown as OrchestratorDeps);
  compaction.scheduleBackgroundCompaction({
    sessionId: session.id,
    scopeId: scope,
    orgScopeId: "org:test",
    actorId: "test",
  });
  await started.promise;
  const closing = (await sessions.acquireLease(session.id)).lease;
  assert.ok(closing);
  const closed = { ...goal, status: "complete" as const, updatedAt: goal.updatedAt + 1 };
  await sessions.setGoal(closing, closed);
  await sessions.releaseLease(closing);
  finish.resolve("Earlier work.");
  const deadline = Date.now() + 3000;
  while (!(await sessions.getItems(session.id)).some((item) => item.kind === "ContextCompaction")) {
    assert.ok(Date.now() < deadline, "background compaction did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual((await sessions.goals([session.id])).get(session.id), closed);
});
