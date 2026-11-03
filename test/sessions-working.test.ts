import "./support/auto-fake-sprites.ts";

import { test as nodeTest } from "node:test";
import { inTestTenant } from "./support/test-tenants.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "./support/build-app.ts";
import type { Principal, TurnRequest } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-working-"));
  return buildApp(testConfig({ dataDir }));
}

function test(name: string, fn: (built: ReturnType<typeof freshApp>) => Promise<void>): void {
  nodeTest(name, () => {
    const built = freshApp();
    return inTestTenant(() => fn(built));
  });
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

function enqueueRequest(): OrchestratorInput {
  const principal: Principal = { id: "internal:U1", type: "internal" };
  return {
    actor: principal,
    conversation: { kind: "dm", threadRef: "t", audience: [principal] },
    origin: { kind: "direct" },
    text: "working",
  };
}

test("listSessions flags a session with an in-flight turn as working", async ({ app, runs }) => {
  await app.turn(dm("Just a question", "web:U1:idle"));

  const busyThread = "web:U1:busy";
  const busy = await app.turn(dm("Kick something off", busyThread));
  const busyId = busy.sessionId!;
  assert.ok(busyId);
  assert.notEqual(busyId, busyThread, "session UUID and threadRef are distinct (the trap)");
  await runs.enqueue({ sessionId: busyThread, request: enqueueRequest() });

  const list = await app.listSessions("U1");
  const busyRow = list.find((s) => s.threadRef === busyThread);
  const idleRow = list.find((s) => s.threadRef === "web:U1:idle");

  assert.equal(busyRow?.working, true, "the session with an in-flight run is flagged working");
  assert.ok(idleRow, "the idle session is still listed");
  assert.ok(!idleRow!.working, "a settled session is not flagged");
});

test("the working flag clears once the in-flight run settles", async ({ app, runs }) => {
  const thread = "web:U1:settle";
  await app.turn(dm("start", thread));
  await runs.enqueue({ sessionId: thread, request: enqueueRequest() });

  assert.equal((await app.listSessions("U1")).find((r) => r.threadRef === thread)?.working, true);

  const claimed = await runs.claim("w1", 5_000);
  assert.equal(claimed?.sessionId, thread, "the run is keyed by threadRef");
  await runs.complete(claimed!.id, claimed!.leaseToken ?? "", { status: "ok", reply: "done" });

  assert.ok(
    !(await app.listSessions("U1")).find((r) => r.threadRef === thread)?.working,
    "the flag clears once the run is terminal",
  );
});

test("listSessions flags a subagent whose latest turn failed, and only while it stays failed", async (built) => {
  const { app, runs, sessions } = built;
  const parent = await app.turn(dm("parent", "web:U1:parent"));
  const child = await app.turn(dm("child", "web:U1:child"));
  const loose = await app.turn(dm("loose", "web:U1:loose"));
  await sessions.setParentSession(child.sessionId!, parent.sessionId!);

  for (const thread of ["web:U1:child", "web:U1:loose"]) {
    await runs.enqueue({ sessionId: thread, request: enqueueRequest() });
    const claimed = await runs.claim("w1", 5_000);
    await runs.complete(claimed!.id, claimed!.leaseToken ?? "", { status: "failed", reason: "boom" });
  }

  const list = await app.listSessions("U1");
  assert.equal(list.find((s) => s.id === child.sessionId)?.lastTurnFailed, true);
  assert.ok(!list.find((s) => s.id === loose.sessionId)?.lastTurnFailed, "only subagents carry the flag");

  await runs.enqueue({ sessionId: "web:U1:child", request: enqueueRequest() });
  const retry = await runs.claim("w1", 5_000);
  await runs.complete(retry!.id, retry!.leaseToken ?? "", { status: "ok", reply: "fine" });
  assert.ok(!(await app.listSessions("U1")).find((s) => s.id === child.sessionId)?.lastTurnFailed);
});

test("sidebar batches visible goals from the session rows and drops inactive ones", async ({ app, sessions, runs }) => {
  const visible: string[] = [];
  const refs: string[] = [];
  for (const [index, owner] of ["U1", "U1", "hidden"].entries()) {
    const ref = `web:${owner}:batch:${index}`;
    const session = await sessions.getOrCreateByThread(ref, "dm", `personal:${owner}`);
    await sessions.addParticipant(session.id, owner);
    const { lease } = await sessions.acquireLease(session.id);
    assert.ok(lease);
    await sessions.setGoal(lease, {
      objective: `goal ${index}`,
      status: index === 1 ? "complete" : "active",
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
      activeMs: 123,
    });
    await sessions.releaseLease(lease);
    await runs.enqueue({ sessionId: ref, request: enqueueRequest() });
    if (owner === "U1") {
      visible.push(session.id);
      refs.push(ref);
    }
  }
  const goals = sessions.goals.bind(sessions);
  const latest = runs.latestForThreads.bind(runs);
  let reads = 0;
  let runReads = 0;
  sessions.goals = async (ids) => {
    reads++;
    assert.deepEqual(new Set(ids), new Set(visible));
    return goals(ids);
  };
  runs.latestForThreads = async (ids, opts) => {
    runReads++;
    assert.deepEqual(new Set(ids), new Set(refs));
    return latest(ids, opts);
  };
  const list = await app.listSessions("U1");
  assert.deepEqual({ reads, runReads }, { reads: 1, runReads: 1 });
  assert.equal(list.length, 2);
  assert.equal(list.find((row) => row.id === visible[0])?.goal?.objective, "goal 0");
  assert.equal(list.find((row) => row.id === visible[0])?.goal?.activeMs, 123);
  assert.equal(list.find((row) => row.id === visible[1])?.goal, undefined);
});

test("a working subagent reports its current run start and latest purpose from that run", async (built) => {
  const { app, runs, sessions } = built;
  const parent = await app.turn(dm("parent", "web:U1:p"));
  const child = await app.turn(dm("child", "web:U1:c"));
  await sessions.setParentSession(child.sessionId!, parent.sessionId!);
  const say = async (purpose: string, runId: string) => {
    const { lease } = await sessions.acquireLease(child.sessionId!);
    await sessions.append(lease!, {
      type: "tool_call",
      payload: { tool: "execute", callId: purpose, purpose, runId },
      scopeLabel: "personal:U1",
    });
    await sessions.releaseLease(lease!);
  };
  await say("Old task", randomUUID());
  await runs.enqueue({ sessionId: "web:U1:c", request: enqueueRequest() });
  const claimed = await runs.claim("w1", 5_000);

  let row = (await app.listSessions("U1")).find((s) => s.id === child.sessionId);
  assert.equal(row?.workingSince, claimed!.startedAt);
  assert.equal(row?.purpose, undefined, "a purpose from an earlier run is not shown");

  await say("Reading the spec", claimed!.id);
  row = (await app.listSessions("U1")).find((s) => s.id === child.sessionId);
  assert.equal(row?.purpose, "Reading the spec");
  assert.equal((await app.listSessions("U1")).find((s) => s.id === parent.sessionId)?.workingSince, undefined);
});
