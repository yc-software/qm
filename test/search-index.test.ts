import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { searchRowsFromEntries, syncSearchIndex } from "../src/harness/tape-projection.ts";
import { TAPE_RENDER_VERSION, type Lease, type SessionStore } from "../src/sessions/session-store.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";

const scope = "personal:viewer@example.com" as ScopeId;
const VIEWER = "viewer";
const TOOL_SECRET = "brokered-credential-XJQ99";
const THINKING_SECRET = "private-deliberation-KLM42";
const FOOTER_SECRET = "env-footer-roster-ZZTOP7";

interface Sim {
  store: SessionStore;
  session: Session;
  lease: Lease;
}

async function simSession(threadRef = "dm:search-index-test"): Promise<Sim> {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread(threadRef, "dm", scope);
  await store.addParticipant(session.id, VIEWER, undefined, { includeHistory: true });
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  return { store, session, lease: lease! };
}

async function simTurn(
  sim: Sim,
  turn: { input: string; author?: string; reply: string; toolResult?: string; thinking?: string; envFooter?: string },
): Promise<void> {
  const { store, lease } = sim;
  const emit = (type: SessionEntry["type"], payload: unknown) =>
    store.append(lease, { type, payload, scopeLabel: scope });
  const tape = (rec: Parameters<SessionStore["appendTape"]>[1]) => store.appendTape(lease, rec);
  const user = await emit("user", { text: turn.input, ...(turn.author ? { name: turn.author } : {}) });
  await tape({
    kind: "message",
    harness: "pi",
    payload: {
      role: "user",
      content: [{ type: "text", text: [turn.input, turn.envFooter].filter(Boolean).join("\n\n") }],
    },
    scopeLabel: scope,
    entrySeq: user.seq,
    meta: {
      bareText: turn.input,
      ...(turn.author ? { author: turn.author } : {}),
      entryCreatedAt: user.createdAt,
    },
  });
  if (turn.toolResult || turn.thinking) {
    const content: unknown[] = [
      ...(turn.thinking ? [{ type: "thinking", thinking: turn.thinking }] : []),
      ...(turn.toolResult
        ? [{ type: "toolCall", id: "call_1", name: "execute", arguments: { command: "fetch" } }]
        : []),
    ];
    if (turn.thinking) await emit("thinking", { thinking: turn.thinking });
    await tape({
      kind: "message",
      harness: "pi",
      payload: { role: "assistant", content, stopReason: "stop" },
      scopeLabel: scope,
    });
    if (turn.toolResult) {
      await emit("tool_call", { command: "fetch", tool: "execute", callId: "call_1" });
      await emit("tool_result", { tool: "execute", callId: "call_1", isError: false, result: turn.toolResult });
      await tape({
        kind: "message",
        harness: "pi",
        payload: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "execute",
          content: [{ type: "text", text: turn.toolResult }],
          isError: false,
        },
        scopeLabel: scope,
      });
    }
  }
  await tape({
    kind: "message",
    harness: "pi",
    payload: { role: "assistant", content: [{ type: "text", text: turn.reply }], stopReason: "stop" },
    scopeLabel: scope,
  });
  const finalEntry = await emit("assistant", { text: turn.reply });
  await tape({
    kind: "annotation",
    payload: {
      subturnEnd: true,
      render: TAPE_RENDER_VERSION,
      entry: { type: "assistant", payload: { text: turn.reply }, at: finalEntry.createdAt },
    },
    scopeLabel: scope,
    entrySeq: finalEntry.seq,
  });
  await tape({
    kind: "annotation",
    payload: { turnEnd: true, render: TAPE_RENDER_VERSION },
    scopeLabel: scope,
    entrySeq: finalEntry.seq,
  });
}

async function tapeOnlyTurn(
  sim: Sim,
  turn: { input: string; author?: string; reply: string; toolResult?: string; thinking?: string; envFooter?: string },
  baseSeq: number,
): Promise<number> {
  const { store, lease } = sim;
  const tape = (rec: Parameters<SessionStore["appendTape"]>[1]) => store.appendTape(lease, rec);
  const userSeq = baseSeq;
  const replySeq = baseSeq + 1;
  const at = Date.now();
  await tape({
    kind: "message",
    harness: "pi",
    payload: {
      role: "user",
      content: [{ type: "text", text: [turn.input, turn.envFooter].filter(Boolean).join("\n\n") }],
    },
    scopeLabel: scope,
    entrySeq: userSeq,
    meta: {
      bareText: turn.input,
      ...(turn.author ? { author: turn.author } : {}),
      entryCreatedAt: at,
    },
  });
  if (turn.toolResult || turn.thinking) {
    const content: unknown[] = [
      ...(turn.thinking ? [{ type: "thinking", thinking: turn.thinking }] : []),
      ...(turn.toolResult
        ? [{ type: "toolCall", id: "call_1", name: "execute", arguments: { command: "fetch" } }]
        : []),
    ];
    await tape({
      kind: "message",
      harness: "pi",
      payload: { role: "assistant", content, stopReason: "stop" },
      scopeLabel: scope,
    });
    if (turn.toolResult) {
      await tape({
        kind: "message",
        harness: "pi",
        payload: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "execute",
          content: [{ type: "text", text: turn.toolResult }],
          isError: false,
        },
        scopeLabel: scope,
      });
    }
  }
  await tape({
    kind: "message",
    harness: "pi",
    payload: { role: "assistant", content: [{ type: "text", text: turn.reply }], stopReason: "stop" },
    scopeLabel: scope,
  });
  await tape({
    kind: "annotation",
    payload: {
      subturnEnd: true,
      render: TAPE_RENDER_VERSION,
      entry: { type: "assistant", payload: { text: turn.reply }, at },
    },
    scopeLabel: scope,
    entrySeq: replySeq,
  });
  await tape({
    kind: "annotation",
    payload: { turnEnd: true, render: TAPE_RENDER_VERSION },
    scopeLabel: scope,
    entrySeq: replySeq,
  });
  return replySeq + 1;
}

async function secretTurn(sim: Sim): Promise<void> {
  await simTurn(sim, {
    input: "please check the deploy status",
    author: "Alex",
    reply: "The deploy finished cleanly.",
    toolResult: `credential response: ${TOOL_SECRET}`,
    thinking: `weighing options ${THINKING_SECRET}`,
    envFooter: `[env: ${FOOTER_SECRET}]`,
  });
}

test("message writes index only conversational text — tool results and thinking stay unsearchable", async () => {
  const sim = await simSession();
  await secretTurn(sim);
  assert.equal(await sim.store.missingSearchEntries(sim.session.id), 0);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, TOOL_SECRET), []);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, THINKING_SECRET), []);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, "brokered credential"), []);
  const replyHits = await sim.store.searchEntries(VIEWER, "finished cleanly");
  assert.equal(replyHits.length, 1);
  assert.equal(replyHits[0]!.type, "assistant");
  const userHits = await sim.store.searchEntries(VIEWER, "deploy status");
  assert.ok(userHits.some((h) => h.type === "user" && h.author === "Alex"));
});

test("raw tape payloads are never indexed — the env footer stays unsearchable", async () => {
  const sim = await simSession();
  await secretTurn(sim);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, FOOTER_SECRET), []);
});

test("searchRowsFromEntries drops every non-conversational entry type", () => {
  const entries: SessionEntry[] = (
    [
      ["user", { text: "hello" }],
      ["assistant", { text: "hi" }],
      ["text", { text: "narration" }],
      ["thinking", { thinking: TOOL_SECRET, text: TOOL_SECRET }],
      ["tool_call", { tool: "execute", callId: "c", command: TOOL_SECRET, text: TOOL_SECRET }],
      ["tool_result", { tool: "execute", callId: "c", result: TOOL_SECRET, text: TOOL_SECRET }],
      ["system", { kind: "context_summary", text: TOOL_SECRET }],
      ["delivery", { text: TOOL_SECRET }],
      ["soul", { text: TOOL_SECRET }],
      ["approval_request", { text: TOOL_SECRET }],
      ["approval_resolved", { text: TOOL_SECRET }],
    ] as const
  ).map(([type, payload], seq) => ({
    sessionId: "s",
    seq,
    parentSeq: seq === 0 ? null : seq - 1,
    type,
    payload,
    scopeLabel: scope,
    createdAt: seq,
  }));
  assert.deepEqual(
    searchRowsFromEntries(entries, -1).map((r) => r.type),
    ["user", "assistant", "text"],
  );
  assert.ok(searchRowsFromEntries(entries, -1).every((r) => !r.text.includes(TOOL_SECRET)));
});

test("messages are searchable before a turn completes or tape can be projected", async () => {
  const sim = await simSession();
  await sim.store.append(sim.lease, { type: "user", payload: { text: "legacy document" }, scopeLabel: scope });
  assert.equal((await sim.store.searchEntries(VIEWER, "legacy document")).length, 1);
  assert.equal(await sim.store.missingSearchEntries(sim.session.id), 0);
});

test("tenure windows filter tape-index hits the same as entries-index hits", async () => {
  const sim = await simSession();
  await simTurn(sim, { input: "early private question", reply: "early answer" });
  await sim.store.addParticipant(sim.session.id, "latecomer");
  await simTurn(sim, { input: "late shared question", reply: "late answer" });
  assert.deepEqual(await sim.store.searchEntries("latecomer", "early private"), []);
  assert.equal((await sim.store.searchEntries("latecomer", "late shared")).length, 1);
  assert.equal((await sim.store.searchEntries(VIEWER, "early private")).length, 1);
});

test("lastSearchableEntrySeq skips trailing tool output and empty replies", async () => {
  const sim = await simSession();
  await simTurn(sim, { input: "find the report", reply: "Found it." });
  const reply = (await sim.store.getEntries(sim.session.id)).at(-1)!;
  await sim.store.append(sim.lease, {
    type: "tool_result",
    payload: { tool: "execute", callId: "t1", isError: false, result: "trailing output" },
    scopeLabel: scope,
  });
  await sim.store.append(sim.lease, { type: "assistant", payload: { text: "" }, scopeLabel: scope });
  assert.equal(await sim.store.lastSearchableEntrySeq(sim.session.id), reply.seq);
  assert.equal(await sim.store.lastSearchableEntrySeq("missing-session"), -1);
});

test("a foreign-harness turn indexes its trigger and reply from the coarse projection", async () => {
  const sim = await simSession();
  const emit = (type: SessionEntry["type"], payload: unknown) =>
    sim.store.append(sim.lease, { type, payload, scopeLabel: scope });
  const user = await emit("user", { text: "codex please summarize" });
  await sim.store.appendTape(sim.lease, {
    kind: "message",
    harness: "codex",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex please summarize" }] },
    scopeLabel: scope,
    entrySeq: user.seq,
    meta: { bareText: "codex please summarize", entryCreatedAt: user.createdAt },
  });
  await emit("tool_result", { tool: "execute", callId: "c1", isError: false, result: TOOL_SECRET });
  await sim.store.appendTape(sim.lease, {
    kind: "message",
    harness: "codex",
    payload: { type: "function_call_output", call_id: "c1", output: TOOL_SECRET },
    scopeLabel: scope,
  });
  const finalEntry = await emit("assistant", { text: "Here is the summary." });
  await sim.store.appendTape(sim.lease, {
    kind: "annotation",
    payload: {
      subturnEnd: true,
      render: TAPE_RENDER_VERSION,
      entry: { type: "assistant", payload: { text: "Here is the summary." }, at: finalEntry.createdAt },
    },
    scopeLabel: scope,
    entrySeq: finalEntry.seq,
  });
  await sim.store.appendTape(sim.lease, {
    kind: "annotation",
    payload: { turnEnd: true, render: TAPE_RENDER_VERSION },
    scopeLabel: scope,
    entrySeq: finalEntry.seq,
  });
  assert.equal(await sim.store.missingSearchEntries(sim.session.id), 0);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, TOOL_SECRET), []);
  assert.equal((await sim.store.searchEntries(VIEWER, "codex please")).length, 1);
  assert.equal((await sim.store.searchEntries(VIEWER, "summary")).length, 1);
});

test("turn-end sync indexes a tape-only turn: only conversational text, never raw tape payloads", async () => {
  const sim = await simSession();
  await tapeOnlyTurn(
    sim,
    {
      input: "please check the deploy status",
      author: "Alex",
      reply: "The deploy finished cleanly.",
      toolResult: `credential response: ${TOOL_SECRET}`,
      thinking: `weighing options ${THINKING_SECRET}`,
      envFooter: `[env: ${FOOTER_SECRET}]`,
    },
    0,
  );
  assert.deepEqual(await sim.store.searchEntries(VIEWER, "deploy status"), []);
  const sync = await syncSearchIndex(sim.store, sim.lease);
  assert.equal(sync.servable, true);
  assert.ok(sync.indexed >= 2);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, TOOL_SECRET), []);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, THINKING_SECRET), []);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, FOOTER_SECRET), []);
  assert.equal((await sim.store.searchEntries(VIEWER, "finished cleanly")).length, 1);
  const userHits = await sim.store.searchEntries(VIEWER, "deploy status");
  assert.ok(userHits.some((h) => h.type === "user" && h.author === "Alex"));
});

test("syncSearchIndex is idempotent and advances the watermark across tape-only turns", async () => {
  const sim = await simSession();
  let base = await tapeOnlyTurn(sim, { input: "first question", reply: "first answer" }, 0);
  const first = await syncSearchIndex(sim.store, sim.lease);
  assert.equal(first.servable, true);
  assert.ok(first.indexed > 0);
  const again = await syncSearchIndex(sim.store, sim.lease);
  assert.equal(again.indexed, 0);
  base = await tapeOnlyTurn(sim, { input: "second question", reply: "second answer" }, base);
  const next = await syncSearchIndex(sim.store, sim.lease);
  assert.ok(next.indexed > 0);
  assert.equal(await sim.store.searchIndexCoverage(sim.session.id), next.coveredSeq);
  assert.equal((await sim.store.searchEntries(VIEWER, "second question")).length, 1);
});

test("an unservable projection leaves the index untouched and reports it", async () => {
  const sim = await simSession();
  await sim.store.append(sim.lease, { type: "user", payload: { text: "legacy body" }, scopeLabel: scope });
  await sim.store.appendTape(sim.lease, {
    kind: "context_event",
    payload: { event: "legacy_import", messages: [{ role: "user", content: "legacy body" }], scopes: [scope] },
    scopeLabel: scope,
    coversEntrySeq: 0,
  });
  const before = await sim.store.searchIndexCoverage(sim.session.id);
  const sync = await syncSearchIndex(sim.store, sim.lease);
  assert.equal(sync.servable, false);
  assert.equal(sync.indexed, 0);
  assert.equal(sync.coveredSeq, before);
  assert.equal(await sim.store.searchIndexCoverage(sim.session.id), before);
  assert.equal((await sim.store.searchEntries(VIEWER, "legacy body")).length, 1);
});

test("a permanently unservable session is memoized: the next sync never re-reads the tape", async () => {
  const sim = await simSession();
  await sim.store.append(sim.lease, { type: "user", payload: { text: "legacy fork body" }, scopeLabel: scope });
  await sim.store.appendTape(sim.lease, {
    kind: "context_event",
    payload: { event: "legacy_import", messages: [{ role: "user", content: "legacy fork body" }], scopes: [scope] },
    scopeLabel: scope,
    coversEntrySeq: 0,
  });
  const first = await syncSearchIndex(sim.store, sim.lease);
  assert.equal(first.servable, false);
  let tapeReads = 0;
  const spy = {
    ...sim.store,
    getTape: (sessionId: string, opts?: { limit?: number; sinceSeq?: number }) => {
      tapeReads++;
      return sim.store.getTape(sessionId, opts);
    },
  } as SessionStore;
  const second = await syncSearchIndex(spy, sim.lease);
  assert.equal(second.servable, false);
  assert.equal(tapeReads, 0, "the memoized unservable session is never re-read");
  const other = await simSession("dm:search-index-memo-other");
  await tapeOnlyTurn(other, { input: "unrelated question", reply: "unrelated answer" }, 0);
  const otherSync = await syncSearchIndex(other.store, other.lease);
  assert.ok(otherSync.servable, "the memo is per session, not global");
});

test("a settled session's turn-end sync reads a bounded tape suffix, not the whole tape", async () => {
  const sim = await simSession();
  let base = 0;
  for (let i = 0; i < 100; i++) base = await tapeOnlyTurn(sim, { input: `question ${i}`, reply: `answer ${i}` }, base);
  await syncSearchIndex(sim.store, sim.lease);
  base = await tapeOnlyTurn(sim, { input: "one more question", reply: "one more answer" }, base);
  const calls: Array<{ limit?: number } | undefined> = [];
  const spy = {
    ...sim.store,
    getTape: (sessionId: string, opts?: { limit?: number; sinceSeq?: number }) => {
      calls.push(opts);
      return sim.store.getTape(sessionId, opts);
    },
  } as SessionStore;
  const sync = await syncSearchIndex(spy, sim.lease);
  assert.ok(sync.servable);
  assert.equal(sync.indexed, 2);
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every((c) => c?.limit !== undefined),
    "the settled hot path never reads the tape unbounded",
  );
  assert.equal((await sim.store.searchEntries(VIEWER, "one more question")).length, 1);
});
