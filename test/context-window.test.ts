import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createContextSummaryPayload, type SessionStore } from "../src/sessions/session-store.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const pgSkip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres context-window tests";

async function seed(store: SessionStore, threadRef: string) {
  const scope = scopeId("channel", "C1");
  const s = await store.getOrCreateByThread(threadRef, "channel", scope);
  const { lease } = await store.acquireLease(s.id);
  const add = (type: "user" | "assistant" | "system", payload: unknown) =>
    store.append(lease!, { type, payload, scopeLabel: scope });
  await add("user", { text: "ancient one" });
  await add("user", { text: "ancient two", securityTainted: true });
  await add("system", { ...createContextSummaryPayload(0, "stale summary") });
  await add("user", { text: "middle" });
  const fresh = await add("system", { ...createContextSummaryPayload(3, "fresh summary") });
  await add("user", { text: "recent one" });
  await add("assistant", { text: "recent two" });
  await store.releaseLease(lease!);
  return { session: s, freshSummarySeq: fresh.seq };
}

async function exerciseWindow(store: SessionStore, threadRef: string) {
  const { session, freshSummarySeq } = await seed(store, threadRef);
  const window = await store.getContextWindow(session.id);

  assert.equal(window.totalEntries, 7, "full count preserved for guards");
  assert.equal(window.hasSecurityTaint, true, "taint in the discarded prefix still surfaces");
  assert.deepEqual(
    window.entries.map((e) => e.seq),
    [freshSummarySeq, freshSummarySeq + 1, freshSummarySeq + 2],
    "window = latest summary + everything after its throughSeq",
  );

  const full = await store.getEntries(session.id);
  assert.deepEqual(
    forModelContext(window.entries, { includeSecurityTainted: false }),
    forModelContext(full, { includeSecurityTainted: false }),
    "model context built from the window is identical to one built from the full history",
  );

  const untouched = await store.getOrCreateByThread(`${threadRef}-empty`, "channel", scopeId("channel", "C1"));
  const empty = await store.getContextWindow(untouched.id);
  assert.deepEqual(empty, { entries: [], totalEntries: 0, hasSecurityTaint: false });
}

test("memory store: context window slices at the latest summary and keeps guards whole-history", async () => {
  await exerciseWindow(createMemorySessionStore(), "ch:C1:mem");
});

test("memory store: sessions without a summary return the full history", async () => {
  const store = createMemorySessionStore();
  const scope = scopeId("channel", "C1");
  const s = await store.getOrCreateByThread("ch:C1:nosummary", "channel", scope);
  const { lease } = await store.acquireLease(s.id);
  await store.append(lease!, { type: "user", payload: { text: "a" }, scopeLabel: scope });
  await store.append(lease!, { type: "assistant", payload: { text: "b" }, scopeLabel: scope });
  const window = await store.getContextWindow(s.id);
  assert.equal(window.entries.length, 2);
  assert.equal(window.totalEntries, 2);
  assert.equal(window.hasSecurityTaint, false);
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
    await store.append(lease!, { type: "user", payload: { text: "first" }, scopeLabel: scope });
    await store.append(lease!, {
      type: "system",
      payload: { kind: "context_summary", note: "shape is wrong: no throughSeq/text" },
      scopeLabel: scope,
    });
    await store.append(lease!, {
      type: "user",
      payload: { text: 'quoting "kind":"context_summary" in chat' },
      scopeLabel: scope,
    });
    const window = await store.getContextWindow(s.id);
    assert.equal(window.entries.length, 3, "decoys fall back to the full history, never a wrong slice");
    assert.equal(window.totalEntries, 3);
  },
);

test(
  "postgres store: a jsonb-rewritten summary (spaced keys) is still recognized and taint still surfaces",
  { skip: pgSkip },
  async () => {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: URL });
    const store = createPostgresSessionStore(URL!);
    const scope = scopeId("channel", "C1");
    const s = await store.getOrCreateByThread(`ch:C1:pg-rewrite-${Date.now()}`, "channel", scope);
    const { lease } = await store.acquireLease(s.id);
    await store.append(lease!, { type: "user", payload: { text: "old", securityTainted: true }, scopeLabel: scope });
    const summary = await store.append(lease!, {
      type: "system",
      payload: { ...createContextSummaryPayload(0, "s"), securityTainted: true },
      scopeLabel: scope,
    });
    await store.append(lease!, { type: "user", payload: { text: "recent" }, scopeLabel: scope });
    await store.releaseLease(lease!);

    await pool.query(
      `UPDATE session_entries SET payload = ((payload::jsonb) - 'securityTainted')::text WHERE session_id = $1 AND seq = $2`,
      [s.id, summary.seq],
    );
    const rewritten = await pool.query(`SELECT payload FROM session_entries WHERE session_id = $1 AND seq = $2`, [
      s.id,
      summary.seq,
    ]);
    assert.match(rewritten.rows[0].payload, /"kind": "context_summary"/, "round-trip produced the spaced format");

    const window = await store.getContextWindow(s.id);
    assert.deepEqual(
      window.entries.map((e) => e.seq),
      [summary.seq, summary.seq + 1],
      "the spaced summary is still found, so the window stays bounded",
    );
    assert.equal(window.hasSecurityTaint, true, "taint on the pre-summary user entry still forces reset");
    await pool.end();
  },
);
