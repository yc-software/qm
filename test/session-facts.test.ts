import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { sessionContextOf } from "../src/sessions/session-syscalls.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { TurnSurfaceOrigin } from "../src/surfaces/contract.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const actor: Principal = { id: "U1", type: "internal" };
const scope = scopeId("personal", "U1");
const binding: TurnSurfaceOrigin = {
  author: { surface: "slack", account: "A2", id: "U1" },
  workspace: "T1",
  audience: "internal",
};

function request(threadRef: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput {
  const conversation: Conversation = { kind: "dm", threadRef, audience: [actor] };
  return { actor, conversation, surface: "slack", origin: { kind: "human", messageTs: "1.1" }, text: "hi", ...extra };
}

test("a session keeps the Slack binding it was created with and follows its latest context", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const first = request("slack:dm:facts");
  const created = await sessions.getOrCreateByThread("slack:dm:facts", "dm", scope, undefined, "slack", {
    surfaceBinding: binding,
    context: sessionContextOf(first),
  });
  assert.deepEqual(created.surfaceBinding, binding);
  assert.deepEqual(created.spawnMeta?.origin, { kind: "human" });
  const later = request("slack:dm:facts", { timezone: "America/Los_Angeles" });
  await sessions.getOrCreateByThread("slack:dm:facts", "dm", scope, undefined, "slack", {
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
