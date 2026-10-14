import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { createGoalRecord, goalSnapshotPayload, latestGoalRecord, rehydrateOpenGoal } from "../src/harness/goal.ts";
import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";
import type { Principal } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "goal-cancel-")) }));
}

function runRequest(): OrchestratorInput {
  const principal: Principal = { id: "internal:U1", type: "internal" };
  return {
    actor: principal,
    conversation: { kind: "dm", threadRef: "t", audience: [principal] },
    origin: { kind: "direct" },
    text: "keep going",
  };
}

async function sessionWithGoal(built: ReturnType<typeof freshApp>, ref: string, status: "active" | "paused") {
  const { sessions } = built;
  const session = await sessions.getOrCreateByThread(ref, "dm", "personal:U1");
  await sessions.addParticipant(session.id, "U1");
  const goal = createGoalRecord({ objective: "old outreach goal", floor: { minTurns: 40 } });
  goal.status = status;
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  await sessions.append(lease, {
    type: "system",
    payload: goalSnapshotPayload(goal),
    scopeLabel: session.scopeId,
  });
  await sessions.releaseLease(lease);
  return session;
}

for (const status of ["active", "paused"] as const) {
  test(`the owner cancels an idle ${status} goal; it closes for good and frees the session for a new goal`, async () => {
    const built = freshApp();
    const session = await sessionWithGoal(built, `web:U1:${status}`, status);

    assert.equal(await built.app.cancelSessionGoal(session.id, "U2"), null, "a non-participant cannot cancel");
    await built.sessions.addParticipant(session.id, "U2");
    assert.equal(
      await built.app.cancelSessionGoal(session.id, "U2"),
      null,
      "a participant who cannot write to the owner's personal scope cannot cancel",
    );
    assert.equal(rehydrateOpenGoal(await built.sessions.getEntries(session.id))?.status, status);

    assert.deepEqual(await built.app.cancelSessionGoal(session.id, "U1"), { cancelled: true });

    const entries = await built.sessions.getEntries(session.id);
    const last = entries.at(-1)!;
    assert.equal(last.type, "system");
    assert.equal((last.payload as { cancelledBy?: string }).cancelledBy, "U1");
    assert.equal(latestGoalRecord(entries)?.status, "cancelled");
    assert.equal(latestGoalRecord(entries)?.completionNote, undefined, "cancelling is not completing");
    assert.equal(rehydrateOpenGoal(entries), null, "later turns start with no goal to enforce");
    assert.match(
      JSON.stringify(reconstructMessagesFromHistory(entries)),
      /The user cancelled this goal/,
      "the model is told the goal was cancelled",
    );
    assert.ok(!(await built.app.listSessions("U1")).find((s) => s.id === session.id)?.goal);
    assert.deepEqual(await built.app.cancelSessionGoal(session.id, "U1"), {
      cancelled: false,
      reason: "no_open_goal",
    });
  });
}

for (const status of ["active", "paused"] as const) {
  test(`cancelling a ${status} goal while a turn runs lands after that turn's own final goal snapshot`, async () => {
    const built = freshApp();
    const ref = `web:U1:running-${status}`;
    const session = await sessionWithGoal(built, ref, status);
    await built.runs.enqueue({ sessionId: ref, request: runRequest() });
    const run = await built.runs.claim("w1", 60_000);
    assert.equal(run?.sessionId, ref);
    const { lease } = await built.sessions.acquireLease(session.id, "turn");
    assert.ok(lease, "the running turn holds the session");

    const cancelling = built.app.cancelSessionGoal(session.id, "U1");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      (await built.signals.pending(run!.id)).map((p) => p.signal.kind),
      status === "active" ? ["abort"] : [],
      status === "active"
        ? "a turn pursuing the goal is stopped"
        : "an unrelated reply is left to finish while the goal is paused",
    );

    const final = latestGoalRecord(await built.sessions.getEntries(session.id))!;
    final.status = "paused";
    await built.sessions.append(lease, {
      type: "system",
      payload: goalSnapshotPayload(final),
      scopeLabel: session.scopeId,
    });
    await built.sessions.releaseLease(lease);
    await built.runs.complete(run!.id, run!.leaseToken ?? "", { status: "ok", reply: "done" });

    assert.deepEqual(await cancelling, { cancelled: true });
    const entries = await built.sessions.getEntries(session.id);
    assert.deepEqual(
      entries.filter((e) => (e.payload as { kind?: string }).kind === "goal").map((e) => latestGoalRecord([e])?.status),
      [status, "paused", "cancelled"],
    );
    assert.equal(rehydrateOpenGoal(entries), null);
  });
}

test("cancelling with no open goal touches nothing", async () => {
  const built = freshApp();
  const ref = "web:U1:none";
  const session = await built.sessions.getOrCreateByThread(ref, "dm", "personal:U1");
  await built.sessions.addParticipant(session.id, "U1");
  await built.runs.enqueue({ sessionId: ref, request: runRequest() });
  const run = await built.runs.claim("w1", 60_000);
  assert.deepEqual(await built.app.cancelSessionGoal(session.id, "U1"), {
    cancelled: false,
    reason: "no_open_goal",
  });
  assert.deepEqual(await built.signals.pending(run!.id), []);
});
