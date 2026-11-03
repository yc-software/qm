import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompaction } from "../src/core/orchestrator/compaction.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import { estimateHistoryTokens, forModelContext } from "../src/agent/context-compaction.ts";

import { contextSummaryPayload } from "../src/sessions/session-store.ts";
import { reconstructMessagesFromHistory } from "../src/agent/replay.ts";
import { countTokens } from "../src/util/tokens.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { entryFromItem, itemFromEntry } from "../src/sessions/items.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";

const modelContext = async (sessions: SessionStore, sessionId: string) =>
  forModelContext(
    (await sessions.getContextWindow(sessionId)).items.map((item) => entryFromItem(item, "personal:test")),
  );
import { inTestTenant } from "./support/test-tenants.ts";

async function fixture() {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("recovery", "dm", "personal:test");
  const writer = { sessionId: session.id };
  for (let i = 0; i < 12; i++)
    await sessions.append(writer, {
      kind: "UserMessage",
      text: `old message ${i} `.repeat(100),
    });
  let resets = 0;
  const agent = {
    compactHistory: async (): Promise<string> => {
      throw new Error("summary unavailable");
    },
    resetSession: () => {
      resets++;
    },
  };
  const compaction = createCompaction({
    sessions,
    agent,
    maxContextTokens: 500,
  } as unknown as OrchestratorDeps);
  const input = {
    session,
    writer,
    visibleHistory: await modelContext(sessions, session.id),
    scopeId: "personal:test",
    orgScopeId: "org:test",
    actorId: "test",
  };
  return { sessions, agent, compaction, input, resets: () => resets };
}

test("mandatory summarizer failure recovers instead of wedging the pending turn", () =>
  inTestTenant(async () => {
    const f = await fixture();
    const history = await f.compaction.compactContextIfNeeded(f.input);
    assert.ok(history.length < f.input.visibleHistory.length);
    assert.equal(f.resets(), 1);
    assert.equal((await f.sessions.getItems(f.input.session.id)).length, f.input.visibleHistory.length + 1);
    assert.deepEqual(await modelContext(f.sessions, f.input.session.id), history);
  }));

async function refresh(f: Awaited<ReturnType<typeof fixture>>) {
  f.input.visibleHistory = await modelContext(f.sessions, f.input.session.id);
}

test("recent recovery preserves a fitting saved summary without a model call", () =>
  inTestTenant(async () => {
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
    assert.match(contextSummaryPayload(history[0]!)!.text, /without a new summary/);
    assert.match(contextSummaryPayload(history[0]!)!.text, /Saved work/);
    assert.ok(estimateHistoryTokens(history) <= 300);
    const all = await f.sessions.getItems(f.input.session.id);
    assert.deepEqual(all.slice(0, before.length), before);
    assert.deepEqual(await modelContext(f.sessions, f.input.session.id), history);
    assert.equal((history[0]!.payload as { mode: string }).mode, "recent");
  }));

for (const failure of ["throw", "empty", "oversized"] as const) {
  test(`foreground ${failure} summary uses deterministic recovery`, () =>
    inTestTenant(async () => {
      const f = await fixture();
      f.agent.compactHistory = async () => {
        if (failure === "throw") throw new Error("provider refused");
        return failure === "empty" ? "" : "x".repeat(20000);
      };
      const history = await f.compaction.compactContextIfNeeded(f.input);
      assert.ok(estimateHistoryTokens(history) <= 300);
      assert.equal((history[0]!.payload as { mode: string }).mode, "recent");
    }));
}

for (const stage of ["before", "during", "abort-error"] as const) {
  test(`cancellation ${stage} cannot commit a recovery boundary`, () =>
    inTestTenant(async () => {
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
      assert.equal(f.resets(), 0);
      assert.deepEqual(
        (await f.sessions.getItems(f.input.session.id)).map((item) => entryFromItem(item, "personal:test")),
        f.input.visibleHistory,
      );
    }));
}

for (const stage of ["append", "reset"] as const) {
  test(`${stage} failure is not swallowed or retried as summarization failure`, () =>
    inTestTenant(async () => {
      const f = await fixture();
      let calls = 0;
      f.agent.compactHistory = async () => {
        calls++;
        return "Summary.";
      };
      if (stage === "reset")
        f.agent.resetSession = () => {
          throw new Error("storage unavailable");
        };
      else
        f.sessions[stage] = async () => {
          throw new Error("storage unavailable");
        };
      await assert.rejects(f.compaction.compactContextIfNeeded(f.input), /storage unavailable/);
      assert.equal(calls, 1);
      assert.ok(!(await f.sessions.getItems(f.input.session.id)).some((e) => e.body.mode === "recent"));
    }));
}

test("oversized entries and orphaned parallel tool results cannot bypass the recent budget", () =>
  inTestTenant(async () => {
    const f = await fixture();
    for (const [type, payload] of [
      ["tool_call", { callId: "large", tool: "files", data: "oversized ".repeat(1000) }],
      ["tool_call", { callId: "small", tool: "files" }],
      ["tool_result", { callId: "large", result: "ok" }],
      ["tool_result", { callId: "small", result: "ok" }],
      ["user", { text: "Continue." }],
    ] as const)
      await f.sessions.append(f.input.writer, itemFromEntry({ type, payload }));
    await refresh(f);
    const history = await f.compaction.compactRecent(f.input);
    assert.ok(estimateHistoryTokens(history) <= 300);
    assert.ok(!history.some((e) => e.type === "tool_result"));
    assert.equal(history.at(-1)!.type, "user");
    await f.sessions.append(f.input.writer, {
      kind: "UserMessage",
      text: "oversized ".repeat(1000),
    });
    await refresh(f);
    const emptyTail = await f.compaction.compactRecent(f.input);
    assert.equal(emptyTail.length, 1);
    assert.deepEqual(await modelContext(f.sessions, f.input.session.id), emptyTail);
  }));

test("recent recovery drops an oversized request inside a completed turn", () =>
  inTestTenant(async () => {
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
  }));
