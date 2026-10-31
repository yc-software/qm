import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { claimTurn, finishTurn, testRunStore, type TestRunStore } from "./support/turns.ts";
import { turnLedgerAt } from "./support/absurd-clock.ts";

const request: OrchestratorInput = {
  actor: { id: "retry-test", type: "internal" },
  conversation: { kind: "dm", threadRef: "retry-test", audience: [] },
  origin: { kind: "direct" },
  text: "test",
};

test("retry deadline survives a restart, holds the conversation's queue, and frees other work", async () => {
  let store: TestRunStore = testRunStore();
  const databaseUrl = store.databaseUrl;
  const sessionId = randomUUID();
  try {
    const first = (await store.runs.enqueue({ sessionId, request })).run;
    const now = Date.now();
    const failing = turnLedgerAt(databaseUrl, now);
    try {
      const lease = (await claimTurn(failing, first.id))!;
      assert.equal(
        await failing.retry(lease.run, lease.token, { kind: "error", code: "transient", status: 503 }),
        true,
      );
    } finally {
      await failing.close();
    }
    await store.close();
    store = testRunStore(databaseUrl);
    const { runs, ledger } = store;
    const later = (await runs.enqueue({ sessionId, request })).run;
    const other = (await runs.enqueue({ sessionId: randomUUID(), request })).run;
    assert.equal(later.status, "queued", "a newer turn waits behind the retrying one");
    assert.equal(later.absurdTaskId, null, "and has no task a worker could claim");

    const unrelated = await claimTurn(ledger);
    assert.equal(unrelated?.run.id, other.id, "only the unrelated conversation is claimable");
    await finishTurn(unrelated!, { status: "ok", sessionId: other.sessionId });

    const early = turnLedgerAt(databaseUrl, now + 14_999);
    try {
      assert.equal(await claimTurn(early), null, "not claimable a millisecond before the deadline");
    } finally {
      await early.close();
    }
    const due = turnLedgerAt(databaseUrl, now + 15_000);
    try {
      const retried = await claimTurn(due);
      assert.equal(retried?.run.id, first.id, "the retry resumes before the newer turn");
      assert.equal(retried?.run.attempts, 2);
      assert.equal(retried?.run.errorAttempts, 1);
      assert.deepEqual(retried?.run.lastStop, { kind: "error", code: "transient", status: 503 });
      assert.equal(await claimTurn(due), null, "the newer turn still waits while the retry runs");
      await finishTurn(retried!, { status: "ok", sessionId });
      const next = await claimTurn(due);
      assert.equal(next?.run.id, later.id, "then the conversation's queue moves on in order");
      await finishTurn(next!, { status: "ok", sessionId });
    } finally {
      await due.close();
    }
  } finally {
    await store.close();
  }
});

test("failed returns wait durably without delaying new work or acknowledging results", async (t) => {
  let store: TestRunStore = testRunStore();
  const databaseUrl = store.databaseUrl;
  try {
    const child = (await store.runs.enqueue({ sessionId: `agent:main:subagent:${randomUUID()}`, request })).run;
    await store.runs.deferReturn(child.id, 60_000);
    await finishTurn((await claimTurn(store.ledger, child.id))!, { status: "ok", reply: "saved result" });
    const completed = await store.runs.get(child.id);
    const wake = (
      await store.runs.enqueue({ sessionId: randomUUID(), request, dedupKey: `subagent-return:${child.id}` })
    ).run;
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await store.runs.deferReturn(child.id, 60_000);
    await store.close();
    store = testRunStore(databaseUrl);
    const { runs, ledger } = store;
    assert.deepEqual(await runs.pendingReturns(), []);
    assert.deepEqual(await runs.get(child.id), completed, "deferring a return does not touch the result");
    const fresh = (await runs.enqueue({ sessionId: `agent:main:subagent:${randomUUID()}`, request })).run;
    await finishTurn((await claimTurn(ledger, fresh.id))!, { status: "failed", reason: "failed task" }, "failed");
    assert.deepEqual(
      (await runs.pendingReturns()).map((run) => run.id),
      [fresh.id],
    );
    await runs.deferReturn(fresh.id, 60_000);
    t.mock.timers.tick(59_999);
    assert.deepEqual(await runs.pendingReturns(), []);
    t.mock.timers.tick(1);
    assert.equal((await runs.pendingReturns()).length, 2);
    await runs.markReturned(child.id);
    await runs.deferReturn(child.id, 60_000);
    assert.ok(!(await runs.pendingReturns()).some((run) => run.id === child.id));
    t.mock.timers.tick(60_000);
    assert.ok((await runs.pendingReturns()).some((run) => run.id === child.id));
    await runs.withdraw(wake.id, { unstartedOnly: true });
    assert.deepEqual(
      (await runs.pendingReturns()).map((run) => run.id),
      [fresh.id],
    );
  } finally {
    t.mock.timers.reset();
    await store.close();
  }
});

test("latest session history uses its ordered index and excludes private messages", async () => {
  const { runs, databaseUrl, close } = testRunStore();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const sessionId = randomUUID();
    const publicRun = (await runs.enqueue({ sessionId, request })).run;
    const privateRun = (await runs.enqueue({ sessionId, request: { ...request, privateSessionMessage: true } })).run;
    await pool.query("UPDATE runs SET created_at = 1 WHERE session_id = $1", [sessionId]);
    assert.equal((await runs.latestForThread(sessionId))?.id, privateRun.id);
    assert.equal((await runs.latestForThread(sessionId, { excludePrivateMessages: true }))?.id, publicRun.id);
    const client = await pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query(
        "EXPLAIN (FORMAT JSON) SELECT * FROM runs WHERE session_id = $1 AND COALESCE(request::jsonb->>'privateSessionMessage', 'false') <> 'true' ORDER BY created_at DESC, seq DESC LIMIT 1",
        [sessionId],
      );
      const plan = JSON.stringify(rows);
      assert.match(plan, /idx_runs_session_created_seq/);
      assert.doesNotMatch(plan, /"Node Type":"Sort"/);
      const recent = await client.query("EXPLAIN (FORMAT JSON) SELECT * FROM runs ORDER BY created_at DESC LIMIT 500");
      assert.match(JSON.stringify(recent.rows), /idx_runs_created/);
      assert.doesNotMatch(JSON.stringify(recent.rows), /"Node Type":"Sort"/);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await close();
  }
});
