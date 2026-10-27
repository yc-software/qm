import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { runPriority } from "../../src/runs/run-store.ts";
import { createSessionSyscalls } from "../../src/subagents/session-tools.ts";
import { createPostgresSwarmBoard } from "../../src/swarms/swarm-board.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { deliverSubagentMail } from "../../src/subagents/mail.ts";
import { completeTurn } from "../support/turns.ts";
import { actor, closeRigStores, conversation, freshSession, rig, scope } from "../support/subagent-rig.ts";

after(closeRigStores);

const base = { actor, conversation, surface: "slack", text: "work" } as const;
const human = { ...base, origin: { kind: "human" } } as OrchestratorInput;
const cron = { ...base, origin: { kind: "automation" } } as OrchestratorInput;

test("run priority ranks people first, then subagents, then crons and swarms", () => {
  assert.equal(runPriority(human, null), 0);
  assert.equal(runPriority({ ...cron, delegatingRunId: "r0" }, 0), 1);
  assert.equal(runPriority({ ...cron, delegatingRunId: "r1" }, 1), 1);
  assert.equal(runPriority(cron, null), 2);
  assert.equal(runPriority({ ...cron, swarm: true, delegatingRunId: "r0" }, 0), 2);
  assert.equal(runPriority({ ...cron, delegatingRunId: "r2" }, 2), 2);
});

test("swarm members queue behind subagents opened by the same person's turn, and their follow-ups stay there", async () => {
  const r = await rig();
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    dedupKey: "swarm-priority-human",
    request: { ...human, addressed: true },
  });
  assert.equal(parent.run.priority, 0);
  const api = createSessionSyscalls({
    ...r,
    board: createPostgresSwarmBoard(testDatabaseUrl()),
    maxAttempts: 3,
  }).forTurn({ session: r.room, scopeId: scope, request: { ...parent.run.request, runId: parent.run.id } });

  const opened = await api.open({ task: "inspect the logs" });
  assert.ok(opened.ok);
  const subagent = await freshSession(r.sessions, opened.sessionId);
  const subagentRun = (await r.runs.inFlightForThread(subagent.threadRef))[0]!;
  assert.equal(subagentRun.priority, 1);
  assert.equal(subagentRun.absurdQueue, "turns_delegated");

  const started = await api.swarm!({ action: "start", requestId: "swarm-1", members: [{ task: "map the API" }] });
  assert.ok(started.ok, JSON.stringify(started));
  const [member] = started.result.members as Array<{ sessionId: string }>;
  const memberSession = await freshSession(r.sessions, member!.sessionId);
  assert.equal(memberSession.spawnMeta?.swarm, true);
  const memberRun = (await r.runs.inFlightForThread(memberSession.threadRef))[0]!;
  assert.equal(memberRun.request.swarm, true);
  assert.equal(memberRun.priority, 2);
  assert.equal(memberRun.absurdQueue, "turns_background");

  const done = await completeTurn(r.ledger, memberRun.id, {
    status: "ok",
    sessionId: memberSession.threadRef,
    reply: "mapped",
  });
  await deliverSubagentMail({ sessions: r.sessions, runs: r.runs, mailbox: r.mailbox, maxAttempts: 3 }, done);
  const wake = (await r.runs.inFlightForThread(r.room.threadRef)).find((run) => run.request.wakeCause === "child_done");
  assert.ok(wake);
  assert.equal(wake.request.swarm, undefined);
  assert.equal(wake.priority, 1);
  const followup = await api.write({ target: memberSession.id, text: "also check auth", followup: true });
  assert.ok(followup.ok, JSON.stringify(followup));
  const [queued] = await r.runs.inFlightForThread(memberSession.threadRef);
  assert.ok(queued && queued.id !== memberRun.id);
  assert.equal(queued.request.swarm, true);
  assert.equal(queued.priority, 2);
});
