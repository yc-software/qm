import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("detaching a subagent session requires current channel membership", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-parentage-")) }));
  await built.app.upsertDirectory([{ principalId: "U1", displayName: "User One", type: "internal" }]);
  const channels = [{ channelId: "C1", name: "private", isPrivate: true }];
  await built.app.upsertChannels(channels, [{ channelId: "C1", principalId: "U1" }]);
  const create = async (name: string) => {
    const session = await built.sessions.getOrCreateByThread(`agent:main:subagent:${name}`, "channel", "channel:C1");
    await built.sessions.addParticipant(session.id, "U1");
    return session;
  };
  const parent = await create("parent");
  const child = await create("child");
  await built.sessions.setParentSession(child.id, parent.id);
  await built.app.upsertChannels(channels, [], Date.now() + 1, ["C1"]);
  assert.equal(await built.app.detachSession(child.id, "U1"), null);
  assert.equal((await built.sessions.get(child.id))?.parentSessionId, parent.id);
  await built.app.upsertChannels(channels, [{ channelId: "C1", principalId: "U1" }], Date.now() + 2, ["C1"]);
  assert.deepEqual(await built.app.detachSession(child.id, "U1"), { detached: true });
});

test("late human child messages retain their sender and revalidate access", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-human-replay-")) }));
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "User One", type: "internal" },
    { principalId: "U2", displayName: "User Two", type: "internal" },
  ]);
  const channels = [{ channelId: "C1", name: "shared", isPrivate: true }];
  await built.app.upsertChannels(
    channels,
    ["U1", "U2"].map((principalId) => ({ channelId: "C1", principalId })),
  );
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:human-replay", "channel", "channel:C1");
  for (const id of ["U1", "U2"]) await built.sessions.addParticipant(child.id, id);
  const actor = { id: "U1", type: "internal" as const };
  const conversation = {
    kind: "channel" as const,
    channelRef: "C1",
    threadRef: child.threadRef,
    audience: [actor, { id: "U2", type: "internal" as const }],
  };
  await built.sessions.setSpawnMeta(child.id, { surface: "web", actor, conversation });
  const { run } = await built.runs.enqueue({
    sessionId: child.threadRef,
    request: { actor, conversation, text: "original", origin: { kind: "direct" } },
  });
  const claimed = await built.runs.claimById(run.id, "worker", 60_000);
  await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const send = async (text: string) => {
    await built.signals.send(run.id, {
      kind: "steer",
      text,
      request: {
        surface: "web",
        actor: { externalId: "U2" },
        conversation: { ...conversation, audience: [{ externalId: "U1" }, { externalId: "U2" }] },
        text,
      },
    });
    await built.app.replayOrphanedRunSignals(run.id);
  };
  await send("from second user");
  const replay = await built.runs.activeForThread(child.threadRef);
  assert.equal(replay?.request.actor.id, "U2");
  assert.equal(replay?.request.text, "from second user");
  await built.runs.withdraw(replay!.id);
  await built.app.upsertChannels(channels, [{ channelId: "C1", principalId: "U1" }], Date.now() + 1, ["C1"]);
  await send("after revocation");
  assert.equal(await built.runs.activeForThread(child.threadRef), null);
  assert.deepEqual(await built.signals.pending(run.id), []);
});

test("ordinary sessions are not subject to the subagent tree queue limit", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ordinary-queue-")) }));
  const actor = { id: "U1", type: "internal" as const };
  const session = await built.sessions.getOrCreateByThread("web:U1:ordinary-queue", "dm", "personal:U1");
  assert.equal(await built.featureFlags.enabled("persistent_subagents", "personal:U1"), false);
  for (let i = 0; i < 11; i++) {
    await built.runs.enqueue({
      sessionId: session.threadRef,
      request: {
        actor,
        conversation: { kind: "dm", threadRef: session.threadRef, audience: [actor] },
        text: `ordinary task ${i}`,
        origin: { kind: "human" },
      },
    });
  }
  assert.equal((await built.runs.inFlightForThread(session.threadRef)).length, 11);
});

test("a subagent message that missed its running turn replays as a turn from its sender", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-message-replay-")) }));
  await built.app.upsertDirectory([{ principalId: "U1", displayName: "User One", type: "internal" }]);
  const parent = await built.sessions.getOrCreateByThread("web:U1:parent", "dm", "personal:U1");
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:late-message", "dm", "personal:U1");
  for (const session of [parent, child]) await built.sessions.addParticipant(session.id, "U1");
  await built.sessions.setParentSession(child.id, parent.id);
  const actor = { id: "U1", type: "internal" as const };
  const conversation = { kind: "dm" as const, threadRef: child.threadRef, audience: [actor] };
  await built.sessions.setSpawnMeta(child.id, { surface: "web", actor, conversation });
  const { run } = await built.runs.enqueue({
    sessionId: child.threadRef,
    request: { actor, conversation, text: "task", origin: { kind: "direct" } },
  });
  const claimed = await built.runs.claimById(run.id, "worker", 60_000);
  await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const stamped = `<subagent-message from="lead" fromSessionId="${parent.id}">\nuse v2\n</subagent-message>`;
  await built.signals.send(run.id, {
    kind: "steer",
    text: "use v2",
    request: {
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: child.threadRef, audience: [{ externalId: "U1" }] },
      origin: { kind: "automation", screenData: stamped },
      text: stamped,
      displayText: "use v2",
      sessionSenderId: parent.id,
      spawned: true,
    },
  });
  await built.app.replayOrphanedRunSignals(run.id);
  const replay = await built.runs.activeForThread(child.threadRef);
  assert.equal(replay?.request.text, stamped);
  assert.equal(replay?.request.sessionSenderId, parent.id);
  assert.deepEqual(await built.signals.pending(run.id), []);
});
