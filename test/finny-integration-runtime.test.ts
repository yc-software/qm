import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { reconstructFinnyParentSyscalls } from "../src/finny/integration-runtime.ts";
import { createSessionSyscalls, sessionContextOf } from "../src/sessions/session-syscalls.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./support/test-database.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

const actor = { id: "U1", type: "internal" as const };
const scopeId = "personal:U1" as const;
const conversation = { kind: "dm" as const, threadRef: "slack:D1:100.1", audience: [actor] };

test("restart reconstruction opens workers through real session syscalls as an automation continuation", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const { runs } = createPostgresRunStore(url);
  const signals = createPostgresRunSignalStore(url);
  const request = {
    surface: "slack",
    actor,
    conversation,
    origin: { kind: "human" as const },
    deliveryTarget: "D1:100.1",
  };
  const room = await sessions.getOrCreateByThread(
    conversation.threadRef,
    "dm",
    scopeId,
    undefined,
    "slack",
    undefined,
    { context: sessionContextOf(request as OrchestratorInput) },
  );
  await sessions.addParticipant(room.id, actor.id);
  const { run: parentRun } = await runs.enqueue({
    sessionId: room.threadRef,
    request: request as OrchestratorInput,
  });
  await runs.withdraw(parentRun.id);
  const restartedFactory = createSessionSyscalls({
    mailbox: createSessionMailbox(testMap<SessionMessage>()),
    sessions,
    runs,
    signals,
    advisoryLock: testAdvisoryLock(),
    maxAttempts: 3,
  });
  const api = await reconstructFinnyParentSyscalls({
    sessions,
    syscalls: restartedFactory,
    parent: {
      scopeId,
      jobId: randomUUID(),
      requestId: randomUUID(),
      actorId: actor.id,
      originThreadRef: conversation.threadRef,
      destination: { type: "slack", target: "D1:100.1", threadTs: "100.1" },
      binding: {
        schema: "finny-parent-binding.v1",
        sessionId: room.id,
        runId: parentRun.id,
        scopeId,
        context: { actor, conversation, surface: "slack" },
      },
    },
  });
  const opened = await api.open({ requestId: "producer", name: "Finny Producer", task: "Await dispatch" });
  assert.ok(opened.ok, JSON.stringify(opened));
  const child = await sessions.get(opened.sessionId);
  assert.equal(child?.parentSessionId, room.id);
  const [run] = await runs.list({ threadRef: child!.threadRef, limit: 1 });
  assert.equal(run?.request.origin.kind, "automation");
  assert.deepEqual(run?.request.origin.kind === "automation" ? run.request.origin.destination : undefined, {
    type: "slack",
    target: "D1:100.1",
    threadTs: "100.1",
  });
  assert.deepEqual(run?.request.conversation.audience, [actor]);
  let reservedRunId = "";
  const dispatched = await api.write({
    target: opened.sessionId,
    requestId: "exact-grant",
    text: "Produce the approved artifact",
    wake: true,
    interrupt: true,
    async beforeEnqueue(binding) {
      reservedRunId = binding.runId;
      return { text: JSON.stringify({ task: "Produce the approved artifact", authority: "server-bound" }) };
    },
  });
  assert.equal(dispatched.ok, true);
  const queued = (await runs.list({ threadRef: child!.threadRef, limit: 5 })).find(
    (candidate) => candidate.id === reservedRunId,
  );
  assert.ok(queued);
  assert.match(queued.request.text, /server-bound/);
  assert.doesNotMatch(queued.request.text, /token|secret/i);
  assert.match(queued.request.displayText ?? "", /Produce the approved artifact/);
});
