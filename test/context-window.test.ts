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

test(
  "postgres store: poisoned legacy rows never wedge the window or taint clearing, healthy rows stay intact",
  { skip: pgSkip },
  async () => {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: URL });
    const store = createPostgresSessionStore(URL!);
    const scope = scopeId("channel", "C1");
    const s = await store.getOrCreateByThread(`ch:C1:pg-nul-${Date.now()}`, "channel", scope);
    const { lease } = await store.acquireLease(s.id);
    const append = (type: "user" | "system", payload: unknown) =>
      store.append(lease!, { type, payload, scopeLabel: scope });
    const nul = await append("user", { text: "phases NUL_HERE", securityTainted: true });
    const surrogate = await append("user", { text: "cut SURROGATE_HERE", securityTainted: true });
    const scalar = await append("user", "SCALAR_HERE");
    const escaped = await append("user", { text: "replace(payload, '\\u0000', '')", securityTainted: true });
    const halfEmoji = await append("user", { text: "prefix 😀".slice(0, 8), securityTainted: true });
    const nested = await append("user", { text: "tool call", args: { securityTainted: true } });
    const summary = await append("system", createContextSummaryPayload(nested.seq, "summary SUMMARY_NUL"));
    await append("user", { text: "recent" });
    await store.releaseLease(lease!);

    const poison = async (seq: number, marker: string, raw: string) => {
      await pool.query(
        `UPDATE session_entries SET payload = replace(payload, $3, $4) WHERE session_id = $1 AND seq = $2`,
        [s.id, seq, marker, raw],
      );
      await assert.rejects(
        pool.query(`SELECT payload::jsonb FROM session_entries WHERE session_id = $1 AND seq = $2`, [s.id, seq]),
        `seq ${seq} really is a row jsonb refuses`,
      );
    };
    await poison(nul.seq, "NUL_HERE", "\\u0000CODE0\\u0000");
    await poison(surrogate.seq, "SURROGATE_HERE", "\\ud83d");
    await poison(
      summary.seq,
      "SUMMARY_NUL",
      "\\u0000\\u0000 \\ud83d\\ud83d \\ude00 \\ud83d\\ude00 \\\\u0000 \\\\ud83d\\ude00",
    );
    await pool.query(
      `UPDATE session_entries SET payload = '"quoting securityTainted"' WHERE session_id = $1 AND seq = $2`,
      [s.id, scalar.seq],
    );

    const rawPayload = async (seq: number) =>
      (await pool.query(`SELECT payload FROM session_entries WHERE session_id = $1 AND seq = $2`, [s.id, seq])).rows[0]
        .payload as string;
    const nestedBefore = await rawPayload(nested.seq);

    const window = await store.getContextWindow(s.id);
    assert.deepEqual(
      window.entries.map((e) => e.seq),
      [summary.seq, summary.seq + 1],
    );
    assert.equal(window.totalEntries, 8);
    assert.equal(window.hasSecurityTaint, true);

    assert.equal(await store.clearSecurityTaint(s.id), true);
    assert.equal((await store.getContextWindow(s.id)).hasSecurityTaint, false, "a nested key is not top-level taint");
    const after = await store.getEntries(s.id);
    assert.deepEqual(after[escaped.seq]!.payload, { text: "replace(payload, '\\u0000', '')" });
    assert.deepEqual(after[halfEmoji.seq]!.payload, { text: "prefix \uFFFD" });
    assert.equal(after[scalar.seq]!.payload, "quoting securityTainted");
    assert.equal(await rawPayload(nested.seq), nestedBefore, "a row with only a nested key is not rewritten");
    assert.equal(
      await rawPayload(escaped.seq),
      JSON.stringify({ text: "replace(payload, '\\u0000', '')" }),
      "cleared rows are written back compact, so substring probes keep matching",
    );
    for (const seq of [nul.seq, surrogate.seq, escaped.seq, halfEmoji.seq]) {
      assert.notEqual(
        (after[seq]!.payload as { securityTainted?: unknown }).securityTainted,
        true,
        `seq ${seq} cleared`,
      );
    }
    await pool.end();
  },
);

test(
  "postgres store: a poisoned row that is the only tainted one still fails closed, and still clears",
  { skip: pgSkip },
  async () => {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: URL });
    const store = createPostgresSessionStore(URL!);
    const scope = scopeId("channel", "C1");
    const s = await store.getOrCreateByThread(`ch:C1:pg-nul-only-${Date.now()}`, "channel", scope);
    const { lease } = await store.acquireLease(s.id);
    const tainted = await store.append(lease!, {
      type: "user",
      payload: { text: "overheard NUL_HERE", overheard: true, securityTainted: true },
      scopeLabel: scope,
    });
    await store.append(lease!, { type: "user", payload: { text: "recent" }, scopeLabel: scope });
    await store.releaseLease(lease!);
    await pool.query(
      `UPDATE session_entries SET payload = replace(payload, 'NUL_HERE', $3) WHERE session_id = $1 AND seq = $2`,
      [s.id, tainted.seq, "\\u0000"],
    );

    assert.equal((await store.getContextWindow(s.id)).hasSecurityTaint, true, "unparseable tainted row reads tainted");
    assert.equal(await store.clearSecurityTaint(s.id), true);
    assert.equal((await store.getContextWindow(s.id)).hasSecurityTaint, false);
    const row = (await store.getEntry(s.id, tainted.seq))!.payload as {
      text: string;
      overheard: boolean;
      securityTainted: unknown;
    };
    assert.equal(row.securityTainted, undefined, "cleared through the repaired parse");
    assert.equal(row.overheard, true);
    assert.equal(row.text, "overheard ", "the NUL escape is gone once the row has been rewritten");
    await pool.end();
  },
);

test(
  "postgres store: a tainted row that no parse can read stays tainted and makes clearing report failure",
  { skip: pgSkip },
  async () => {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: URL });
    const store = createPostgresSessionStore(URL!);
    const scope = scopeId("channel", "C1");
    const s = await store.getOrCreateByThread(`ch:C1:pg-unreadable-${Date.now()}`, "channel", scope);
    const { lease } = await store.acquireLease(s.id);
    const readable = await store.append(lease!, {
      type: "user",
      payload: { text: "also old", securityTainted: true },
      scopeLabel: scope,
    });
    const broken = await store.append(lease!, {
      type: "user",
      payload: { text: "old", securityTainted: true },
      scopeLabel: scope,
    });
    const summary = await store.append(lease!, {
      type: "system",
      payload: createContextSummaryPayload(broken.seq, "s"),
      scopeLabel: scope,
    });
    await store.append(lease!, { type: "user", payload: { text: "recent" }, scopeLabel: scope });
    await store.releaseLease(lease!);
    await pool.query(
      `UPDATE session_entries SET payload = '{"text":"old","securityTainted":true' WHERE session_id = $1 AND seq = $2`,
      [s.id, broken.seq],
    );

    const window = await store.getContextWindow(s.id);
    assert.deepEqual(
      window.entries.map((e) => e.seq),
      [summary.seq, summary.seq + 1],
    );
    assert.equal(window.hasSecurityTaint, true, "fails closed");
    await assert.rejects(
      store.clearSecurityTaint(s.id),
      new RegExp(`seq ${broken.seq}`),
      "clearing names the row it could not release",
    );
    assert.equal((await store.getContextWindow(s.id)).hasSecurityTaint, true);
    const untouched = (await store.getEntry(s.id, readable.seq))!.payload as { securityTainted?: unknown };
    assert.equal(untouched.securityTainted, true, "nothing is cleared while an unreadable tainted row remains");
    await pool.end();
  },
);

test("postgres store: a channel name carrying a NUL is stored once and never re-healed", { skip: pgSkip }, async () => {
  const store = createPostgresSessionStore(URL!);
  const scope = scopeId("channel", "C1");
  const threadRef = `ch:C1:pg-channel-name-${Date.now()}`;
  const first = await store.getOrCreateByThread(threadRef, "channel", scope, "ops\u0000room");
  const again = await store.getOrCreateByThread(threadRef, "channel", scope, "ops\u0000room");
  assert.equal(first.channelName, "opsroom");
  assert.equal(again.channelName, "opsroom");
});
