import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId, type Principal } from "../src/types.ts";

const actor: Principal = { id: "U1", type: "internal" };
const scope = scopeId("personal", "U1");

test("a child's turn carries its placement note in the system prompt", async () => {
  const built = buildApp(testConfig());
  await built.featureFlags.setEnabled("persistent_subagents", scope, true, "admin");
  const room = await built.sessions.getOrCreateByThread("web:room", "dm", scope, undefined, "web");
  await built.sessions.addParticipant(room.id, actor.id);
  const syscalls = built.sessionSyscalls.forTurn({
    session: room,
    scopeId: scope,
    request: { surface: "web", conversation: { kind: "dm", threadRef: "web:room", audience: [actor] }, actor },
  });
  const plain = await syscalls.open({ task: "say hello" });
  const isolated = await syscalls.open({ task: "say hello", isolation: "worktree" });
  assert.ok(plain.ok && isolated.ok);
  const workdir = isolated.isolation?.workdir;
  assert.ok(workdir);
  built.runtime.start();
  for (const sessionId of [plain.sessionId, isolated.sessionId]) {
    const child = await built.sessions.get(sessionId);
    assert.ok(child);
    for (const run of await built.runs.inFlightForThread(child.threadRef))
      assert.equal((await built.runs.waitFor(run.id, 30_000)).status, "done");
  }
  const prompts = async (sessionId: string) => JSON.stringify(await built.sessions.listLlmRequests(sessionId));
  assert.ok((await prompts(isolated.sessionId)).includes(workdir));
  assert.doesNotMatch(await prompts(plain.sessionId), /subagents\//);
});
