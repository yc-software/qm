import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { backfillSessionFacts } from "../src/sessions/session-facts-backfill.ts";
import { sessionContextOf } from "../src/sessions/session-syscalls.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const actor: Principal = { id: "U1", type: "internal" };
const scope = scopeId("personal", "U1");
const slackSource = { accountId: "A2", teamId: "T1", userId: "U1" };

function request(threadRef: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput {
  const conversation: Conversation = { kind: "dm", threadRef, audience: [actor] };
  return { actor, conversation, surface: "slack", origin: { kind: "human", messageTs: "1.1" }, text: "hi", ...extra };
}

test("a session keeps the Slack binding it was created with and follows its latest context", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const first = request("slack:dm:facts");
  const created = await sessions.getOrCreateByThread("slack:dm:facts", "dm", scope, undefined, "slack", undefined, {
    slackBinding: slackSource,
    context: sessionContextOf(first),
  });
  assert.deepEqual(created.slackBinding, slackSource);
  assert.deepEqual(created.spawnMeta?.origin, { kind: "human" });
  const later = request("slack:dm:facts", { timezone: "America/Los_Angeles" });
  await sessions.getOrCreateByThread("slack:dm:facts", "dm", scope, undefined, "slack", undefined, {
    slackBinding: { ...slackSource, accountId: "A3" },
    context: sessionContextOf(later),
  });
  const stored = (await sessions.getByThread("slack:dm:facts"))!;
  assert.deepEqual(stored.slackBinding, slackSource);
  assert.equal(stored.spawnMeta?.timezone, "America/Los_Angeles");
  await sessions.setRuntime(stored.id, { modelId: "m1", label: "Model One" });
  assert.deepEqual((await sessions.get(stored.id))?.runtime, { modelId: "m1", label: "Model One" });
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: url });
  const version = async () =>
    (await raw.query("SELECT xmin::text FROM sessions WHERE id = $1", [stored.id])).rows[0].xmin;
  const before = await version();
  await sessions.setRuntime(stored.id, { label: "Model One", modelId: "m1" });
  assert.equal(await version(), before, "an unchanged runtime writes nothing");
  await raw.end();
});

test("a session ended in failure while its newest item is an error", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const failed = await sessions.getOrCreateByThread("web:U1:failed", "dm", scope);
  const recovered = await sessions.getOrCreateByThread("web:U1:recovered", "dm", scope);
  for (const session of [failed, recovered]) {
    const { lease } = await sessions.acquireLease(session.id);
    await sessions.append(lease!, { type: "user", payload: { text: "go" }, scopeLabel: scope, author: actor.id });
    await sessions.append(lease!, {
      type: "system",
      payload: { kind: "turn_failure", message: "boom" },
      scopeLabel: scope,
    });
    if (session === recovered)
      await sessions.append(lease!, { type: "assistant", payload: { text: "done" }, scopeLabel: scope });
    await sessions.releaseLease(lease!);
  }
  assert.deepEqual(await sessions.endedInFailure([failed.id, recovered.id, "missing"]), new Set([failed.id]));
});

test("the one-time backfill copies each session's facts from its latest runs before runs are pruned", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const slack = await sessions.getOrCreateByThread("slack:dm:old", "dm", scope, undefined, "slack");
  const quiet = await sessions.getOrCreateByThread("web:U1:quiet", "dm", scope, undefined, "web");
  const finish = async (threadRef: string, extra: Partial<OrchestratorInput>, runtime?: { modelId: string }) => {
    const { run } = await runs.enqueue({ sessionId: threadRef, request: request(threadRef, extra) });
    const lease = (await runs.claimById(run.id, "w", 60_000))!.leaseToken!;
    await runs.complete(run.id, lease, { status: "ok", reply: "ok", ...(runtime ? { runtime } : {}) });
  };
  await finish(slack.threadRef, { slackSource }, { modelId: "m1" });
  await finish(slack.threadRef, { slackSource, privateSessionMessage: true, timezone: "UTC" }, { modelId: "m2" });

  const budget = { deadline: Date.now() + 60_000, stop: () => false };
  assert.equal(await backfillSessionFacts({ sessions, runs }, { ...budget, stop: () => true }), false);
  assert.equal(await backfillSessionFacts({ sessions, runs }, budget), true);
  assert.equal(await sessions.sessionFactsCursor(), "done");

  const filled = (await sessions.get(slack.id))!;
  assert.deepEqual(filled.slackBinding, slackSource);
  assert.deepEqual(filled.runtime, { modelId: "m2" });
  assert.equal(
    filled.spawnMeta?.timezone,
    undefined,
    "context comes from the latest run that is not a private message",
  );
  assert.deepEqual(filled.spawnMeta?.conversation.audience, [actor]);
  const untouched = (await sessions.get(quiet.id))!;
  assert.equal(untouched.slackBinding ?? untouched.runtime ?? untouched.spawnMeta, undefined);
  assert.equal(await backfillSessionFacts({ sessions, runs }, budget), true);
});
