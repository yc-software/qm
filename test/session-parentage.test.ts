import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { ScopeId } from "../src/types.ts";

test("session parentage requires current membership and rejects cycles and scope changes", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-parentage-")) }));
  await built.app.upsertDirectory([{ principalId: "U1", displayName: "User One", type: "internal" }]);
  const channels = [{ channelId: "C1", name: "private", isPrivate: true }];
  await built.app.upsertChannels(channels, [{ channelId: "C1", principalId: "U1" }]);
  const create = async (name: string, scope: ScopeId = "channel:C1") => {
    const session = await built.sessions.getOrCreateByThread(`agent:main:subagent:${name}`, "channel", scope);
    await built.sessions.addParticipant(session.id, "U1");
    await built.sessions.setSpawnMeta(session.id, {
      surface: "slack",
      actor: { id: "U1", type: "internal" },
      conversation: {
        kind: "channel",
        threadRef: "ch:C1",
        channelRef: "C1",
        audience: [{ id: "U1", type: "internal" }],
      },
    });
    return session;
  };
  const parent = await create("parent");
  const child = await create("child");
  const otherScope = await create("other", "personal:U1");
  assert.deepEqual(await built.app.adoptSession(child.id, parent.id, "U1"), { adopted: true });
  assert.equal(await built.app.adoptSession(parent.id, child.id, "U1"), null);
  assert.equal(await built.app.adoptSession(child.id, otherScope.id, "U1"), null);
  await built.app.upsertChannels(channels, [], Date.now() + 1, ["C1"]);
  assert.equal(await built.app.detachSession(child.id, "U1"), null);
  assert.equal(await built.app.adoptSession(child.id, parent.id, "U1"), null);
  assert.equal((await built.sessions.get(child.id))?.parentSessionId, parent.id);
  await built.app.upsertChannels(channels, [{ channelId: "C1", principalId: "U1" }], Date.now() + 2, ["C1"]);
  assert.deepEqual(await built.app.detachSession(child.id, "U1"), { detached: true });
});

test("direct child enqueues share the tree cap across concurrent callers", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-cap-")) }));
  const root = await built.sessions.getOrCreateByThread("web:U1:root", "dm", "personal:U1");
  const children = await Promise.all(
    Array.from({ length: 11 }, async (_, i) => {
      const child = await built.sessions.getOrCreateByThread(`agent:main:subagent:cap-${i}`, "dm", "personal:U1");
      await built.sessions.setParentSession(child.id, root.id);
      return child;
    }),
  );
  const outcomes = await Promise.allSettled(
    children.map((child) =>
      built.runs.enqueue({
        sessionId: child.threadRef,
        maxAttempts: 3,
        request: {
          actor: { id: "U1", type: "internal" },
          conversation: { kind: "dm", threadRef: child.threadRef, audience: [{ id: "U1", type: "internal" }] },
          text: "work",
          origin: { kind: "direct" },
        },
      }),
    ),
  );
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 10);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.match(String(rejected.reason), /all 10 session run slots are in use/);
});

test("a late child steer remains pending when admission fails, then replays once", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-signal-retry-")) }));
  const root = await built.sessions.getOrCreateByThread("web:U1:signal-root", "dm", "personal:U1");
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:signal-child", "dm", "personal:U1");
  await built.sessions.setParentSession(child.id, root.id);
  const request = {
    actor: { id: "U1", type: "internal" as const },
    conversation: {
      kind: "dm" as const,
      threadRef: child.threadRef,
      audience: [{ id: "U1", type: "internal" as const }],
    },
    text: "work",
    origin: { kind: "direct" as const },
  };
  const { run } = await built.runs.enqueue({ sessionId: child.threadRef, request });
  const claimed = await built.runs.claimById(run.id, "worker", 60_000);
  await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const full = [];
  for (let i = 0; i < 10; i++) full.push((await built.runs.enqueue({ sessionId: child.threadRef, request })).run);
  await built.signals.send(run.id, {
    kind: "steer",
    text: "late update",
    sessionRequest: { ...request, text: "late update" },
  });
  await assert.rejects(built.app.replayOrphanedRunSignals(run.id), /slots/);
  assert.equal((await built.signals.pending(run.id)).length, 1);
  await built.runs.withdraw(full[0]!.id);
  await built.app.replayOrphanedRunSignals(run.id);
  const replays = (await built.runs.inFlightForThread(child.threadRef)).filter((candidate) =>
    candidate.dedupKey?.startsWith("session-signal:"),
  );
  assert.equal(replays.length, 1);
  assert.equal(replays[0]!.request.text, "late update");
  assert.deepEqual(await built.signals.pending(run.id), []);
  await built.app.replayOrphanedRunSignals(run.id);
  assert.equal(
    (await built.runs.inFlightForThread(child.threadRef)).filter((candidate) =>
      candidate.dedupKey?.startsWith("session-signal:"),
    ).length,
    1,
  );
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
