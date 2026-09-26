import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { estimateHistoryTokens, forModelContext } from "../src/harness/context-compaction.ts";

import {
  contextSummaryPayload,
  createContextSummaryPayload,
  tapeCheckpointPayload,
} from "../src/sessions/session-store.ts";
import { createGoalRecord, goalSnapshotPayload, latestGoalRecord } from "../src/harness/goal.ts";
import { filterHistoryForAudience } from "../src/resolution/context-filter.ts";
import { foldTape, lintFold, tapeEventsEntitled } from "../src/harness/tape-fold.ts";
import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";
import { countTokens } from "../src/util/tokens.ts";

async function fixture() {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("recovery", "dm", "personal:test");
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  for (let i = 0; i < 12; i++)
    await sessions.append(lease, {
      type: "user",
      payload: { text: `old message ${i} `.repeat(100) },
      scopeLabel: "personal:test",
    });
  let resets = 0;
  const harness = {
    models: {
      compactHistory: async (): Promise<string> => {
        throw new Error("summary unavailable");
      },
    },
    turns: {
      resetSession: () => {
        resets++;
      },
    },
  };
  const compaction = createCompaction({
    sessions,
    harness,
    maxContextTokens: 500,
    modelGateway: { recordCall() {} },
  } as unknown as OrchestratorDeps);
  const input = {
    session,
    lease,
    visibleHistory: forModelContext((await sessions.getContextWindow(session.id)).entries),
    scopeId: "personal:test",
    orgScopeId: "org:test",
    actorId: "test",
  };
  return { sessions, harness, compaction, input, resets: () => resets };
}

test("mandatory summarizer failure recovers instead of wedging the pending turn", async () => {
  const f = await fixture();
  try {
    const history = await f.compaction.compactContextIfNeeded(f.input);
    assert.ok(history.length < f.input.visibleHistory.length);
    assert.equal(f.resets(), 1);
    assert.equal((await f.sessions.getEntries(f.input.session.id)).length, f.input.visibleHistory.length + 1);
    assert.deepEqual(forModelContext((await f.sessions.getContextWindow(f.input.session.id)).entries), history);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

async function refresh(f: Awaited<ReturnType<typeof fixture>>) {
  f.input.visibleHistory = forModelContext((await f.sessions.getContextWindow(f.input.session.id)).entries);
}

for (const status of ["active", "paused", "complete", "blocked"] as const) {
  test(`recent recovery preserves ${status} goal and a fitting saved summary without a model call`, async () => {
    const f = await fixture();
    const goal = { ...createGoalRecord({ objective: "verify result", source: "tool" }), status };
    try {
      await f.sessions.append(f.input.lease, {
        type: "system",
        payload: createContextSummaryPayload(11, "Saved work."),
        scopeLabel: "personal:test",
      });
      await f.sessions.append(f.input.lease, {
        type: "system",
        payload: goalSnapshotPayload(goal),
        scopeLabel: "personal:test",
      });
      await f.sessions.append(f.input.lease, {
        type: "user",
        payload: { text: "Continue verification." },
        scopeLabel: "personal:test",
      });
      await refresh(f);
      let calls = 0;
      f.harness.models.compactHistory = async () => {
        calls++;
        return "unexpected";
      };
      const before = await f.sessions.getEntries(f.input.session.id);
      const history = await f.compaction.compactRecent(f.input);
      assert.equal(calls, 0);
      assert.deepEqual(latestGoalRecord(history), goal);
      assert.equal(history.filter((e) => latestGoalRecord([e])).length, 1);
      assert.match(contextSummaryPayload(history[0]!)!.text, /without a new summary/);
      assert.match(contextSummaryPayload(history[0]!)!.text, /Saved work/);
      assert.ok(estimateHistoryTokens(history) <= 300);
      const all = await f.sessions.getEntries(f.input.session.id);
      assert.deepEqual(all.slice(0, before.length), before);
      assert.deepEqual(forModelContext((await f.sessions.getContextWindow(f.input.session.id)).entries), history);
      assert.equal((history[0]!.payload as { mode: string }).mode, "recent");
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}

for (const failure of ["throw", "empty", "oversized"] as const) {
  test(`foreground ${failure} summary uses deterministic recovery`, async () => {
    const f = await fixture();
    try {
      f.harness.models.compactHistory = async () => {
        if (failure === "throw") throw new Error("provider refused");
        return failure === "empty" ? "" : "x".repeat(20000);
      };
      const history = await f.compaction.compactContextIfNeeded(f.input);
      assert.ok(estimateHistoryTokens(history) <= 300);
      assert.equal((history[0]!.payload as { mode: string }).mode, "recent");
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}

for (const stage of ["before", "during", "abort-error"] as const) {
  test(`cancellation ${stage} cannot commit a recovery boundary`, async () => {
    const f = await fixture();
    const abort = new AbortController();
    try {
      if (stage === "before") abort.abort();
      f.harness.models.compactHistory = async () => {
        if (stage === "during") abort.abort();
        throw new DOMException("cancelled", "AbortError");
      };
      await assert.rejects(f.compaction.compactContextIfNeeded({ ...f.input, cancel: abort.signal }), {
        name: "AbortError",
      });
      assert.equal(f.resets(), 0);
      assert.deepEqual(await f.sessions.getEntries(f.input.session.id), f.input.visibleHistory);
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}

for (const stage of ["append", "appendTape", "reset"] as const) {
  test(`${stage} failure is not swallowed or retried as summarization failure`, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      f.harness.models.compactHistory = async () => {
        calls++;
        return "Summary.";
      };
      if (stage === "reset")
        f.harness.turns.resetSession = () => {
          throw new Error("storage unavailable");
        };
      else
        f.sessions[stage] = async () => {
          throw new Error("storage unavailable");
        };
      await assert.rejects(f.compaction.compactContextIfNeeded(f.input), /storage unavailable/);
      assert.equal(calls, 1);
      assert.ok(
        !(await f.sessions.getEntries(f.input.session.id)).some(
          (e) => (e.payload as { mode?: string }).mode === "recent",
        ),
      );
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}

test("oversized entries and orphaned parallel tool results cannot bypass the recent budget", async () => {
  const f = await fixture();
  try {
    for (const [type, payload] of [
      ["tool_call", { callId: "large", tool: "files", data: "oversized ".repeat(1000) }],
      ["tool_call", { callId: "small", tool: "files" }],
      ["tool_result", { callId: "large", result: "ok" }],
      ["tool_result", { callId: "small", result: "ok" }],
      ["user", { text: "Continue." }],
    ] as const)
      await f.sessions.append(f.input.lease, { type, payload, scopeLabel: "personal:test" });
    await refresh(f);
    const history = await f.compaction.compactRecent(f.input);
    assert.ok(estimateHistoryTokens(history) <= 300);
    assert.ok(!history.some((e) => e.type === "tool_result"));
    assert.equal(history.at(-1)!.type, "user");
    await f.sessions.append(f.input.lease, {
      type: "user",
      payload: { text: "oversized ".repeat(1000) },
      scopeLabel: "personal:test",
    });
    await refresh(f);
    const emptyTail = await f.compaction.compactRecent(f.input);
    assert.equal(emptyTail.length, 1);
    assert.deepEqual(forModelContext((await f.sessions.getContextWindow(f.input.session.id)).entries), emptyTail);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

test("recent recovery cannot recover an unauthorized summary or goal", async () => {
  const f = await fixture();
  try {
    await f.sessions.append(f.input.lease, {
      type: "system",
      payload: createContextSummaryPayload(11, "private sentinel"),
      scopeLabel: "personal:other",
    });
    await f.sessions.append(f.input.lease, {
      type: "system",
      payload: goalSnapshotPayload(createGoalRecord({ objective: "private sentinel", source: "tool" })),
      scopeLabel: "personal:other",
    });
    await refresh(f);
    f.input.visibleHistory = filterHistoryForAudience(
      f.input.visibleHistory,
      [{ id: "test", type: "internal" }],
      "personal:test",
      "org:test",
    );
    const history = await f.compaction.compactRecent(f.input);
    assert.equal(latestGoalRecord(history), null);
    assert.doesNotMatch(JSON.stringify(history), /private sentinel/);
    assert.doesNotMatch(JSON.stringify(foldTape(await f.sessions.getTape(f.input.session.id))), /private sentinel/);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

test("recent recovery replaces the replay prefix even when the exclusion ends inside a completed turn", async () => {
  const f = await fixture();
  const goal = createGoalRecord({ objective: "verify result", source: "tool" });
  try {
    await f.sessions.append(f.input.lease, {
      type: "system",
      payload: goalSnapshotPayload(goal),
      scopeLabel: "org:test",
    });
    await f.sessions.append(f.input.lease, {
      type: "user",
      payload: { text: "discarded oversized request ".repeat(1000) },
      scopeLabel: "personal:test",
    });
    const last = await f.sessions.append(f.input.lease, {
      type: "assistant",
      payload: { text: "The action is complete." },
      scopeLabel: "team:eng",
    });
    await refresh(f);
    for (const entry of f.input.visibleHistory)
      if (entry.type === "user" || entry.type === "assistant")
        await f.sessions.appendTape(f.input.lease, {
          kind: "message",
          payload: {
            role: entry.type,
            content: [{ type: "text", text: (entry.payload as { text: string }).text }],
            timestamp: entry.createdAt,
          },
          scopeLabel: entry.scopeLabel,
          entrySeq: entry.seq,
          harness: "pi",
        });
    await f.sessions.appendTape(f.input.lease, {
      kind: "annotation",
      payload: tapeCheckpointPayload("turnEnd"),
      scopeLabel: "personal:test",
      entrySeq: last.seq,
    });
    const history = await f.compaction.compactRecent(f.input);
    const tape = await f.sessions.getTape(f.input.session.id);
    const folded = foldTape(tape);
    assert.deepEqual(folded, reconstructMessagesFromHistory(history));
    assert.ok(countTokens(JSON.stringify(folded)) < 500);
    assert.ok(lintFold(folded).ok);
    assert.deepEqual(latestGoalRecord(history), goal);
    assert.ok(history.at(-1)!.seq > last.seq);
    assert.equal(await f.sessions.tapeCoverage(f.input.session.id), history[0]!.seq);
    assert.equal(
      tapeEventsEntitled(tape, [{ id: "test", type: "internal", teamIds: ["eng"] }], "personal:test", "org:test"),
      true,
    );
    assert.equal(tapeEventsEntitled(tape, [{ id: "test", type: "internal" }], "personal:test", "org:test"), false);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

test("a failed recent replay replacement cannot advance tape coverage", async () => {
  const f = await fixture();
  try {
    await f.sessions.appendTape(f.input.lease, {
      kind: "annotation",
      payload: tapeCheckpointPayload("turnEnd"),
      scopeLabel: "personal:test",
      entrySeq: 11,
    });
    const appendTape = f.sessions.appendTape;
    f.sessions.appendTape = async (lease, record) => {
      if ((record.payload as { event?: string }).event === "legacy_import") throw new Error("import unavailable");
      return appendTape(lease, record);
    };
    await assert.rejects(f.compaction.compactRecent(f.input), /import unavailable/);
    assert.equal(await f.sessions.tapeCoverage(f.input.session.id), 11);
    assert.equal(f.resets(), 0);
    assert.ok((await f.sessions.latestEntrySeq(f.input.session.id)) > 11);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

for (const covered of [false, true]) {
  test(`recent recovery ${covered ? "advances" : "does not manufacture"} tape coverage`, async () => {
    const f = await fixture();
    try {
      if (covered)
        await f.sessions.appendTape(f.input.lease, {
          kind: "annotation",
          payload: tapeCheckpointPayload("turnEnd"),
          scopeLabel: "personal:test",
          entrySeq: 11,
        });
      const before = await f.sessions.tapeCoverage(f.input.session.id);
      const history = await f.compaction.compactRecent(f.input);
      assert.equal(await f.sessions.tapeCoverage(f.input.session.id), covered ? history[0]!.seq : before);
      const tape = await f.sessions.getTape(f.input.session.id);
      const recovery = tape.find((row) => row.kind === "context_event")!;
      assert.equal((recovery.payload as { mode: string }).mode, "recent");
      assert.equal((recovery.payload as { event: string }).event, "legacy_import");
      assert.equal(recovery.coversEntrySeq, covered ? history[0]!.seq : undefined);
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}

test("an incomplete recent replacement cannot label retained messages with an older replay boundary", async () => {
  const f = await fixture();
  try {
    await f.sessions.append(f.input.lease, {
      type: "assistant",
      payload: { text: "Retained completed action." },
      scopeLabel: "personal:test",
    });
    await f.sessions.appendTape(f.input.lease, {
      kind: "annotation",
      payload: tapeCheckpointPayload("turnEnd"),
      scopeLabel: "personal:test",
      entrySeq: 5,
    });
    await refresh(f);
    await f.compaction.compactRecent(f.input);
    assert.equal(await f.sessions.tapeCoverage(f.input.session.id), 5);
    await f.sessions.appendTape(f.input.lease, {
      kind: "context_event",
      payload: { event: "compaction", text: "A later summary." },
      scopeLabel: "personal:test",
      coversEntrySeq: 11,
    });
    assert.match(JSON.stringify(foldTape(await f.sessions.getTape(f.input.session.id))), /Retained completed action/);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});

for (const tainted of [false, true]) {
  test(`a ${tainted ? "tainted" : "foreign"} summary still supplies the durable exclusion floor`, async () => {
    const f = await fixture();
    try {
      await f.sessions.append(f.input.lease, {
        type: "system",
        payload: {
          ...createContextSummaryPayload(11, "hidden summary sentinel"),
          ...(tainted ? { securityTainted: true } : {}),
        },
        scopeLabel: tainted ? "personal:test" : "personal:other",
      });
      await f.sessions.append(f.input.lease, {
        type: "user",
        payload: { text: "Latest request." },
        scopeLabel: "personal:test",
      });
      await refresh(f);
      f.input.visibleHistory = filterHistoryForAudience(
        f.input.visibleHistory,
        [{ id: "test", type: "internal" }],
        "personal:test",
        "org:test",
      );
      const history = await f.compaction.compactRecent(f.input);
      assert.equal(contextSummaryPayload(history[0]!)!.throughSeq, 11);
      const reloaded = filterHistoryForAudience(
        forModelContext((await f.sessions.getContextWindow(f.input.session.id)).entries),
        [{ id: "test", type: "internal" }],
        "personal:test",
        "org:test",
      );
      assert.deepEqual(reloaded, history);
      assert.ok(estimateHistoryTokens(reloaded) <= 300);
      assert.doesNotMatch(JSON.stringify(reloaded), /old message|hidden summary sentinel/);
      assert.doesNotMatch(
        JSON.stringify(foldTape(await f.sessions.getTape(f.input.session.id))),
        /old message|hidden summary sentinel/,
      );
    } finally {
      await f.sessions.releaseLease(f.input.lease);
    }
  });
}
