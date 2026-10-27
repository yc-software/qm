import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateRegisteredPgSchemas, registeredPgMigrations } from "../../src/persistence/pg-pool.ts";
import { CONTRACT_MIGRATIONS } from "../../src/persistence/contract-migrations.ts";
import type { Orchestrator, OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import type { Run, RunPriority } from "../../src/runs/run-store.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { registerAbsurdSchema, TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import { createPostgresNotifyBus } from "../../src/persistence/postgres-notify-bus.ts";
import {
  createTurnLedger,
  TURN_READY_CHANNEL,
  TURN_YIELD_CHANNEL,
  type TurnLedger,
} from "../../src/turns/turn-ledger.ts";
import { createTurnRunner } from "../../src/turns/turn-runner.ts";
import { scopeId, type TurnResult } from "../../src/types.ts";
import { sleep } from "../../src/util/async.ts";
import { eventually } from "../support/settle.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Absurd turn tests";

let admin: pg.Pool;
let runStore: ReturnType<typeof createPostgresRunStore>;
let sessions: ReturnType<typeof createPostgresSessionStore>;
let ledger: TurnLedger;
const terminal: Run[] = [];

function request(thread: string, text = "hello"): OrchestratorInput {
  return {
    surface: "web",
    text,
    actor: { id: "alice@example.com", externalId: "alice@example.com", displayName: "Alice" },
    conversation: { kind: "dm", threadRef: thread },
    origin: { kind: "human" },
  } as unknown as OrchestratorInput;
}

async function admit(thread: string, text = "hello", dedupKey?: string, priority: RunPriority = 0) {
  const result = await ledger.admit({
    sessionId: thread,
    request: request(thread, text),
    priority,
    ...(dedupKey ? { dedupKey } : {}),
  });
  assert.ok(result);
  return result;
}

async function pointer(thread: string): Promise<string | null> {
  const { rows } = await admin.query(
    "SELECT active_turn_id FROM session_turn_pointers WHERE tenant_id = qm_tenant_id() AND thread_ref = $1",
    [thread],
  );
  return (rows[0]?.active_turn_id as string | null) ?? null;
}

async function absurdRun(runId: string) {
  const { rows } = await admin.query("SELECT state, attempt, claimed_by FROM absurd.r_turns_people WHERE run_id = $1", [
    runId,
  ]);
  return rows[0] as { state: string; attempt: number; claimed_by: string | null };
}

async function claim(token = `test:${randomUUID()}`): Promise<{ run: Run; token: string }> {
  for (let i = 0; i < 20; i++) {
    const { run } = await ledger.claim("turns_people", token, "test");
    if (run) return { run, token };
    await sleep(25);
  }
  throw new Error("nothing claimable");
}

const ok = (run: Run): TurnResult => ({ status: "ok", sessionId: run.sessionId, reply: "done" });

before(async () => {
  if (!URL) return;
  admin = new pg.Pool({ connectionString: URL, max: 4 });
  registerAbsurdSchema(URL);
  runStore = createPostgresRunStore(URL);
  sessions = createPostgresSessionStore(URL);
  runStore.runs.onTerminal((run) => terminal.push(run));
  ledger = createTurnLedger(URL, { onTerminal: (run) => runStore.runs.emitTerminal?.(run) });
  await migrateRegisteredPgSchemas(URL);
});

beforeEach(async () => {
  if (!URL) return;
  const tables = TURN_QUEUES.flatMap((queue) =>
    ["t_", "r_", "c_", "e_", "w_"].map((prefix) => `absurd.${prefix}${queue}`),
  );
  await admin.query(`TRUNCATE ${tables.join(", ")}, session_turn_pointers`);
  await admin.query("DELETE FROM runs");
});

after(async () => {
  if (!URL) return;
  await ledger.close();
  await runStore.close();
  await admin.end();
});

test("admission starts an idle conversation's turn and queues the next one behind it", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const first = await admit(thread, "one");
  assert.equal(first.run.status, "pending");
  assert.equal(await pointer(thread), first.run.id);
  const second = await admit(thread, "two");
  assert.equal(second.run.status, "queued");
  assert.equal(await pointer(thread), first.run.id);
  const again = await admit(thread, "two", "dedup-a");
  const deduped = await admit(thread, "two", "dedup-a");
  assert.equal(deduped.deduped, true);
  assert.equal(deduped.run.id, again.run.id);
  const inFlight = await runStore.runs.inFlightForThread(thread);
  assert.deepEqual(
    inFlight.map((run) => run.id),
    [first.run.id, second.run.id, again.run.id],
  );
  assert.equal((await runStore.runs.activeForThread(thread))?.id, first.run.id);
});

test("turn end completes the task, records the result, and starts the queued turn", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const first = await admit(thread, "one");
  const second = await admit(thread, "two");
  const { run, token } = await claim();
  assert.equal(run.id, first.run.id);
  assert.equal(run.status, "running");
  assert.equal(run.attempts, 1);
  assert.equal(await ledger.fenceHeld(run.id, token), true);
  assert.equal(await ledger.extend(run, token), "held");
  assert.equal(await ledger.finish(run, token, { status: "done", result: ok(run) }), true);
  assert.equal((await absurdRun(run.absurdRunId!)).state, "completed");
  const done = await runStore.runs.get(run.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.leaseToken, null);
  assert.equal(done?.result?.reply, "done");
  assert.ok(terminal.some((settled) => settled.id === run.id));
  assert.equal(await pointer(thread), second.run.id);
  assert.equal((await runStore.runs.get(second.run.id))?.status, "pending");
  const next = await claim();
  assert.equal(next.run.id, second.run.id);
  assert.equal(await ledger.finish(next.run, next.token, { status: "done", result: ok(next.run) }), true);
  assert.equal(await pointer(thread), null);
});

test("handback frees the claim without spending an attempt and fences the old holder out", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const session = await sessions.getOrCreateByThread(thread, "dm", scopeId("personal", "alice@example.com"));
  await admit(thread);
  const { run, token } = await claim();
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const fenced = { ...lease, turnId: run.id, fenceToken: token };
  await sessions.append(fenced, { kind: "UserMessage", text: "hello" });
  assert.equal(await ledger.handBack(run, token, { stop: { kind: "shutdown" } }), true);
  const handed = await runStore.runs.get(run.id);
  assert.equal(handed?.status, "pending");
  assert.deepEqual(handed?.lastStop, { kind: "shutdown" });
  const state = await absurdRun(run.absurdRunId!);
  assert.equal(state.state, "sleeping");
  assert.equal(state.claimed_by, null);
  await assert.rejects(
    sessions.append(fenced, { kind: "AgentMessage", text: "stale write" }),
    /no longer holds its claim/,
  );
  assert.equal(await ledger.finish(run, token, { status: "done", result: ok(run) }), false);
  const resumed = await claim();
  assert.equal(resumed.run.id, run.id);
  await assert.rejects(sessions.append(lease, { kind: "AgentMessage", text: "old lease" }), /lease/);
  const { lease: fresh } = await sessions.acquireLease(session.id, "turn");
  assert.ok(fresh);
  assert.equal(resumed.run.absurdRunId, run.absurdRunId);
  assert.equal((await absurdRun(run.absurdRunId!)).attempt, 1);
  assert.equal(resumed.run.attempts, 2);
  await sessions.append({ ...fresh, turnId: run.id, fenceToken: resumed.token }, { kind: "AgentMessage", text: "ok" });
  assert.equal(await ledger.finish(resumed.run, resumed.token, { status: "done", result: ok(run) }), true);
  await sessions.releaseLease(fresh);
  const items = await sessions.getItems(session.id);
  assert.deepEqual(
    items.map((item) => item.text),
    ["hello", "ok"],
  );
});

test("an expired claim is taken over by a new attempt and the old holder is fenced", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  await admit(thread);
  const { run, token } = await claim();
  await admin.query(
    "UPDATE absurd.r_turns_people SET claim_expires_at = absurd.current_time() - interval '1 second' WHERE run_id = $1",
    [run.absurdRunId],
  );
  const next = await claim();
  assert.equal(next.run.id, run.id);
  assert.notEqual(next.run.absurdRunId, run.absurdRunId);
  assert.equal((await absurdRun(next.run.absurdRunId!)).attempt, 2);
  assert.equal(await ledger.fenceHeld(run.id, token), false);
  assert.equal(await ledger.extend(run, token), "lost");
  assert.equal(await ledger.finish(run, token, { status: "done", result: ok(run) }), false);
  assert.equal(await ledger.finish(next.run, next.token, { status: "done", result: ok(run) }), true);
});

test("stop withdraws a queued turn, cancels an unclaimed one, and lets a running one wrap up", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const first = await admit(thread, "one");
  const second = await admit(thread, "two");
  const third = await admit(thread, "three");
  assert.equal(await ledger.cancel(second.run.id), "withdrawn");
  assert.equal(await runStore.runs.get(second.run.id), null);
  assert.equal(await ledger.cancel(first.run.id), "cancelled");
  assert.equal(await runStore.runs.get(first.run.id), null);
  assert.equal(await pointer(thread), third.run.id);
  const { run, token } = await claim();
  assert.equal(run.id, third.run.id);
  assert.equal(await ledger.cancel(run.id), "signalled");
  assert.equal(await ledger.extend(run, token), "cancelled");
  assert.equal(await ledger.fenceHeld(run.id, token), true);
  assert.equal(await ledger.finish(run, token, { status: "done", result: { ...ok(run), stopped: true } }), true);
  assert.equal((await runStore.runs.get(run.id))?.result?.stopped, true);
  assert.equal((await absurdRun(run.absurdRunId!)).state, "cancelled");
  assert.equal(await pointer(thread), null);
});

test("pointer repair ends a turn whose task was cancelled with nobody left to wrap it up", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  await admit(thread, "one");
  const queued = await admit(thread, "two");
  const { run } = await claim();
  assert.equal(await ledger.cancel(run.id), "signalled");
  assert.ok(!(await ledger.repairCandidates()).some((candidate) => candidate.turnId === run.id));
  await admin.query(
    "UPDATE absurd.t_turns_people SET cancelled_at = cancelled_at - interval '1 minute' WHERE task_id = $1",
    [run.absurdTaskId],
  );
  const candidate = (await ledger.repairCandidates()).find((found) => found.turnId === run.id);
  assert.ok(candidate);
  const repaired = await ledger.repair(candidate, { status: "failed", sessionId: thread, reason: "repaired" });
  assert.equal(repaired?.status, "failed");
  assert.equal(await pointer(thread), run.id);
  await ledger.release(candidate);
  assert.equal(await pointer(thread), queued.run.id);
  assert.equal((await runStore.runs.get(queued.run.id))?.status, "pending");
});

test("the runner hands a turn back on shutdown and another runner resumes it from the queue", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const admitted = await admit(thread);
  const started: OrchestratorInput[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = {
    async handleTurn(input: OrchestratorInput): Promise<TurnResult> {
      started.push(input);
      await Promise.race([blocked, new Promise((resolve) => input.shutdown?.addEventListener("abort", resolve))]);
      return { status: "ok", sessionId: thread, reply: "late" };
    },
  } as unknown as Orchestrator;
  const outgoing = createTurnRunner({ ledger, orchestrator: slow, queues: TURN_QUEUES, slots: 2, pollMs: 50 });
  outgoing.start();
  for (let i = 0; i < 100 && !started.length; i++) await sleep(20);
  assert.equal(started[0]?.runId, admitted.run.id);
  assert.ok(started[0]?.turnFenceToken);
  await outgoing.releaseInFlight();
  release();
  const handed = await runStore.runs.get(admitted.run.id);
  assert.equal(handed?.status, "pending");
  const fast = {
    async handleTurn(input: OrchestratorInput): Promise<TurnResult> {
      started.push(input);
      return { status: "ok", sessionId: thread, reply: "resumed" };
    },
  } as unknown as Orchestrator;
  const incoming = createTurnRunner({ ledger, orchestrator: fast, queues: TURN_QUEUES, slots: 2, pollMs: 50 });
  incoming.start();
  let finished: Run | null = null;
  for (let i = 0; i < 100; i++) {
    finished = await runStore.runs.get(admitted.run.id);
    if (finished?.status === "done") break;
    await sleep(20);
  }
  await incoming.stopClaims();
  assert.equal(finished?.status, "done");
  assert.equal(finished?.result?.reply, "resumed");
  assert.equal(started[1]?.attempt, 2);
  assert.deepEqual(started[1]?.resumeCause, { kind: "shutdown" });
  assert.equal((await absurdRun(finished!.absurdRunId!)).attempt, 1);
});

test("the runner retries a failed turn within QM's error budget and then records the failure", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const admitted = await admit(thread);
  await admin.query("UPDATE runs SET max_attempts = 2 WHERE id = $1", [admitted.run.id]);
  let calls = 0;
  const failing = {
    async handleTurn(): Promise<TurnResult> {
      calls += 1;
      throw new Error("model exploded");
    },
  } as unknown as Orchestrator;
  const runner = createTurnRunner({
    ledger,
    orchestrator: failing,
    queues: TURN_QUEUES,
    slots: 1,
    pollMs: 50,
    retryDelayMs: () => 100,
  });
  runner.start();
  let run: Run | null = null;
  for (let i = 0; i < 300; i++) {
    run = await runStore.runs.get(admitted.run.id);
    if (run?.status === "failed") break;
    await sleep(20);
  }
  await runner.stopClaims();
  assert.equal(run?.status, "failed");
  assert.equal(calls, 2);
  assert.equal(run?.errorAttempts, 2);
  assert.match(run?.result?.reason ?? "", /model exploded|failed/);
  assert.equal(await pointer(thread), null);
});

test("a claim handed straight back before the turn starts does not count as an attempt", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const admitted = await admit(thread);
  const { run, token } = await claim();
  assert.equal(run.attempts, 1);
  assert.equal(await ledger.handBack(run, token, { unstarted: true }), true);
  const handed = await runStore.runs.get(admitted.run.id);
  assert.equal(handed?.attempts, 0);
  assert.equal(handed?.status, "pending");
});

test("a turn over the crash-loop claim cap fails instead of running again", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const admitted = await admit(thread);
  await admin.query("UPDATE runs SET attempts = 3 WHERE id = $1", [admitted.run.id]);
  let calls = 0;
  const orchestrator = {
    async handleTurn(): Promise<TurnResult> {
      calls += 1;
      return { status: "ok" };
    },
  } as unknown as Orchestrator;
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 1, pollMs: 50, maxClaims: 3 });
  runner.start();
  let run: Run | null = null;
  for (let i = 0; i < 200; i++) {
    run = await runStore.runs.get(admitted.run.id);
    if (run?.status === "failed") break;
    await sleep(20);
  }
  await runner.stopClaims();
  assert.equal(calls, 0);
  assert.equal(run?.status, "failed");
  assert.match(run?.result?.reason ?? "", /crash loop/);
});

function gate() {
  const started: OrchestratorInput[] = [];
  const releases = new Map<string, () => void>();
  const orchestrator = {
    async handleTurn(input: OrchestratorInput): Promise<TurnResult> {
      started.push(input);
      await new Promise<void>((resolve) => {
        releases.set(input.runId!, resolve);
        input.shutdown?.addEventListener("abort", () => resolve());
      });
      return { status: "ok", reply: `done ${input.text}` };
    },
  } as unknown as Orchestrator;
  return { started, releases, orchestrator };
}

test("admission routes each tier to its own queue and the runner prefers people", { skip }, async () => {
  const background = await admit(`web:cron:${randomUUID()}`, "background", undefined, 2);
  const delegated = await admit(`web:child:${randomUUID()}`, "delegated", undefined, 1);
  const person = await admit(`web:alice:${randomUUID()}`, "person", undefined, 0);
  assert.equal(background.run.absurdQueue, "turns_background");
  assert.equal(delegated.run.absurdQueue, "turns_delegated");
  assert.equal(person.run.absurdQueue, "turns_people");
  const { started, releases, orchestrator } = gate();
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 1, pollMs: 50 });
  runner.start();
  for (const expected of ["person", "delegated", "background"]) {
    await eventually(async () => started.length, {
      until: (n) => n > 0 && started.at(-1)?.text === expected,
      label: expected,
    });
    releases.get(started.at(-1)!.runId!)!();
  }
  await eventually(async () => (await runStore.runs.get(background.run.id))?.status, {
    until: (s) => s === "done",
    label: "background done",
  });
  await runner.stopClaims();
});

test("a person's turn over capacity parks the newest background turn, which resumes later", { skip }, async () => {
  const crons = [];
  for (let i = 0; i < 4; i++) crons.push(await admit(`web:cron:${randomUUID()}`, `cron ${i}`, undefined, 2));
  const { started, releases, orchestrator } = gate();
  const ready = createPostgresNotifyBus<string>(URL!, TURN_READY_CHANNEL, "test turn readiness");
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 4, pollMs: 50, ready });
  runner.start();
  await eventually(async () => started.length, { until: (n) => n === 4, label: "four background turns" });
  const newest = started.at(-1)!.runId!;
  const person = await admit(`web:alice:${randomUUID()}`, "person", undefined, 0);
  const parked = await eventually(() => runStore.runs.get(newest), {
    until: (run) => run?.status === "pending",
    label: "newest background turn parked",
  });
  assert.deepEqual(parked?.lastStop, { kind: "parked" });
  assert.equal(parked?.preemptions, 1);
  await eventually(async () => started.some((input) => input.runId === person.run.id), {
    until: Boolean,
    label: "person started",
  });
  releases.get(person.run.id)!();
  await eventually(async () => (await runStore.runs.get(person.run.id))?.status, {
    until: (s) => s === "done",
    label: "person done",
  });
  for (const input of started.slice(0, 3)) releases.get(input.runId!)!();
  const resumed = await eventually(async () => started.filter((input) => input.runId === newest), {
    until: (inputs) => inputs.length === 2,
    label: "parked turn resumed",
  });
  assert.deepEqual(resumed[1]?.resumeCause, { kind: "parked" });
  releases.get(newest)!();
  await eventually(async () => (await runStore.runs.get(newest))?.status, {
    until: (s) => s === "done",
    label: "parked turn done",
  });
  await runner.stopClaims();
  await ready.close?.();
});

test("a person writing into a running cron turn parks it until the person's turn ends", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const cron = await admit(thread, "cron", undefined, 2);
  const { started, releases, orchestrator } = gate();
  const yields = createPostgresNotifyBus<string>(URL!, TURN_YIELD_CHANNEL, "test turn yields");
  const ready = createPostgresNotifyBus<string>(URL!, TURN_READY_CHANNEL, "test turn readiness");
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 2, pollMs: 50, yields, ready });
  runner.start();
  await eventually(async () => started.length, { until: (n) => n === 1, label: "cron started" });
  await sleep(100);
  const person = await admit(thread, "person", undefined, 0);
  assert.equal(person.run.status, "queued");
  await eventually(async () => started.length, { until: (n) => n === 2, label: "person started" });
  assert.equal(started[1]?.runId, person.run.id);
  const parked = await runStore.runs.get(cron.run.id);
  assert.equal(parked?.status, "pending");
  assert.equal(await pointer(thread), person.run.id);
  const { rows } = await admin.query("SELECT state FROM absurd.r_turns_background WHERE run_id = $1", [
    parked!.absurdRunId,
  ]);
  assert.equal(rows[0]?.state, "sleeping");
  releases.get(person.run.id)!();
  await eventually(async () => started.length, { until: (n) => n === 3, label: "cron resumed" });
  assert.equal(started[2]?.runId, cron.run.id);
  assert.deepEqual(started[2]?.resumeCause, { kind: "parked" });
  assert.equal(await pointer(thread), cron.run.id);
  releases.get(cron.run.id)!();
  await eventually(async () => (await runStore.runs.get(cron.run.id))?.status, {
    until: (s) => s === "done",
    label: "cron done",
  });
  assert.equal(await pointer(thread), null);
  await runner.stopClaims();
  await yields.close?.();
  await ready.close?.();
});

test("a person writing after a cron was stopped ends the cron as stopped and starts at once", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const cron = await admit(thread, "cron", undefined, 2);
  const { started, releases, orchestrator } = gate();
  const yields = createPostgresNotifyBus<string>(URL!, TURN_YIELD_CHANNEL, "test turn yields");
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 2, pollMs: 50, yields });
  runner.start();
  await eventually(async () => started.length, { until: (n) => n === 1, label: "cron started" });
  assert.equal(await ledger.cancel(cron.run.id), "signalled");
  const person = await admit(thread, "person", undefined, 0);
  await eventually(async () => started.some((input) => input.runId === person.run.id), {
    until: Boolean,
    label: "person started",
  });
  const stopped = await runStore.runs.get(cron.run.id);
  assert.equal(stopped?.status, "done");
  assert.equal(stopped?.result?.stopped, true);
  releases.get(person.run.id)!();
  await eventually(async () => (await runStore.runs.get(person.run.id))?.status, {
    until: (s) => s === "done",
    label: "person done",
  });
  await runner.stopClaims();
  await yields.close?.();
});

test("a person's message parks a background turn that is not running and starts at once", { skip }, async () => {
  const thread = `web:alice:${randomUUID()}`;
  const cron = await admit(thread, "cron", undefined, 2);
  const token = `test:${randomUUID()}`;
  const { run } = await ledger.claim("turns_background", token, "test");
  assert.equal(run?.id, cron.run.id);
  assert.equal(await ledger.handBack(run!, token, { delayMs: 1_500, countsAsError: true }), true);
  const person = await admit(thread, "person", undefined, 0);
  assert.equal(person.run.status, "pending");
  assert.equal(await pointer(thread), person.run.id);
  const parked = await runStore.runs.get(cron.run.id);
  assert.deepEqual(parked?.lastStop, { kind: "parked" });
  const { started, releases, orchestrator } = gate();
  const ready = createPostgresNotifyBus<string>(URL!, TURN_READY_CHANNEL, "test turn readiness");
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 2, pollMs: 50, ready });
  runner.start();
  await eventually(async () => started.some((input) => input.runId === person.run.id), {
    until: Boolean,
    label: "person started",
  });
  await sleep(2_000);
  assert.equal(
    started.some((input) => input.runId === cron.run.id),
    false,
    "the cron waits while the person's turn runs",
  );
  releases.get(person.run.id)!();
  const resumed = await eventually(async () => started.filter((input) => input.runId === cron.run.id), {
    until: (inputs) => inputs.length === 1,
    label: "cron resumed after the person",
  });
  assert.deepEqual(resumed[0]?.resumeCause, { kind: "parked" });
  releases.get(cron.run.id)!();
  await eventually(async () => (await runStore.runs.get(cron.run.id))?.status, {
    until: (s) => s === "done",
    label: "cron done",
  });
  assert.equal(await pointer(thread), null);
  await runner.stopClaims();
  await ready.close?.();
});

test("stopping a tree stops every turn in its conversations in one step", { skip }, async () => {
  const parent = `web:alice:${randomUUID()}`;
  const child = `agent:main:subagent:${randomUUID()}`;
  await admit(parent, "parent");
  const { run: running, token } = await claim();
  assert.equal(running.sessionId, parent);
  const queued = await admit(parent, "follow-up");
  const childTurn = await admit(child, "child work", undefined, 1);
  assert.equal(childTurn.run.status, "pending");
  assert.equal(await ledger.cancelTree([parent, child]), 3);
  assert.equal(await runStore.runs.get(queued.run.id), null);
  assert.equal(await runStore.runs.get(childTurn.run.id), null);
  assert.equal(await pointer(child), null);
  assert.equal(await pointer(parent), running.id);
  assert.equal(await ledger.extend(running, token), "cancelled");
  assert.equal(
    await ledger.finish(running, token, {
      status: "done",
      result: { status: "ok", sessionId: parent, stopped: true },
    }),
    true,
  );
  assert.equal(await pointer(parent), null);
});

test(
  "a run the legacy engine left in flight is failed so its thread is free, and Absurd turns are untouched",
  { skip },
  async () => {
    const thread = `web:alice:${randomUUID()}`;
    const legacy = randomUUID();
    await admin.query(
      `INSERT INTO runs(id, session_id, status, request, attempts, max_attempts, created_at, claim_priority, engine)
     VALUES ($1, $2, 'pending', $3, 0, 3, $4, 0, 'legacy')`,
      [legacy, thread, JSON.stringify(request(thread)), Date.now()],
    );
    const queued = await admit(`web:alice:${randomUUID()}`);
    const settle = registeredPgMigrations(URL!).find((m) => m.id === "runs/store/0015-settle-unclaimed-in-flight")!;
    for (const statement of settle.statements) await admin.query(statement);
    const failed = await runStore.runs.get(legacy);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.result?.reason, "This turn stopped unexpectedly and could not be resumed.");
    assert.equal(await runStore.runs.activeForThread(thread), null);
    assert.equal((await runStore.runs.get(queued.run.id))?.status, "pending");
  },
);

test("turns admit, fence and finish once the contract phase drops runs.engine", { skip }, async () => {
  const { rows } = await admin.query(
    "SELECT column_default FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'engine'",
  );
  assert.equal(rows[0]?.column_default, "'absurd'::text");
  const drop = CONTRACT_MIGRATIONS.find((migration) => migration.id === "contract/0009-drop-runs-engine")!;
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    for (const statement of drop.statements) await client.query(statement);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const thread = `web:alice:${randomUUID()}`;
  const admitted = await admit(thread);
  const { run, token } = await claim();
  assert.equal(run.id, admitted.run.id);
  assert.equal(await ledger.fenceHeld(run.id, token), true);
  assert.equal(await ledger.finish(run, token, { status: "done", result: ok(run) }), true);
  assert.equal((await runStore.runs.get(run.id))?.status, "done");
});
