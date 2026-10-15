import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { searchRowsFromEntries } from "../src/sessions/entry-search.ts";
import type { Lease, SessionStore } from "../src/sessions/session-store.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";

const scope = "personal:viewer@example.com" as ScopeId;
const VIEWER = "viewer";
const TOOL_SECRET = "brokered-credential-XJQ99";
const THINKING_SECRET = "private-deliberation-KLM42";

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
  turn: { input: string; author?: string; reply: string; toolResult?: string; thinking?: string },
): Promise<void> {
  const emit = (type: SessionEntry["type"], payload: unknown) =>
    sim.store.append(sim.lease, { type, payload, scopeLabel: scope });
  await emit("user", { text: turn.input, ...(turn.author ? { name: turn.author } : {}) });
  if (turn.thinking) await emit("thinking", { thinking: turn.thinking });
  if (turn.toolResult) {
    await emit("tool_call", { command: "fetch", tool: "execute", callId: "call_1" });
    await emit("tool_result", { tool: "execute", callId: "call_1", isError: false, result: turn.toolResult });
  }
  await emit("assistant", { text: turn.reply });
}

async function secretTurn(sim: Sim): Promise<void> {
  await simTurn(sim, {
    input: "please check the deploy status",
    author: "Alex",
    reply: "The deploy finished cleanly.",
    toolResult: `credential response: ${TOOL_SECRET}`,
    thinking: `weighing options ${THINKING_SECRET}`,
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

test("messages are searchable as soon as they are appended", async () => {
  const sim = await simSession();
  await sim.store.append(sim.lease, { type: "user", payload: { text: "legacy document" }, scopeLabel: scope });
  assert.equal((await sim.store.searchEntries(VIEWER, "legacy document")).length, 1);
  assert.equal(await sim.store.missingSearchEntries(sim.session.id), 0);
});

test("tenure windows filter search hits", async () => {
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
