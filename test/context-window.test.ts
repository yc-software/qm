import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { contextSummaryItem, type SessionStore } from "../src/sessions/session-store.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import { scopeId } from "../src/types.ts";
import type { NewItem } from "../src/sessions/items.ts";

const URL = process.env.DATABASE_URL;
const pgSkip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres context-window tests";

async function seed(store: SessionStore, threadRef: string) {
  const scope = scopeId("channel", "C1");
  const s = await store.getOrCreateByThread(threadRef, "channel", scope);
  const { lease } = await store.acquireLease(s.id);
  const add = (item: NewItem) => store.append(lease!, item);
  await add({ kind: "UserMessage", text: "ancient one" });
  await add({ kind: "UserMessage", text: "ancient two" });
  await add(contextSummaryItem(0, "stale summary"));
  await add({ kind: "UserMessage", text: "middle" });
  const fresh = await add(contextSummaryItem(3, "fresh summary"));
  await add({ kind: "UserMessage", text: "recent one" });
  await add({ kind: "AgentMessage", text: "recent two" });
  await store.releaseLease(lease!);
  return { session: s, freshSummarySeq: fresh.seq };
}

async function exerciseWindow(store: SessionStore, threadRef: string) {
  const { session, freshSummarySeq } = await seed(store, threadRef);
  const window = await store.getContextWindow(session.id);

  assert.equal(window.totalItems, 7, "full count preserved for guards");
  assert.deepEqual(
    window.items.map((e) => e.seq),
    [freshSummarySeq, freshSummarySeq + 1, freshSummarySeq + 2],
    "window = latest summary + everything after its throughSeq",
  );

  const full = await store.getItems(session.id);
  assert.deepEqual(
    forModelContext(window.items),
    forModelContext(full),
    "model context built from the window is identical to one built from the full history",
  );

  const untouched = await store.getOrCreateByThread(`${threadRef}-empty`, "channel", scopeId("channel", "C1"));
  const empty = await store.getContextWindow(untouched.id);
  assert.deepEqual(empty, { items: [], totalItems: 0 });
}

test("memory store: context window slices at the latest summary and keeps guards whole-history", async () => {
  await exerciseWindow(createMemorySessionStore(), "ch:C1:mem");
});

test("memory store: sessions without a summary return the full history", async () => {
  const store = createMemorySessionStore();
  const scope = scopeId("channel", "C1");
  const s = await store.getOrCreateByThread("ch:C1:nosummary", "channel", scope);
  const { lease } = await store.acquireLease(s.id);
  await store.append(lease!, { kind: "UserMessage", text: "a" });
  await store.append(lease!, { kind: "AgentMessage", text: "b" });
  const window = await store.getContextWindow(s.id);
  assert.equal(window.items.length, 2);
  assert.equal(window.totalItems, 2);
});

test(
  "postgres store: context window slices at the latest summary and keeps guards whole-history",
  { skip: pgSkip },
  async () => {
    const store = createPostgresSessionStore(URL!);
    await exerciseWindow(store, `ch:C1:pg-${Date.now()}`);
  },
);

test(
  "postgres store: a payload merely mentioning context_summary text is not treated as a summary",
  { skip: pgSkip },
  async () => {
    const store = createPostgresSessionStore(URL!);
    const scope = scopeId("channel", "C1");
    const s = await store.getOrCreateByThread(`ch:C1:pg-decoy-${Date.now()}`, "channel", scope);
    const { lease } = await store.acquireLease(s.id);
    await store.append(lease!, { kind: "UserMessage", text: "first" });
    await store.append(lease!, {
      kind: "ContextCompaction",
      body: { note: "shape is wrong: no throughSeq/text" },
    });
    await store.append(lease!, {
      kind: "UserMessage",
      text: 'quoting "kind":"ContextCompaction" in chat',
    });
    const window = await store.getContextWindow(s.id);
    assert.equal(window.items.length, 3, "decoys fall back to the full history, never a wrong slice");
    assert.equal(window.totalItems, 3);
  },
);
