import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { searchRowsFromEntries } from "../src/harness/tape-projection.ts";
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
