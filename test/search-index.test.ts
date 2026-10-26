import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { Lease, SessionStore } from "../src/sessions/session-store.ts";
import type { ScopeId, Session } from "../src/types.ts";
import type { NewItem } from "../src/sessions/items.ts";

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
  const emit = (item: NewItem) => sim.store.append(sim.lease, item);
  await emit({ kind: "UserMessage", text: turn.input, body: turn.author ? { name: turn.author } : {} });
  if (turn.thinking) await emit({ kind: "Reasoning", text: turn.thinking });
  if (turn.toolResult) {
    await emit({ kind: "ToolCall", tool: "execute", callId: "call_1", body: { command: "fetch" } });
    await emit({ kind: "ToolResult", tool: "execute", callId: "call_1", isError: false, text: turn.toolResult });
  }
  await emit({ kind: "AgentMessage", text: turn.reply });
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
  assert.deepEqual(await sim.store.searchEntries(VIEWER, TOOL_SECRET), []);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, THINKING_SECRET), []);
  assert.deepEqual(await sim.store.searchEntries(VIEWER, "brokered credential"), []);
  const replyHits = await sim.store.searchEntries(VIEWER, "finished cleanly");
  assert.equal(replyHits.length, 1);
  assert.equal(replyHits[0]!.type, "assistant");
  const userHits = await sim.store.searchEntries(VIEWER, "deploy status");
  assert.ok(userHits.some((h) => h.type === "user" && h.author === "Alex"));
});

test("messages are searchable as soon as they are appended", async () => {
  const sim = await simSession();
  await sim.store.append(sim.lease, { kind: "UserMessage", text: "legacy document" });
  assert.equal((await sim.store.searchEntries(VIEWER, "legacy document")).length, 1);
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
