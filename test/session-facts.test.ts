import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { SESSION_MIGRATIONS } from "../src/sessions/session-schema.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { sessionContextOf } from "../src/sessions/session-syscalls.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { TurnSurfaceOrigin } from "../src/surfaces/contract.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const actor: Principal = { id: "U1", type: "internal" };
const scope = scopeId("personal", "U1");
const slackSource = { accountId: "A2", teamId: "T1", userId: "U1" };
const previousRelease = { slackSource } as unknown as Partial<OrchestratorInput>;
const binding: TurnSurfaceOrigin = {
  author: { surface: "slack", account: "A2", id: "U1" },
  workspace: "T1",
  audience: "internal",
};

async function copySessionFactsAgain(url: string): Promise<string[]> {
  const raw = new pg.Pool({ connectionString: url, max: 1 });
  const warnings: string[] = [];
  raw.on("connect", (client) => client.on("notice", (notice) => warnings.push(notice.message ?? "")));
  try {
    await raw.query(
      "ALTER TABLE sessions DROP COLUMN slack_binding, DROP COLUMN runtime; UPDATE sessions SET spawn_meta = NULL; DELETE FROM qm_schema_migrations WHERE id LIKE 'sessions/store/005_-session-facts%'",
    );
    await applyPgMigrations(
      raw,
      SESSION_MIGRATIONS.filter((m) => m.id.includes("-session-facts")).map(definePgMigration),
    );
  } finally {
    await raw.end();
  }
  return warnings;
}

function request(threadRef: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput {
  const conversation: Conversation = { kind: "dm", threadRef, audience: [actor] };
  return { actor, conversation, surface: "slack", origin: { kind: "human", messageTs: "1.1" }, text: "hi", ...extra };
}

test("a session keeps the Slack binding it was created with and follows its latest context", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const first = request("slack:dm:facts");
  const created = await sessions.getOrCreateByThread("slack:dm:facts", "dm", scope, undefined, "slack", undefined, {
    surfaceBinding: binding,
    context: sessionContextOf(first),
  });
  assert.deepEqual(created.surfaceBinding, binding);
  assert.deepEqual(created.spawnMeta?.origin, { kind: "human" });
  const later = request("slack:dm:facts", { timezone: "America/Los_Angeles" });
  await sessions.getOrCreateByThread("slack:dm:facts", "dm", scope, undefined, "slack", undefined, {
    surfaceBinding: { ...binding, author: { ...binding.author, account: "A3" } },
    context: sessionContextOf(later),
  });
  const stored = (await sessions.getByThread("slack:dm:facts"))!;
  assert.deepEqual(stored.surfaceBinding, binding);
  assert.equal(stored.spawnMeta?.timezone, "America/Los_Angeles");
  await sessions.setRuntime(stored.id, { modelId: "m1", label: "Model One" });
  assert.deepEqual((await sessions.get(stored.id))?.runtime, { modelId: "m1", label: "Model One" });
});

test("a session ended in failure while its newest item is an error", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const failed = await sessions.getOrCreateByThread("web:U1:failed", "dm", scope);
  const recovered = await sessions.getOrCreateByThread("web:U1:recovered", "dm", scope);
  for (const session of [failed, recovered]) {
    const writer = { sessionId: session.id };
    await sessions.append(writer, { kind: "UserMessage", text: "go", author: actor.id });
    await sessions.append(writer, { kind: "Error", errorCode: "turn_failure", text: "boom" });
    if (session === recovered) await sessions.append(writer, { kind: "AgentMessage", text: "done" });
  }
  assert.deepEqual(await sessions.endedInFailure([failed.id, recovered.id, "missing"]), new Set([failed.id]));
});

test("the session facts migration copies each conversation's facts from its latest runs", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const runtime = createPostgresRunStore(url);
  const { runs } = runtime;
  const finish = async (threadRef: string, input: OrchestratorInput, runtime?: { modelId: string }) => {
    const { run } = await runs.enqueue({ sessionId: threadRef, request: input });
    const lease = (await runs.claimById(run.id, "w", 60_000))!.leaseToken!;
    await runs.complete(run.id, lease, { status: "ok", reply: "ok", ...(runtime ? { runtime } : {}) });
  };
  const slack = await sessions.getOrCreateByThread("slack:dm:old", "dm", scope, undefined, "slack");
  const publicTurn = request(slack.threadRef, {
    ...previousRelease,
    surfaceTools: true,
    deliveryTarget: "D1",
    deliveryCandidates: [{ target: "D1", label: "DM" }],
    model: "m1",
    fastMode: false,
    readOnly: false,
  });
  await finish(slack.threadRef, publicTurn, { modelId: "m1" });
  await finish(
    slack.threadRef,
    request(slack.threadRef, { ...previousRelease, privateSessionMessage: true, timezone: "UTC" }),
    { modelId: "m2" },
  );
  const cron = await sessions.getOrCreateByThread("cron:c1:fire:1", "dm", scope, undefined, "web");
  const fired = request(cron.threadRef, {
    surface: "web",
    origin: { kind: "automation", screenData: "fire", destination: { type: "slack", target: "D1" } },
  });
  await finish(cron.threadRef, fired);
  const relayed = await sessions.getOrCreateByThread("web:U1:relayed", "dm", scope, undefined, "web");
  await finish(relayed.threadRef, request(relayed.threadRef, { surface: "web", sessionSenderId: "s1" }), {
    modelId: "m3",
  });
  const quiet = await sessions.getOrCreateByThread("web:U1:quiet", "dm", scope, undefined, "web");
  const mixed = await sessions.getOrCreateByThread("slack:dm:mixed", "dm", scope, undefined, "slack");
  const owning = request(mixed.threadRef, previousRelease);
  await finish(mixed.threadRef, owning, { modelId: "m4" });
  await finish(mixed.threadRef, request(mixed.threadRef, { sessionSenderId: "s1" }));

  await copySessionFactsAgain(url);

  const filled = (await sessions.get(slack.id))!;
  assert.equal(filled.surfaceBinding, undefined, "a binding in the previous release's shape reads as unbound");
  const copied = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const bindings = await copied.query<{ id: string; slack_binding: unknown }>(
      "SELECT id, slack_binding FROM sessions WHERE id = ANY($1)",
      [[slack.id, mixed.id]],
    );
    assert.deepEqual(
      Object.fromEntries(bindings.rows.map((r) => [r.id, r.slack_binding])),
      { [slack.id]: slackSource, [mixed.id]: slackSource },
      "boot copies each binding from the newest run that has one, in the previous release's shape",
    );
  } finally {
    await copied.end();
  }
  assert.deepEqual(filled.runtime, { modelId: "m2" });
  assert.deepEqual(filled.spawnMeta, sessionContextOf(publicTurn));
  assert.deepEqual((await sessions.get(cron.id))?.spawnMeta, sessionContextOf(fired));
  const sessionTurn = (await sessions.get(relayed.id))!;
  assert.deepEqual(sessionTurn.runtime, { modelId: "m3" });
  assert.equal(sessionTurn.spawnMeta, undefined);
  const mixedFilled = (await sessions.get(mixed.id))!;
  assert.deepEqual(mixedFilled.runtime, { modelId: "m4" }, "the label comes from the newest run that reported one");
  assert.deepEqual(mixedFilled.spawnMeta, sessionContextOf(owning), "context comes from the newest owning turn");
  const untouched = (await sessions.get(quiet.id))!;
  assert.equal(untouched.surfaceBinding ?? untouched.runtime ?? untouched.spawnMeta, undefined);
  await runtime.close?.();
});

test("the session facts copy skips runs an earlier release stored as JSON jsonb rejects", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const runtime = createPostgresRunStore(url);
  const { runs } = runtime;
  const raw = new pg.Pool({ connectionString: url, max: 1 });
  const finishAsEarlierRelease = async (
    threadRef: string,
    input: OrchestratorInput,
    reply: string,
    modelId: string,
  ) => {
    const { run } = await runs.enqueue({ sessionId: threadRef, request: input });
    const lease = (await runs.claimById(run.id, "w", 60_000))!.leaseToken!;
    const result = { status: "ok" as const, reply, runtime: { modelId } };
    await runs.complete(run.id, lease, result);
    await raw.query("UPDATE runs SET request = $2, result = $3 WHERE id = $1", [
      run.id,
      JSON.stringify(input),
      JSON.stringify(result),
    ]);
    return run.id;
  };
  try {
    const session = await sessions.getOrCreateByThread("slack:dm:unreadable", "dm", scope, undefined, "slack");
    const readable = request(session.threadRef, { ...previousRelease, timezone: "UTC" });
    const readableRun = await finishAsEarlierRelease(session.threadRef, readable, "ok", "m1");
    const pasted = request(session.threadRef, { ...previousRelease, text: "pasted \u0000" });
    const pastedRun = await finishAsEarlierRelease(
      session.threadRef,
      pasted,
      "Markets error: \u0015\u0003\u0000",
      "m2",
    );
    const cut = request(session.threadRef, { text: "cut \ud83d" });
    const cutRun = await finishAsEarlierRelease(session.threadRef, cut, "cut \ud83d", "m3");

    const warnings = await copySessionFactsAgain(url);

    const named = (id: string) => warnings.some((warning) => warning.includes(`skipped run ${id}:`));
    assert.deepEqual([pastedRun, cutRun, readableRun].map(named), [true, true, false], "each skipped run is named");
    const filled = (await sessions.get(session.id))!;
    assert.deepEqual(filled.runtime, { modelId: "m1" }, "runs jsonb cannot read are skipped, not fatal");
    assert.deepEqual(filled.spawnMeta, sessionContextOf(readable), "context comes from the newest readable turn");
    const { rows } = await raw.query<{ slack_binding: unknown }>("SELECT slack_binding FROM sessions WHERE id = $1", [
      session.id,
    ]);
    assert.deepEqual(rows[0]?.slack_binding, slackSource);
  } finally {
    await raw.end();
    await runtime.close?.();
  }
});
