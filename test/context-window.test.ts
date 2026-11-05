import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { forModelContext } from "../src/agent/context-compaction.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const URL = process.env.DATABASE_URL;
const pgSkip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres context-window tests";

async function seed(store: SessionStore, threadRef: string) {
  const scope = scopeId("channel", "C1");
  const s = await store.getOrCreateByThread(threadRef, "channel", scope);
  const writer = { sessionId: s.id };
  const add = (kind: "UserMessage" | "AgentMessage", text: string) => store.append(writer, { kind, text });
  await add("UserMessage", "ancient one");
  await add("UserMessage", "ancient two");
  await store.append(writer, { kind: "ContextCompaction", throughSeq: 0, text: "stale summary" });
  await add("UserMessage", "middle");
  const fresh = await store.append(writer, { kind: "ContextCompaction", throughSeq: 3, text: "fresh summary" });
  await add("UserMessage", "recent one");
  await add("AgentMessage", "recent two");
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

test("session store: context window slices at the latest summary and keeps guards whole-history", async () => {
  await exerciseWindow(createPostgresSessionStore(testDatabaseUrl()), "ch:C1:mem");
});

test("session store: sessions without a summary return the full history", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("channel", "C1");
  const s = await store.getOrCreateByThread("ch:C1:nosummary", "channel", scope);
  const writer = { sessionId: s.id };
  await store.append(writer, { kind: "UserMessage", text: "a" });
  await store.append(writer, { kind: "AgentMessage", text: "b" });
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
    const writer = { sessionId: s.id };
    await store.append(writer, { kind: "UserMessage", text: "first" });
    await store.append(writer, { kind: "ContextCompaction", body: { note: "shape is wrong: no throughSeq/text" } });
    await store.append(writer, { kind: "UserMessage", text: 'quoting "kind":"context_summary" in chat' });
    const window = await store.getContextWindow(s.id);
    assert.equal(window.items.length, 3, "decoys fall back to the full history, never a wrong slice");
    assert.equal(window.totalItems, 3);
  },
);
