import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import { estimateHistoryTokens, forModelContext } from "../src/agent/context-compaction.ts";

import { contextSummary } from "../src/sessions/session-store.ts";
import { reconstructMessagesFromHistory } from "../src/agent/replay.ts";
import { countTokens } from "../src/util/tokens.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresErrorLog } from "../src/admin/postgres-error-log.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const modelContext = async (sessions: SessionStore, sessionId: string) =>
  forModelContext((await sessions.getContextWindow(sessionId)).items);

async function fixture(keepPercent: number | null = null) {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("recovery", "dm", "personal:test");
  const writer = { sessionId: session.id };
  for (let i = 0; i < 12; i++)
    await sessions.append(writer, {
      kind: "UserMessage",
      text: `old message ${i} `.repeat(100),
    });
  const agent = {
    contextTokenBudget: () => 500,
    compactHistory: async (): Promise<string> => {
      throw new Error("summary unavailable");
    },
  };
  const compaction = createCompaction({
    sessions,
    errors: createPostgresErrorLog(testDatabaseUrl()),
    agent,
    config: { getCompactionSettingsDurable: async () => ({ keepPercent, historyBudgetTokens: null }) },
  } as unknown as OrchestratorDeps);
  const input = {
    tenant,
    session,
    writer,
    visibleHistory: await modelContext(sessions, session.id),
    scopeId: "personal:test",
    orgScopeId: "org:test",
    actorId: "test",
  };
  return { sessions, agent, compaction, input };
}

test("mandatory summarizer failure recovers instead of wedging the pending turn", async () => {
  const f = await fixture();
  const history = await f.compaction.compactContextIfNeeded(f.input);
  assert.ok(history.length < f.input.visibleHistory.length);
  assert.equal((await f.sessions.getItems(f.input.session.id)).length, f.input.visibleHistory.length + 1);
  assert.deepEqual(await modelContext(f.sessions, f.input.session.id), history);
});

async function refresh(f: Awaited<ReturnType<typeof fixture>>) {
  f.input.visibleHistory = await modelContext(f.sessions, f.input.session.id);
}

test("the org compaction keep percent sets how much recent history recovery keeps", async () => {
  const kept = async (percent: number | null) => {
    const f = await fixture(percent);
    for (let i = 0; i < 30; i++)
      await f.sessions.append(f.input.writer, { kind: "UserMessage", text: `note ${i} `.repeat(5) });
    await refresh(f);
    return estimateHistoryTokens((await f.compaction.compactRecent(f.input)).slice(1));
  };
  const [low, standard, high] = [await kept(20), await kept(null), await kept(60)];
  assert.ok(low < standard && standard < high);
  assert.ok(standard <= 200 && high <= 300 && low <= 100);
});

test("recent recovery preserves a fitting saved summary without a model call", async () => {
  const f = await fixture();
  await f.sessions.append(f.input.writer, { kind: "ContextCompaction", throughSeq: 11, text: "Saved work." });
  await f.sessions.append(f.input.writer, {
    kind: "UserMessage",
    text: "Continue verification.",
  });
  await refresh(f);
  let calls = 0;
  f.agent.compactHistory = async () => {
    calls++;
    return "unexpected";
  };
  const before = await f.sessions.getItems(f.input.session.id);
  const history = await f.compaction.compactRecent(f.input);
  assert.equal(calls, 0);
  assert.match(contextSummary(history[0]!)!.text, /without a new summary/);
  assert.match(contextSummary(history[0]!)!.text, /Saved work/);
  assert.ok(estimateHistoryTokens(history) <= 300);
  const all = await f.sessions.getItems(f.input.session.id);
  assert.deepEqual(all.slice(0, before.length), before);
  assert.deepEqual(await modelContext(f.sessions, f.input.session.id), history);
  assert.equal(history[0]!.body.mode, "recent");
});

for (const failure of ["throw", "empty", "oversized"] as const) {
  test(`foreground ${failure} summary uses deterministic recovery`, async () => {
    const f = await fixture();
    f.agent.compactHistory = async () => {
      if (failure === "throw") throw new Error("provider refused");
      return failure === "empty" ? "" : "x".repeat(20000);
    };
    const history = await f.compaction.compactContextIfNeeded(f.input);
    assert.ok(estimateHistoryTokens(history) <= 300);
    assert.equal(history[0]!.body.mode, "recent");
  });
}

for (const stage of ["before", "during", "abort-error"] as const) {
  test(`cancellation ${stage} cannot commit a recovery boundary`, async () => {
    const f = await fixture();
    const abort = new AbortController();
    if (stage === "before") abort.abort();
    f.agent.compactHistory = async () => {
      if (stage === "during") abort.abort();
      throw new DOMException("cancelled", "AbortError");
    };
    await assert.rejects(f.compaction.compactContextIfNeeded({ ...f.input, cancel: abort.signal }), {
      name: "AbortError",
    });
    assert.deepEqual(await f.sessions.getItems(f.input.session.id), f.input.visibleHistory);
  });
}

test("append failure is not swallowed or retried as summarization failure", async () => {
  const f = await fixture();
  let calls = 0;
  f.agent.compactHistory = async () => {
    calls++;
    return "Summary.";
  };
  f.sessions.append = async () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(f.compaction.compactContextIfNeeded(f.input), /storage unavailable/);
  assert.equal(calls, 1);
  assert.ok(!(await f.sessions.getItems(f.input.session.id)).some((e) => e.body.mode === "recent"));
});

test("oversized entries and orphaned parallel tool results cannot bypass the recent budget", async () => {
  const f = await fixture();
  for (const item of [
    { kind: "ToolCall", callId: "large", tool: "files", body: { data: "oversized ".repeat(1000) } },
    { kind: "ToolCall", callId: "small", tool: "files" },
    { kind: "ToolResult", callId: "large", text: "ok" },
    { kind: "ToolResult", callId: "small", text: "ok" },
    { kind: "UserMessage", text: "Continue." },
  ] as const)
    await f.sessions.append(f.input.writer, item);
  await refresh(f);
  const history = await f.compaction.compactRecent(f.input);
  assert.ok(estimateHistoryTokens(history) <= 300);
  assert.ok(!history.some((e) => e.kind === "ToolResult"));
  assert.equal(history.at(-1)!.kind, "UserMessage");
  await f.sessions.append(f.input.writer, {
    kind: "UserMessage",
    text: "oversized ".repeat(1000),
  });
  await refresh(f);
  const emptyTail = await f.compaction.compactRecent(f.input);
  assert.equal(emptyTail.length, 1);
  assert.deepEqual(await modelContext(f.sessions, f.input.session.id), emptyTail);
});

test("recent recovery drops an oversized request inside a completed turn", async () => {
  const f = await fixture();
  await f.sessions.append(f.input.writer, {
    kind: "UserMessage",
    text: "discarded oversized request ".repeat(1000),
  });
  const last = await f.sessions.append(f.input.writer, {
    kind: "AgentMessage",
    text: "The action is complete.",
  });
  await refresh(f);
  const history = await f.compaction.compactRecent(f.input);
  assert.ok(countTokens(JSON.stringify(reconstructMessagesFromHistory(history))) < 500);
  assert.doesNotMatch(JSON.stringify(history), /discarded oversized request/);
  assert.equal(history.at(-1)!.seq, last.seq);
});

test("a trim says why the summary failed and keeps the last saved summary, not the previous failure", async () => {
  const f = await fixture();
  await f.sessions.append(f.input.writer, { kind: "ContextCompaction", throughSeq: 1, text: "Saved work summary." });
  const reasons = ["gateway budget exhausted", "provider key revoked"];
  let marker = "";
  for (const reason of reasons) {
    f.agent.compactHistory = async () => {
      throw new Error(reason);
    };
    for (let i = 0; i < 12; i++)
      await f.sessions.append(f.input.writer, { kind: "UserMessage", text: `newer message ${i} `.repeat(100) });
    const visibleHistory = await modelContext(f.sessions, f.input.session.id);
    const history = await f.compaction.compactContextIfNeeded({ ...f.input, visibleHistory });
    marker = contextSummary(history.find((item) => contextSummary(item))!)!.text;
    assert.ok(marker.includes(reason));
    assert.ok(marker.includes("Saved work summary."));
  }
  assert.ok(!marker.includes(reasons[0]!));
});
