import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectGroupRef } from "../src/projects/project-store.ts";
import type { Conversation, Principal } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("human child replay keeps one receipt across acknowledgement failure and a project roster change", async (t) => {
  const built = buildApp(testConfig({ openaiApiKey: "test-openai-key" }));
  built.config.setApprovedHarnesses(["pi", "codex"]);
  await built.app.upsertDirectory(
    ["owner", "sender", "new-member"].map((principalId) => ({
      principalId,
      displayName: principalId,
      type: "internal" as const,
    })),
  );
  const project = await built.app.createProject("owner", "Replay receipt");
  assert.ok(project);
  built.config.setWebuiModels(`org:${project.orgId}`, ["gpt-5.5"]);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "sender")).status, "ok");
  const channelRef = projectGroupRef(project.id);
  const version = await built.projects.version(channelRef);
  assert.ok(version);
  const child = await built.sessions.getOrCreateByThread(
    "agent:main:subagent:human-replay-receipt",
    "group",
    project.scopeId,
  );
  const actor: Principal = { id: "owner", type: "internal" };
  const conversation: Conversation = {
    kind: "group",
    channelRef,
    threadRef: child.threadRef,
    audience: [actor, { id: "sender", type: "internal" }],
  };
  for (const id of ["owner", "sender"]) await built.sessions.addParticipant(child.id, id);
  await built.sessions.setSpawnMeta(child.id, { surface: "web", actor, conversation });
  const options = {
    model: "gpt-5.5",
    harness: "codex",
    thinkingLevel: "high",
    fastMode: true,
    timezone: "Europe/London",
  };
  const { run } = await built.runs.enqueue({
    sessionId: child.threadRef,
    request: {
      actor,
      conversation,
      text: "Original delegated task",
      origin: { kind: "direct" },
      scopeVersion: version,
      sessionParticipantIds: ["owner", "sender"],
      ...options,
    },
  });
  const claimed = await built.runs.claimById(run.id, "test-worker", 60_000);
  assert.ok(claimed?.leaseToken);
  await built.runs.complete(run.id, claimed.leaseToken, { status: "ok", reply: "Finished" });
  await built.signals.send(run.id, {
    kind: "steer",
    text: "Please continue the investigation",
    request: {
      surface: "web",
      actor: { externalId: "sender" },
      conversation: {
        kind: "group",
        channelRef,
        threadRef: child.threadRef,
        audience: [],
      },
      text: "Please continue the investigation",
    },
  });
  const [receipt] = await built.signals.pending(run.id);
  assert.ok(receipt);
  const acknowledge = built.signals.acknowledge.bind(built.signals);
  t.mock.method(built.signals, "acknowledge", async () => {
    throw new Error("acknowledgement storage unavailable");
  });
  await assert.rejects(built.app.replayOrphanedRunSignals(run.id), /acknowledgement storage unavailable/);
  const [firstReplay, unexpected] = await built.runs.inFlightForThread(child.threadRef);
  assert.ok(firstReplay);
  assert.equal(unexpected, undefined);
  assert.equal(firstReplay.request.actor.id, "sender");
  assert.equal(firstReplay.request.scopeVersion, version);
  for (const [key, value] of Object.entries(options))
    assert.equal(firstReplay.request[key as keyof typeof options], value, key);
  assert.equal((await built.signals.pending(run.id)).length, 1);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "new-member")).status, "ok");
  assert.notEqual(await built.projects.version(channelRef), version);
  built.signals.acknowledge = acknowledge;
  await built.app.replayOrphanedRunSignals(run.id);
  assert.deepEqual(
    (await built.runs.inFlightForThread(child.threadRef)).map((candidate) => candidate.id),
    [firstReplay.id],
  );
  assert.deepEqual(await built.signals.pending(run.id), []);
  await built.app.replayOrphanedRunSignals(run.id);
  assert.equal((await built.runs.inFlightForThread(child.threadRef)).length, 1);
});

test("late child signals remain pending behind approval and requestless steers replay once", async (t) => {
  const built = buildApp(testConfig());
  const actor: Principal = { id: "sender", type: "internal" };
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:late-review", "dm", "personal:sender");
  const conversation: Conversation = { kind: "dm", threadRef: child.threadRef, audience: [actor] };
  const { run } = await built.runs.enqueue({
    sessionId: child.threadRef,
    request: { actor, conversation, text: "task", origin: { kind: "automation" } },
  });
  const claimed = await built.runs.claimById(run.id, "test", 30_000);
  assert.ok(claimed?.leaseToken);
  await built.runs.complete(run.id, claimed.leaseToken, { status: "ok" });
  await built.signals.send(run.id, {
    kind: "steer",
    text: "human followup",
    request: {
      surface: "web",
      actor: { externalId: actor.id },
      conversation: { kind: "dm", threadRef: child.threadRef },
      text: "human followup",
    },
  });
  const turn = built.app.turn;
  t.mock.method(built.app, "turn", async () => ({ status: "pending_approval", sessionId: child.id }));
  await built.app.replayOrphanedRunSignals(run.id);
  assert.equal((await built.signals.pending(run.id)).length, 1);
  t.mock.method(built.app, "turn", async () => ({ status: "refused", reason: "access revoked" }));
  await built.app.replayOrphanedRunSignals(run.id);
  assert.equal((await built.signals.pending(run.id)).length, 0);
  built.app.turn = turn;
  await built.signals.send(run.id, { kind: "steer", text: "requestless followup" });
  await built.app.replayOrphanedRunSignals(run.id);
  await built.app.replayOrphanedRunSignals(run.id);
  const queued = await built.runs.inFlightForThread(child.threadRef);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.request.text, "requestless followup");
  assert.equal(queued[0]!.request.origin.kind, "automation");
  assert.equal((await built.signals.pending(run.id)).length, 0);
});
