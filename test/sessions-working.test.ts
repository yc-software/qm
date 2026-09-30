import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Principal, TurnRequest } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-working-"));
  return buildApp(testConfig({ dataDir }));
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

test("listSessions flags a session with an in-flight turn as working", async (t) => {
  const { app, runs, sessions } = freshApp();

  await app.turn(dm("Just a question", "web:U1:idle"));
  const parent = await app.turn(dm("Parent", "web:U1:busy-parent"));

  const busyThread = "web:U1:busy";
  const busy = await app.turn(dm("Kick something off", busyThread));
  const busyId = busy.sessionId!;
  assert.ok(busyId);
  assert.notEqual(busyId, busyThread, "session UUID and threadRef are distinct (the trap)");
  await sessions.setParentSession(busyId, parent.sessionId!);
  await runs.enqueue({ sessionId: busyThread, request: enqueueRequest() });

  const failures = t.mock.method(runs, "latestFailedThreads");
  const list = await app.listSessions("U1");
  const busyRow = list.find((s) => s.threadRef === busyThread);
  const idleRow = list.find((s) => s.threadRef === "web:U1:idle");
  assert.deepEqual(failures.mock.calls[0]!.arguments[0], []);

  assert.equal(busyRow?.working, true, "the session with an in-flight run is flagged working");
  assert.ok(idleRow, "the idle session is still listed");
  assert.ok(!idleRow!.working, "a settled session is not flagged");
});

test("the working flag clears once the in-flight run settles", async () => {
  const { app, runs } = freshApp();
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

test("listSessions flags a subagent whose latest turn failed, and only while it stays failed", async () => {
  const { app, runs, sessions } = freshApp();
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

test("listSessions does not hydrate individual idle-child runs", async (t) => {
  const { app, runs, sessions } = freshApp();
  const parent = await sessions.getOrCreateByThread("web:U1:batch-parent", "dm", "personal:U1");
  await sessions.addParticipant(parent.id, "U1");
  await sessions.updateTitle(parent.id, "Parent");
  const children = [];
  for (let i = 0; i < 12; i++) {
    const child = await sessions.getOrCreateByThread(`web:U1:batch-${i}`, "dm", "personal:U1");
    await sessions.addParticipant(child.id, "U1");
    await sessions.updateTitle(child.id, `Child ${i}`);
    await sessions.setParentSession(child.id, parent.id);
    const { run } = await runs.enqueue({ sessionId: child.threadRef, request: enqueueRequest() });
    const claimed = await runs.claimById(run.id, "worker", 5000);
    assert.ok(claimed?.leaseToken);
    await runs.complete(
      run.id,
      claimed.leaseToken,
      i % 2 ? { status: "ok", reply: "ok" } : { status: "failed", reason: "failure" },
    );
    children.push(child);
  }
  const foreign = await sessions.getOrCreateByThread("web:U2:batch", "dm", "personal:U2");
  await sessions.addParticipant(foreign.id, "U2");
  await sessions.updateTitle(foreign.id, "Foreign child");
  await sessions.setParentSession(foreign.id, parent.id);
  const failures = t.mock.method(runs, "latestFailedThreads");
  const latest = t.mock.method(runs, "latestForThread");
  const listed = await app.listSessions("U1");
  assert.equal(failures.mock.callCount(), 1);
  assert.deepEqual(new Set(failures.mock.calls[0]!.arguments[0]), new Set(children.map((s) => s.threadRef)));
  assert.equal(
    listed.some((s) => s.id === foreign.id),
    false,
  );
  assert.equal(latest.mock.callCount(), 0, "idle-child decoration must not read full runs individually");
  for (const [i, child] of children.entries())
    assert.equal(listed.find((s) => s.id === child.id)?.lastTurnFailed, i % 2 ? undefined : true);
});
