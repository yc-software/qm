import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import { forModelContext } from "../src/agent/context-compaction.ts";
import { createGoalRecord } from "../src/agent/goal.ts";
import type { ScopeId } from "../src/types.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresErrorLog } from "../src/admin/postgres-error-log.ts";

const scope = "personal:goal@example.com" as ScopeId;

test("compaction leaves the session goal on its row and writes no goal entries", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("goal", "dm", scope);
  const writer = { sessionId: session.id };
  const goal = {
    ...createGoalRecord({ objective: "verify the result", floor: { minMs: 32_400_000 } }),
    tokensUsed: 1234,
  };
  await sessions.setGoal(writer, goal);
  for (let i = 0; i < 10; i++) {
    await sessions.append(writer, { kind: "UserMessage", text: `message ${i} `.repeat(100) });
  }
  const compaction = createCompaction({
    sessions,
    errors: createPostgresErrorLog(testDatabaseUrl()),
    maxContextTokens: 400,
    agent: { compactHistory: async () => "Earlier work." },
  } as unknown as OrchestratorDeps);
  for (let round = 0; round < 2; round++) {
    const rebuilt = await compaction.compactContextIfNeeded({
      session,
      writer,
      visibleHistory: forModelContext((await sessions.getContextWindow(session.id)).items),
      scopeId: scope,
      actorId: "test",
    });
    assert.ok(rebuilt.some((item) => item.kind === "ContextCompaction"));
    await sessions.append(writer, { kind: "UserMessage", text: "more work ".repeat(1000) });
  }
  const goalEntries = (await sessions.getItems(session.id)).filter(
    (entry) => entry.kind !== "UserMessage" && entry.kind !== "ContextCompaction",
  );
  assert.equal(goalEntries.length, 0, "compaction does not copy goals into the log");
  assert.deepEqual((await sessions.goals([session.id])).get(session.id), goal);
});

test("background compaction cannot revive an older goal over one closed while it summarized", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("goal-race", "dm", scope);
  const writer = { sessionId: session.id };
  const goal = createGoalRecord({ objective: "verify the result" });
  await sessions.setGoal(writer, goal);
  for (let i = 0; i < 10; i++) {
    await sessions.append(writer, { kind: "UserMessage", text: `message ${i} `.repeat(100) });
  }
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const compaction = createCompaction({
    sessions,
    errors: createPostgresErrorLog(testDatabaseUrl()),
    maxContextTokens: 400,
    agent: {
      compactHistory: async () => {
        started.resolve();
        return finish.promise;
      },
    },
  } as unknown as OrchestratorDeps);
  compaction.scheduleBackgroundCompaction({
    sessionId: session.id,
    scopeId: scope,
    actorId: "test",
  });
  await started.promise;
  const closed = { ...goal, status: "complete" as const, updatedAt: goal.updatedAt + 1 };
  await sessions.setGoal({ sessionId: session.id }, closed);
  finish.resolve("Earlier work.");
  const deadline = Date.now() + 3000;
  while (!(await sessions.getItems(session.id)).some((entry) => entry.kind === "ContextCompaction")) {
    assert.ok(Date.now() < deadline, "background compaction did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual((await sessions.goals([session.id])).get(session.id), closed);
});
