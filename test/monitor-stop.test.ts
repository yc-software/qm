import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

async function fixture(project: boolean) {
  const built = buildApp(testConfig({ backgroundWorkEnabled: false }));
  const actor = "U1";
  await built.app.upsertDirectory([{ principalId: actor, displayName: "Alex", type: "internal" }]);
  const group = project ? await built.app.createProject(actor, "Test project") : null;
  const scope = group?.scopeId ?? scopeId("personal", actor);
  const threadRef = "monitor-test";
  const conversation: TurnRequest["conversation"] = group
    ? { kind: "group", threadRef, channelRef: group.scopeId.slice("group:".length) }
    : { kind: "dm", threadRef };
  const session = await built.sessions.getOrCreateByThread(threadRef, conversation.kind, scope, undefined, "web");
  await built.sessions.addParticipant(session.id, actor);
  const arm = () =>
    built.monitors.create({
      owner: actor,
      createdBy: actor,
      ownerScopeId: scope,
      threadRef,
      processId: "background-job",
      command: "npm test",
      expiresAt: Date.now() + 60_000,
    });
  const request: TurnRequest = {
    surface: "monitor",
    actor: { externalId: actor },
    conversation,
    text: "background job completed",
    triggered: true,
    async: true,
    idempotencyKey: "monitor-fire",
  };
  return { ...built, actor, arm, request, threadRef };
}

for (const project of [false, true]) {
  test(`${project ? "project" : "personal"} Stop rejects an in-flight monitor update and permits a fresh watch`, async () => {
    const f = await fixture(project);
    const monitor = await f.arm();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refresh = f.identity.refresh;
    f.identity.refresh = async () => {
      await refresh();
      entered.resolve();
      await release.promise;
    };
    const pending = f.app.turn(f.request, { monitorId: monitor.id });
    await entered.promise;
    try {
      assert.equal(await f.app.stopConversation(f.threadRef, f.actor), true);
    } finally {
      release.resolve();
      f.identity.refresh = refresh;
    }
    assert.equal((await pending).status, "silent");
    assert.equal((await f.runs.inFlightForThread(f.threadRef)).length, 0);
    const fresh = await f.arm();
    assert.notEqual(fresh.id, monitor.id);
    assert.equal((await f.app.turn(f.request, { monitorId: monitor.id })).status, "silent");
    const queued = await f.app.turn(f.request, { monitorId: fresh.id });
    assert.equal(queued.status, "queued");
    const repeated = await f.app.turn(f.request, { monitorId: fresh.id });
    assert.equal(repeated.runId, queued.runId);
    assert.equal((await f.runs.inFlightForThread(f.threadRef)).length, 1);
    assert.equal(await f.app.stopConversation(f.threadRef, f.actor), true);
    assert.equal((await f.runs.inFlightForThread(f.threadRef)).length, 0);
  });
}

test("Stop waits for monitor admission and cancels the admitted run before returning", async () => {
  const f = await fixture(false);
  const monitor = await f.arm();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const enqueue = f.runs.enqueue;
  f.runs.enqueue = async (input) => {
    entered.resolve();
    await release.promise;
    return enqueue(input);
  };
  const wake = f.app.turn(f.request, { monitorId: monitor.id });
  await entered.promise;
  let stopped = false;
  const stop = f.app.stopConversation(f.threadRef, f.actor).then((result) => {
    stopped = true;
    return result;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
  } finally {
    release.resolve();
  }
  assert.equal((await wake).status, "queued");
  assert.equal(await stop, true);
  assert.equal((await f.runs.inFlightForThread(f.threadRef)).length, 0);
  assert.equal((await f.monitors.get(monitor.id))!.enabled, false);
});
