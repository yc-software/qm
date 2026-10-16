import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { estimateHistoryTokens, forModelContext } from "../src/harness/context-compaction.ts";

import { contextSummaryPayload, createContextSummaryPayload } from "../src/sessions/session-store.ts";
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

test("recent recovery preserves a fitting saved summary without a model call", async () => {
  const f = await fixture();
  try {
    await f.sessions.append(f.input.lease, {
      type: "system",
      payload: createContextSummaryPayload(11, "Saved work."),
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

for (const stage of ["append", "reset"] as const) {
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

test("recent recovery drops an oversized request inside a completed turn", async () => {
  const f = await fixture();
  try {
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
    const history = await f.compaction.compactRecent(f.input);
    assert.ok(countTokens(JSON.stringify(reconstructMessagesFromHistory(history))) < 500);
    assert.doesNotMatch(JSON.stringify(history), /discarded oversized request/);
    assert.equal(history.at(-1)!.seq, last.seq);
  } finally {
    await f.sessions.releaseLease(f.input.lease);
  }
});
