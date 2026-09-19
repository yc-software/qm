import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { isolatedPostgres } from "./support/isolated-postgres.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { ScopeId } from "../src/types.ts";
import { RUN_WORKFLOW_MIGRATION } from "../src/runs/postgres-run-workflows.ts";
import { claimsSpent } from "../src/runs/run-store.ts";
import { createWorker, processRun } from "../src/runs/worker.ts";
import { createHandoff } from "../src/runs/handoff.ts";
import { createAgentTools } from "../src/harness/agent-tools.ts";
import type { Orchestrator } from "../src/core/orchestrator.ts";
import { sleep, withTimeout } from "../src/util/async.ts";

const skip = !process.env.DATABASE_URL;
const request: OrchestratorInput = {
  actor: { id: "test-owner", type: "internal" },
  conversation: { kind: "dm", threadRef: "ordered", audience: [] },
  origin: { kind: "direct" },
  text: "hello",
};

test(
  "deployment hands off a domain claim before its delayed acknowledgement and restarts the worker",
  { skip },
  async () => {
    const db = await isolatedPostgres();
    const runtime = createPostgresRunStore(db.url, { maxClaims: 1 });
    const sessions = createPostgresSessionStore(db.url);
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const claim = runtime.runs.claim.bind(runtime.runs);
    let intercepted = false;
    runtime.runs.claim = async (...args) => {
      const run = await claim(...args);
      if (!intercepted && run) {
        intercepted = true;
        entered.resolve(args[0]);
        await release.promise;
      }
      return run;
    };
    let effects = 0;
    const worker = createWorker({
      runs: runtime.runs,
      sessions,
      orchestrator: {
        async handleTurn() {
          effects++;
          return { status: "ok", reply: "done" };
        },
      } as unknown as Orchestrator,
      leaseTtlMs: 120000,
      pollMs: 5,
      workerId: "restartable",
    });
    try {
      const admitted = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
      worker.start();
      const retiring = await withTimeout(() => entered.promise, 2000, "domain claim committed");
      worker.requestHandoff(20);
      await withTimeout(() => worker.drained(), 1000, "domain claim deadline");
      const pending = await runtime.runs.get(admitted.id);
      assert.equal(pending?.status, "pending");
      assert.equal(pending?.handoffs, 1);
      assert.equal(pending?.errorAttempts, 0);
      assert.equal(await runtime.runs.claim(retiring, 120000), null);
      worker.start();
      const completed = await withTimeout(() => runtime.runs.waitFor(admitted.id), 2000, "same worker resumed");
      assert.equal(completed.status, "done");
      assert.equal(completed.attempts, 2);
      assert.equal(claimsSpent(completed), 1);
      assert.equal(effects, 1);
      release.resolve();
      await worker.stop();
      assert.deepEqual((await db.admin.query("SELECT state,attempt FROM absurd.r_qm_runs ORDER BY run_id")).rows, [
        { state: "failed", attempt: 1 },
        { state: "completed", attempt: 1 },
      ]);
    } finally {
      release.resolve();
      await worker.stop();
      await runtime.close();
      await db.cleanup();
    }
  },
);

test("deployment fences a native domain claim before the run projection was updated", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url, { maxClaims: 1 });
  try {
    const admitted = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    const native = await db.admin.query("SELECT * FROM qm_claim_tasks('qm_runs','unacknowledged',120,1)");
    assert.equal(native.rows.length, 1);
    await runtime.runs.handoffWorker("unacknowledged");
    assert.equal(await runtime.runs.claim("unacknowledged", 120000), null);
    const successor = await runtime.runs.claim("incoming", 120000);
    assert.equal(successor?.id, admitted.id);
    assert.equal(successor?.attempts, 1);
    assert.equal(successor?.handoffs, 0);
    assert.equal(successor?.errorAttempts, 0);
  } finally {
    await runtime.close();
    await db.cleanup();
  }
});

test("deployment surrenders unacknowledged domain claims before a long grace expires", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url, { maxClaims: 1 });
  const sessions = createPostgresSessionStore(db.url);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const claim = runtime.runs.claim.bind(runtime.runs);
  runtime.runs.claim = async (...args) => {
    const run = await claim(...args);
    if (run) {
      entered.resolve();
      await release.promise;
    }
    return run;
  };
  const worker = createWorker({
    runs: runtime.runs,
    sessions,
    orchestrator: {
      async handleTurn() {
        assert.fail("unacknowledged claim executed");
      },
    } as unknown as Orchestrator,
    leaseTtlMs: 1000,
    pollMs: 5,
  });
  try {
    const admitted = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    worker.start();
    await withTimeout(() => entered.promise, 2000, "domain claim committed");
    worker.requestHandoff(120000);
    const successor = await withTimeout(
      async () => {
        for (;;) {
          const next = await claim("incoming", 120000);
          if (next) return next;
          await sleep(5);
        }
      },
      1000,
      "domain successor starts before grace",
    );
    assert.equal(successor.id, admitted.id);
    assert.equal(successor.handoffs, 1);
    assert.equal(claimsSpent(successor), 1);
    assert.equal(successor.errorAttempts, 0);
    release.resolve();
    await withTimeout(() => worker.drained(), 1000, "late claim reply fenced");
    assert.equal((await runtime.runs.get(admitted.id))?.leaseToken, successor.leaseToken);
  } finally {
    release.resolve();
    worker.requestHandoff(0);
    await worker.stop();
    await runtime.close();
    await db.cleanup();
  }
});

for (const phase of ["preflight", "cleanup"] as const) {
  test(`a deploy deadline fences ${phase} that ignores cancellation`, { skip, timeout: 10000 }, async () => {
    const db = await isolatedPostgres();
    const runtime = createPostgresRunStore(db.url);
    const sessions = createPostgresSessionStore(db.url);
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    try {
      const session = await sessions.getOrCreateByThread("ordered", "dm", "personal:test-owner");
      const admitted = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
      const claimed = await runtime.runs.claim("retiring", 60000);
      assert.ok(claimed?.leaseToken);
      const orchestrator = {
        async handleTurn(input: OrchestratorInput) {
          const owner = { runId: claimed.id, runLeaseToken: claimed.leaseToken! };
          const oldLease = phase === "cleanup" ? (await sessions.acquireLease(session.id, "turn", owner)).lease : null;
          entered.resolve();
          await unblock.promise;
          try {
            assert.equal(input.cancel?.aborted, true);
            if (oldLease)
              await assert.rejects(
                sessions.append(oldLease, {
                  type: "system",
                  payload: { late: true },
                  scopeLabel: "personal:test-owner",
                }),
              );
            else await assert.rejects(sessions.acquireLease(session.id, "turn", owner), /inactive run/);
            const tool = createAgentTools({
              current: null,
              abortSignal: input.cancel,
              handoffDeadline: input.handoffDeadline,
            }).find((tool) => tool.name === "write")!;
            await assert.rejects(
              (tool.execute as (id: string, params: unknown) => Promise<unknown>)("late", {
                path: "late.txt",
                content: "late",
              }),
              { name: "AbortError" },
            );
            checked.resolve();
          } catch (error) {
            checked.reject(error);
          }
          return { status: "ok", reply: "late completion" } as const;
        },
      } as Orchestrator;
      const handoff = createHandoff();
      const active = processRun({ runs: runtime.runs, orchestrator, leaseTtlMs: 60000, sessions }, claimed, {
        handoff: handoff.signals(),
      });
      await entered.promise;
      const rejected = assert.rejects(active, { name: "TurnHandedOff" });
      handoff.request(0);
      await rejected;
      const incoming = await runtime.runs.claim("incoming", 60000);
      assert.ok(incoming?.leaseToken);
      assert.notEqual(incoming.leaseToken, claimed.leaseToken);
      const newLease = await sessions.acquireLease(session.id, "turn", {
        runId: incoming.id,
        runLeaseToken: incoming.leaseToken,
      });
      assert.ok(newLease.lease);
      unblock.resolve();
      await checked.promise;
      assert.equal((await runtime.runs.get(admitted.id))?.leaseToken, incoming.leaseToken);
      assert.equal((await runtime.runs.get(admitted.id))?.handoffs, 1);
    } finally {
      unblock.resolve();
      await runtime.close();
      await db.cleanup();
    }
  });
}

test(
  "deploy handoffs preserve native retry budget while fencing every old run and session owner",
  { skip },
  async () => {
    const db = await isolatedPostgres();
    const runtime = createPostgresRunStore(db.url, { maxClaims: 2 });
    const sessions = createPostgresSessionStore(db.url);
    try {
      const session = await sessions.getOrCreateByThread("ordered", "dm", "personal:test-owner");
      const run = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
      const task = (await db.admin.query("SELECT workflow_task_id FROM runs WHERE id=$1", [run.id])).rows[0]
        .workflow_task_id;
      const oldTokens: string[] = [];
      for (let segment = 1; segment <= 5; segment++) {
        const claimed = await runtime.runs.claim(`worker-${segment}`, 60000);
        assert.ok(claimed?.leaseToken);
        assert.equal(claimed.attempts, segment);
        assert.equal(claimsSpent(claimed), 1);
        const { lease } = await sessions.acquireLease(session.id, "turn", {
          runId: run.id,
          runLeaseToken: claimed.leaseToken,
        });
        assert.ok(lease);
        await sessions.append(lease, { type: "system", payload: { segment }, scopeLabel: "personal:test-owner" });
        await db.admin.query("SELECT absurd.set_task_checkpoint_state('qm_runs',$1,$2,$3,$4)", [
          task,
          `segment:${segment}`,
          JSON.stringify(segment),
          claimed.leaseToken,
        ]);
        for (const old of oldTokens) {
          assert.equal(await runtime.runs.heartbeat(run.id, old, 60000), false);
          assert.equal(await runtime.runs.complete(run.id, old, { status: "ok", reply: "stale" }), false);
          await assert.rejects(
            db.admin.query("SELECT absurd.set_task_checkpoint_state('qm_runs',$1,'late','true'::jsonb,$2)", [
              task,
              old,
            ]),
            { code: "AB002" },
          );
        }
        assert.equal(await runtime.runs.releaseLease(run.id, claimed.leaseToken, { handoff: true }), true);
        assert.equal(await runtime.runs.releaseLease(run.id, claimed.leaseToken, { handoff: true }), false);
        await assert.rejects(
          sessions.append(lease, { type: "system", payload: { stale: true }, scopeLabel: "personal:test-owner" }),
        );
        const released = await runtime.runs.get(run.id);
        assert.equal(released?.status, "pending");
        assert.equal(released?.handoffs, segment);
        assert.equal(released?.errorAttempts, 0);
        oldTokens.push(claimed.leaseToken);
      }
      assert.equal(
        (await db.admin.query("SELECT attempts FROM absurd.t_qm_runs WHERE task_id=$1", [task])).rows[0].attempts,
        1,
      );
      assert.equal(
        (await db.admin.query("SELECT count(*) FROM absurd.c_qm_runs WHERE task_id=$1", [task])).rows[0].count,
        "5",
      );
      assert.equal((await db.admin.query("SELECT count(*) FROM absurd.t_qm_handoffs")).rows[0].count, "0");
      const current = await runtime.runs.claim("incoming", 60000);
      assert.ok(current?.leaseToken);
      assert.deepEqual(await runtime.runs.fail(run.id, current.leaseToken, "real failure", { retryAfterMs: 0 }), {
        requeued: true,
      });
      const retry = await runtime.runs.claim("real-retry", 60000);
      assert.ok(retry?.leaseToken);
      assert.equal(claimsSpent(retry), 2);
      assert.deepEqual(await runtime.runs.fail(run.id, retry.leaseToken, "last real failure"), { requeued: false });
      assert.equal((await runtime.runs.get(run.id))?.status, "failed");
    } finally {
      await runtime.close();
      await db.cleanup();
    }
  },
);

test("Absurd run admission and terminal handoff commit together", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url);
  try {
    const copies = await Promise.all(
      Array.from({ length: 8 }, () =>
        runtime.runs.enqueue({ sessionId: "ordered", request, dedupKey: "same-message" }),
      ),
    );
    assert.equal(copies.filter((r) => !r.deduped).length, 1);
    assert.equal(new Set(copies.map((r) => r.run.id)).size, 1);
    assert.equal((await db.admin.query("SELECT count(*) FROM absurd.t_qm_runs")).rows[0].count, "1");
    const run = await runtime.runs.claim("worker", 60000);
    assert.ok(run?.leaseToken);
    await runtime.runs.complete(run.id, run.leaseToken, { status: "ok", reply: "finished" });
    assert.equal((await runtime.runs.get(run.id))?.status, "done");
    const terminal = await db.admin.query("SELECT task_name,params FROM absurd.t_qm_handoffs");
    assert.deepEqual(terminal.rows, [{ task_name: "run.terminal", params: { runId: run.id } }]);
    assert.equal(await runtime.runs.complete(run.id, run.leaseToken, { status: "ok", reply: "late" }), false);
    assert.equal((await db.admin.query("SELECT count(*) FROM absurd.t_qm_handoffs")).rows[0].count, "1");
  } finally {
    await runtime.close();
    await db.cleanup();
  }
});

test("Absurd spawn failure rolls back run admission", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url);
  try {
    await runtime.runs.list();
    await db.admin.query(
      "ALTER TABLE absurd.t_qm_runs ADD CONSTRAINT refuse_run_spawn CHECK (task_name <> 'run.execute')",
    );
    await assert.rejects(runtime.runs.enqueue({ sessionId: "ordered", request, dedupKey: "rollback" }));
    assert.equal(await runtime.runs.getByDedupKey("rollback"), null);
    assert.equal((await runtime.runs.list()).length, 0);
  } finally {
    await runtime.close();
    await db.cleanup();
  }
});

test("Absurd preserves session FIFO through retry and worker restart", { skip }, async () => {
  const db = await isolatedPostgres();
  let runtime = createPostgresRunStore(db.url);
  try {
    const first = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    const second = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    const unrelated = (await runtime.runs.enqueue({ sessionId: "unrelated", request })).run;
    const claimed = await runtime.runs.claim("first", 60000);
    assert.equal(claimed?.id, first.id);
    await runtime.runs.fail(first.id, claimed!.leaseToken!, "transient", { retryAfterMs: 60000 });
    assert.equal((await runtime.runs.claim("other", 60000))?.id, unrelated.id);
    assert.equal(await runtime.runs.claimById(second.id, "blocked", 60000), null);
    assert.equal((await runtime.runs.get(second.id))?.attempts, 0);
    const waiting = await db.admin.query("SELECT count(*) FROM absurd.w_qm_runs WHERE event_name=$1", [
      `run-terminal:${first.id}`,
    ]);
    assert.equal(waiting.rows[0].count, "1");
    await runtime.close();
    runtime = createPostgresRunStore(db.url);
    await db.admin.query(
      "UPDATE absurd.r_qm_runs SET available_at=absurd.current_time() WHERE task_id=(SELECT workflow_task_id FROM runs WHERE id=$1) AND state IN ('pending','sleeping')",
      [first.id],
    );
    const retry = await runtime.runs.claimById(first.id, "retry", 60000);
    assert.equal(retry?.attempts, 2);
    assert.equal(retry?.errorAttempts, 1);
    await runtime.runs.complete(first.id, retry!.leaseToken!, { status: "ok", reply: "first" });
    const next = await runtime.runs.claimById(second.id, "next", 60000);
    assert.equal(next?.id, second.id);
    assert.equal(next?.attempts, 1);
  } finally {
    await runtime.close();
    await db.cleanup();
  }
});

test("Absurd expiry fences stale attempts and only releases their session lease", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url, { maxClaims: 2 });
  const sessions = createPostgresSessionStore(db.url);
  try {
    const session = await sessions.getOrCreateByThread("ordered", "dm", "personal:test-owner" as ScopeId);
    const item = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    const first = await runtime.runs.claimById(item.id, "dead", 60000);
    assert.ok(first?.leaseToken);
    const held = await sessions.acquireLease(session.id, "turn", { runId: item.id, runLeaseToken: first.leaseToken });
    assert.ok(held.lease);
    await db.admin.query(
      "UPDATE absurd.r_qm_runs SET claim_expires_at=absurd.current_time()-interval '1 second' WHERE run_id=$1",
      [first.leaseToken],
    );
    assert.equal(await runtime.runs.heartbeat(item.id, first.leaseToken, 60000), false);
    assert.equal(await runtime.runs.complete(item.id, first.leaseToken, { status: "ok", reply: "expired" }), false);
    assert.equal(await runtime.runs.claim("recover", 60000), null);
    assert.equal(await sessions.renewLease(held.lease), false);
    assert.equal(await runtime.runs.heartbeat(item.id, first.leaseToken, 60000), false);
    assert.equal(await runtime.runs.complete(item.id, first.leaseToken, { status: "ok", reply: "stale" }), false);
    await assert.rejects(
      sessions.acquireLease(session.id, "turn", { runId: item.id, runLeaseToken: first.leaseToken }),
      /inactive run/,
    );
    const competing = await sessions.acquireLease(session.id, "compaction");
    assert.ok(competing.lease);
    await db.admin.query(
      "UPDATE absurd.r_qm_runs SET available_at=absurd.current_time() WHERE task_id=(SELECT workflow_task_id FROM runs WHERE id=$1) AND state IN ('pending','sleeping')",
      [item.id],
    );
    const retry = await runtime.runs.claimById(item.id, "retry", 60000);
    assert.equal(retry?.attempts, 2);
    assert.equal(retry?.errorAttempts, 0);
    await db.admin.query(
      "UPDATE absurd.r_qm_runs SET claim_expires_at=absurd.current_time()-interval '1 second' WHERE run_id=$1",
      [retry!.leaseToken],
    );
    await runtime.runs.claim("exhausted", 60000);
    assert.equal((await runtime.runs.get(item.id))?.status, "failed");
    assert.equal(await sessions.renewLease(competing.lease), true);
    assert.equal(
      (await db.admin.query("SELECT count(*) FROM absurd.t_qm_handoffs WHERE params->>'runId'=$1", [item.id])).rows[0]
        .count,
      "1",
    );
  } finally {
    await runtime.close();
    await db.cleanup();
  }
});

test("withdrawing a suspended run releases its successor without creating a delivery", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url);
  try {
    const first = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    const middle = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    const last = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    const claimed = await runtime.runs.claimById(first.id, "first", 60000);
    assert.equal(await runtime.runs.claimById(middle.id, "middle", 60000), null);
    assert.equal(await runtime.runs.claimById(last.id, "last", 60000), null);
    assert.equal(await runtime.runs.withdraw(middle.id), true);
    assert.equal(await runtime.runs.get(middle.id), null);
    assert.equal((await db.admin.query("SELECT count(*) FROM absurd.t_qm_handoffs")).rows[0].count, "0");
    assert.equal(
      (
        await db.admin.query("SELECT count(*) FROM absurd.e_qm_handoffs WHERE event_name=$1", [
          `run-terminal:${middle.id}`,
        ])
      ).rows[0].count,
      "1",
    );
    await runtime.runs.complete(first.id, claimed!.leaseToken!, { status: "ok", reply: "first" });
    const final = await runtime.runs.claimById(last.id, "last", 60000);
    assert.equal(final?.id, last.id);
    assert.equal(final?.attempts, 1);
  } finally {
    await runtime.close();
    await db.cleanup();
  }
});

test("run signals commit replay obligations before and after run completion", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url);
  const signals = createPostgresRunSignalStore(db.url);
  try {
    const run = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    assert.equal(await signals.send(run.id, { kind: "steer", text: "one", dedupeKey: "signal-1" }), true);
    assert.equal(await signals.send(run.id, { kind: "steer", text: "duplicate", dedupeKey: "signal-1" }), false);
    const claim = await runtime.runs.claimById(run.id, "worker", 60000);
    await runtime.runs.complete(run.id, claim!.leaseToken!, { status: "ok", reply: "done" });
    await signals.send(run.id, { kind: "steer", text: "late", dedupeKey: "signal-2" });
    const replay = await db.admin.query("SELECT params FROM absurd.t_qm_handoffs WHERE task_name='signal.replay'");
    assert.deepEqual(replay.rows, [{ params: { runId: run.id } }, { params: { runId: run.id } }]);
    const event = await db.admin.query("SELECT payload FROM absurd.e_qm_handoffs WHERE event_name=$1", [
      `run-terminal:${run.id}`,
    ]);
    assert.equal(event.rowCount, 1);
    assert.equal((await signals.pending(run.id)).length, 2);
  } finally {
    await signals.close?.();
    await runtime.close();
    await db.cleanup();
  }
});

test("terminal and signal handoffs back off repeated failures", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url);
  const signals = createPostgresRunSignalStore(db.url);
  try {
    const run = (await runtime.runs.enqueue({ sessionId: "ordered", request })).run;
    await signals.send(run.id, { kind: "steer", text: "one", dedupeKey: "retry-signal" });
    const claim = await runtime.runs.claimById(run.id, "worker", 60000);
    await runtime.runs.complete(run.id, claim!.leaseToken!, { status: "ok", reply: "done" });
    const handoffs = await db.admin.query("SELECT * FROM absurd.claim_task('qm_handoffs','worker',60,100)");
    assert.deepEqual(handoffs.rows.map((row) => row.task_name).sort(), ["run.terminal", "signal.replay"]);
    for (const handoff of handoffs.rows) {
      await db.admin.query("SELECT absurd.fail_run('qm_handoffs',$1,$2)", [
        handoff.run_id,
        JSON.stringify({ name: "Unavailable", message: "temporary outage" }),
      ]);
    }
    assert.equal((await db.admin.query("SELECT * FROM absurd.claim_task('qm_handoffs','retry',60,100)")).rowCount, 0);
    const delayed = await db.admin.query(
      "SELECT extract(epoch FROM (available_at-created_at))::float AS delay FROM absurd.r_qm_handoffs WHERE state='sleeping'",
    );
    assert.equal(delayed.rowCount, 2);
    assert.ok(delayed.rows.every((row) => row.delay > 0.5 && row.delay <= 1));
  } finally {
    await signals.close?.();
    await runtime.close();
    await db.cleanup();
  }
});

test("the migration adopts legacy work and preserves pending child returns", { skip }, async () => {
  const db = await isolatedPostgres();
  const runtime = createPostgresRunStore(db.url);
  const sessions = createPostgresSessionStore(db.url);
  try {
    await runtime.runs.list();
    const session = await sessions.getOrCreateByThread("ordered", "dm", "personal:test-owner" as ScopeId);
    const legacy = await sessions.acquireLease(session.id, "turn");
    assert.ok(legacy.lease);
    await db.admin.query(
      `INSERT INTO runs(id,session_id,status,request,created_at,attempts,lease_token,lease_expires_at)
       VALUES ('legacy-running','ordered','running',$1,1,2,'old-token',9999999999999),
              ('legacy-pending','other','pending',$1,2,0,NULL,NULL),
              ('legacy-child','agent:main:subagent:child','done',$1,3,1,NULL,NULL)`,
      [JSON.stringify(request)],
    );
    const client = await db.admin.connect();
    try {
      await client.query("BEGIN");
      for (const statement of RUN_WORKFLOW_MIGRATION.statements) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    assert.equal(await sessions.renewLease(legacy.lease), false);
    assert.equal((await runtime.runs.get("legacy-running"))?.status, "pending");
    assert.equal((await db.admin.query("SELECT count(*) FROM absurd.t_qm_runs")).rows[0].count, "2");
    assert.deepEqual((await db.admin.query("SELECT params FROM absurd.t_qm_handoffs")).rows, [
      { params: { runId: "legacy-child" } },
    ]);
    await assert.rejects(
      db.admin.query("UPDATE runs SET status='running',lease_token='old-worker' WHERE id='legacy-running'"),
      /active durable workflow attempt/,
    );
    const claimed = await runtime.runs.claimById("legacy-running", "new-worker", 60000);
    assert.equal(claimed?.attempts, 3);
  } finally {
    await runtime.close();
    await db.cleanup();
  }
});
