import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import {
  createGoalRecord,
  latestGoalEntry,
  latestGoalRecord,
  rehydrateOpenGoal,
  type GoalRecord,
} from "../src/harness/goal.ts";
import { filterHistoryForAudience } from "../src/resolution/context-filter.ts";
import { tapeCheckpointPayload } from "../src/sessions/session-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { ScopeId } from "../src/types.ts";

const scope = "personal:goal@example.com" as ScopeId;

async function fixture(
  status: GoalRecord["status"],
  summarize = true,
  goalOptions: { scopeLabel?: ScopeId; securityTainted?: boolean } = {},
) {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("goal", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  const goal = {
    ...createGoalRecord({
      objective: "verify the result",
      floor: { minMs: 32_400_000 },
      capTokens: 50_000,
      source: "tool",
    }),
    status,
    tokensUsed: 1234,
  };
  await sessions.append(lease, {
    type: "system",
    payload: { kind: "goal", goal, ...(goalOptions.securityTainted ? { securityTainted: true } : {}) },
    scopeLabel: goalOptions.scopeLabel ?? scope,
  });
  for (let i = 0; i < 10; i++) {
    await sessions.append(lease, { type: "user", payload: { text: `message ${i} `.repeat(100) }, scopeLabel: scope });
  }
  const harness = { models: summarize ? { compactHistory: async () => "Earlier work." } : {}, turns: {} };
  const compaction = createCompaction({
    sessions,
    maxContextTokens: 400,
    harness,
    modelGateway: { recordCall() {} },
  } as unknown as OrchestratorDeps);
  return { sessions, session, lease, goal, compaction, harness };
}

for (const status of ["active", "paused", "complete", "blocked"] as const) {
  test(`compaction preserves latest ${status} goal across context reload and repeated compaction`, async () => {
    const { sessions, session, lease, goal, compaction } = await fixture(status);
    try {
      for (let round = 0; round < 2; round++) {
        const history = forModelContext((await sessions.getContextWindow(session.id)).entries);
        const rebuilt = await compaction.compactContextIfNeeded({
          session,
          lease,
          visibleHistory: history,
          scopeId: scope,
          orgScopeId: "org:test",
          actorId: "test",
        });
        assert.deepEqual(latestGoalRecord(rebuilt), goal);
        const reloaded = forModelContext((await sessions.getContextWindow(session.id)).entries);
        assert.deepEqual(latestGoalRecord(reloaded), goal);
        assert.equal(
          rehydrateOpenGoal(reloaded)?.status ?? null,
          status === "active" || status === "paused" ? status : null,
        );
        await sessions.append(lease, { type: "user", payload: { text: "more work ".repeat(1000) }, scopeLabel: scope });
      }
    } finally {
      await sessions.releaseLease(lease);
    }
  });
}

test("bounded history without a summarizer retains the latest goal", async () => {
  const { sessions, session, lease, goal, compaction } = await fixture("active", false);
  try {
    const rebuilt = await compaction.compactContextIfNeeded({
      session,
      lease,
      visibleHistory: (await sessions.getContextWindow(session.id)).entries,
      scopeId: scope,
      orgScopeId: "org:test",
      actorId: "test",
    });
    assert.deepEqual(latestGoalRecord(rebuilt), goal);
  } finally {
    await sessions.releaseLease(lease);
  }
});

test("background compaction snapshots the latest goal under the write lease, not the summarized state", async () => {
  const { sessions, session, lease, goal, compaction, harness } = await fixture("active");
  await sessions.releaseLease(lease);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  harness.models.compactHistory = async () => {
    started.resolve();
    return finish.promise;
  };
  compaction.scheduleBackgroundCompaction({
    sessionId: session.id,
    scopeId: scope,
    orgScopeId: "org:test",
    actorId: "test",
  });
  await started.promise;
  const updateLease = (await sessions.acquireLease(session.id)).lease;
  assert.ok(updateLease);
  const closed = { ...goal, status: "complete" as const };
  await sessions.append(updateLease, {
    type: "tool_result",
    payload: { tool: "goal", action: "update", goal: closed },
    scopeLabel: scope,
  });
  await sessions.releaseLease(updateLease);
  finish.resolve("Earlier work.");
  const deadline = Date.now() + 3000;
  for (;;) {
    const entries = (await sessions.getContextWindow(session.id)).entries;
    if (entries.some((entry) => (entry.payload as { kind?: string }).kind === "context_summary")) {
      const snapshots = entries.filter(
        (entry) => entry.type === "system" && (entry.payload as { kind?: string }).kind === "goal",
      );
      assert.deepEqual(latestGoalRecord(snapshots), closed);
      assert.deepEqual(latestGoalRecord(forModelContext(entries)), closed);
      assert.equal(rehydrateOpenGoal(forModelContext(entries)), null);
      break;
    }
    assert.ok(Date.now() < deadline, "background compaction did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
});

test("foreground compaction cannot recover a goal excluded by audience filtering", async () => {
  const { sessions, session, lease, compaction } = await fixture("active", true, {
    scopeLabel: "personal:alice" as ScopeId,
  });
  try {
    const visibleHistory = filterHistoryForAudience(
      forModelContext((await sessions.getContextWindow(session.id)).entries),
      [{ id: "bob", type: "internal" }],
      scope,
      "org:test" as ScopeId,
    );
    assert.equal(latestGoalRecord(visibleHistory), null);
    const rebuilt = await compaction.compactContextIfNeeded({
      session,
      lease,
      visibleHistory,
      scopeId: scope,
      orgScopeId: "org:test",
      actorId: "bob",
    });
    assert.equal(latestGoalRecord(rebuilt), null);
    assert.equal(latestGoalRecord((await sessions.getContextWindow(session.id)).entries), null);
  } finally {
    await sessions.releaseLease(lease);
  }
});

for (const background of [false, true]) {
  test(`${background ? "background" : "foreground"} compaction preserves goal source scope and security taint`, async () => {
    const sourceScope = "personal:alice" as ScopeId;
    const { sessions, session, lease, compaction } = await fixture("active", true, {
      scopeLabel: sourceScope,
      securityTainted: true,
    });
    if (background) {
      await sessions.releaseLease(lease);
      compaction.scheduleBackgroundCompaction({
        sessionId: session.id,
        scopeId: scope,
        orgScopeId: "org:test",
        actorId: "alice",
        includeSecurityTainted: true,
      });
      const deadline = Date.now() + 3000;
      while (
        !(await sessions.getContextWindow(session.id)).entries.some(
          (entry) => (entry.payload as { kind?: string }).kind === "context_summary",
        )
      ) {
        assert.ok(Date.now() < deadline, "background compaction did not finish");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } else {
      try {
        await compaction.compactContextIfNeeded({
          session,
          lease,
          visibleHistory: forModelContext((await sessions.getContextWindow(session.id)).entries, {
            includeSecurityTainted: true,
          }),
          scopeId: scope,
          orgScopeId: "org:test",
          actorId: "alice",
        });
      } finally {
        await sessions.releaseLease(lease);
      }
    }
    const entries = (await sessions.getContextWindow(session.id)).entries;
    const carried = latestGoalEntry(entries);
    assert.ok(carried);
    assert.equal(carried.scopeLabel, sourceScope);
    assert.equal((carried.payload as { securityTainted?: boolean }).securityTainted, true);
    assert.equal(latestGoalRecord(forModelContext(entries)), null);
  });
}

for (const covered of [false, true]) {
  test(`goal compaction ${covered ? "advances covered tape through the summary" : "does not certify an existing tape gap"}`, async () => {
    const { sessions, session, lease, compaction } = await fixture("active");
    try {
      const visibleHistory = (await sessions.getContextWindow(session.id)).entries;
      if (covered)
        await sessions.appendTape(lease, {
          kind: "annotation",
          payload: tapeCheckpointPayload("turnEnd"),
          scopeLabel: scope,
          entrySeq: visibleHistory.at(-1)!.seq,
        });
      const before = await sessions.tapeCoverage(session.id);
      const rebuilt = await compaction.compactContextIfNeeded({
        session,
        lease,
        visibleHistory,
        scopeId: scope,
        orgScopeId: "org:test",
        actorId: "test",
      });
      const summary = rebuilt.find((entry) => (entry.payload as { kind?: string }).kind === "context_summary")!;
      assert.equal(await sessions.tapeCoverage(session.id), covered ? summary.seq : before);
    } finally {
      await sessions.releaseLease(lease);
    }
  });
}
