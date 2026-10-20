import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { SUBAGENT_TREE_RUN_CAP } from "../src/sessions/session-syscalls.ts";
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

test("listing shared-scope subagents checks current write permission once per scope", async (t) => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-list-permissions-")) }));
  try {
    await built.app.upsertDirectory([{ principalId: "U1", displayName: "User One", type: "internal" }]);
    const scopes = [
      { kind: "channel", id: "C-list-permissions" },
      { kind: "group", id: "G-list-permissions" },
    ] as const;
    const childrenPerScope = 24;
    for (const { kind, id } of scopes) {
      for (let i = 0; i <= childrenPerScope; i++) {
        const threadRef = i === 0 ? `web:U1:${id}` : `agent:main:subagent:${id}:${i}`;
        const session = await built.sessions.getOrCreateByThread(threadRef, kind, `${kind}:${id}`);
        await built.sessions.addParticipant(session.id, "U1", `Shared session ${i}`);
      }
    }
    const reads = t.mock.method(built.directory, "get");
    const channelChecks = t.mock.method(built.directory, "channelMember");
    const groupChecks = t.mock.method(built.directory, "groupMember");
    const counts = [];
    for (const channelMember of [false, true, false]) {
      const groupMember = !channelMember;
      await built.directory.replaceChannels(
        [{ channelId: scopes[0].id, name: "public", isPrivate: false }],
        channelMember ? [{ channelId: scopes[0].id, principalId: "U1" }] : [],
      );
      await built.directory.replaceGroups(
        groupMember ? [{ groupId: scopes[1].id, principalId: "U1" }] : [],
        undefined,
        [scopes[1].id],
        [scopes[1].id],
      );
      reads.mock.resetCalls();
      channelChecks.mock.resetCalls();
      groupChecks.mock.resetCalls();
      const sessions = await built.app.listSessions("U1");
      assert.equal(sessions.length, scopes.length * (childrenPerScope + 1));
      for (const session of sessions) {
        const inChannel = session.scopeId === `channel:${scopes[0].id}`;
        const expected = inChannel ? session.threadRef.startsWith("web:") || channelMember : groupMember;
        assert.equal(session.canContinue, expected, `${session.threadRef} uses this request's membership`);
      }
      counts.push({
        reads: reads.mock.callCount(),
        channelChecks: channelChecks.mock.callCount(),
        groupChecks: groupChecks.mock.callCount(),
      });
    }
    assert.ok(
      counts.every(({ reads, channelChecks, groupChecks }) => reads <= 4 && channelChecks <= 2 && groupChecks <= 2),
      `ordinary web and subagent checks stay bounded per scope on every request: ${JSON.stringify(counts)}`,
    );
  } finally {
    await built.runtime.stop();
  }
});

test("direct child enqueues share the tree cap across concurrent callers", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-cap-")) }));
  const root = await built.sessions.getOrCreateByThread("web:U1:root", "dm", "personal:U1");
  const children = await Promise.all(
    Array.from({ length: SUBAGENT_TREE_RUN_CAP + 1 }, async (_, i) => {
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
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, SUBAGENT_TREE_RUN_CAP);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.match(String(rejected.reason), new RegExp(`all ${SUBAGENT_TREE_RUN_CAP} session run slots are in use`));
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
  for (let i = 0; i < SUBAGENT_TREE_RUN_CAP; i++)
    full.push((await built.runs.enqueue({ sessionId: child.threadRef, request })).run);
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
