import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFeatureFlagStore, type FeatureFlagRecord } from "../src/feature-flags.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import type { Run, RunStore } from "../src/runs/run-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { DirectoryStore } from "../src/directory/directory-store.ts";
import { scopeId, type ScopeId, type Session, type TurnRequest, type TurnResult } from "../src/types.ts";
import { jqChildEnv } from "../src/config.ts";
import { createPeerDirectory } from "../src/coordination/peer-directory.ts";
import { createMemoryMessageBoardStore } from "../src/coordination/memory-message-board-store.ts";
import { createMemorySwarmStore } from "../src/coordination/memory-swarm-store.ts";
import { createCoordinationService, type CoordinationCaller } from "../src/coordination/coordination-service.ts";
import { createPeerDispatcher } from "../src/coordination/peer-dispatcher.ts";
import { evaluateAudience } from "../src/coordination/jq-audience.ts";
import { DEFAULT_MAX_CHILDREN_PER_PARENT, type PeerIdentity } from "../src/coordination/types.ts";

const FLAG = "peer_coordination";
const ALICE = scopeId("personal", "alice");
const BOB = scopeId("personal", "bob");

interface FakeSessions extends SessionStore {
  seed(session: { id: string; threadRef: string; scopeId: ScopeId }, participants: string[]): void;
}

function fakeSessions(): FakeSessions {
  const byId = new Map<string, Session>();
  const participants = new Map<string, string[]>();
  const store = {
    seed(session: { id: string; threadRef: string; scopeId: ScopeId }, members: string[]) {
      byId.set(session.id, { ...session, type: "dm", createdAt: 0 });
      participants.set(session.id, members);
    },
    async get(sessionId: string) {
      return byId.get(sessionId) ?? null;
    },
    async getByThread(threadRef: string) {
      return [...byId.values()].find((session) => session.threadRef === threadRef) ?? null;
    },
    async participantsOf(sessionId: string) {
      return participants.get(sessionId) ?? [];
    },
    async deleteSession(sessionId: string) {
      byId.delete(sessionId);
      participants.delete(sessionId);
    },
  };
  return store as unknown as FakeSessions;
}

interface FakeRuns extends RunStore {
  seed(run: Partial<Run> & { id: string; sessionId: string }): Run;
  withdrawn: string[];
}

function fakeRuns(): FakeRuns {
  const byId = new Map<string, Run>();
  const withdrawn: string[] = [];
  const store = {
    withdrawn,
    seed(run: Partial<Run> & { id: string; sessionId: string }) {
      const full = { status: "pending", dedupKey: null, ...run } as Run;
      byId.set(full.id, full);
      return full;
    },
    async get(runId: string) {
      return byId.get(runId) ?? null;
    },
    async getByDedupKey(dedupKey: string) {
      return [...byId.values()].find((run) => run.dedupKey === dedupKey) ?? null;
    },
    async inFlightForThread(threadRef: string) {
      return [...byId.values()].filter((run) => run.sessionId === threadRef && run.status !== "done");
    },
    async withdraw(runId: string) {
      const run = byId.get(runId);
      if (!run || run.status !== "pending") return false;
      withdrawn.push(runId);
      byId.delete(runId);
      return true;
    },
  };
  return store as unknown as FakeRuns;
}

function fakePeopleDirectory(names: Record<string, string>): DirectoryStore {
  return {
    get: async (id: string) => (names[id] ? { id, displayName: names[id] } : null),
  } as unknown as DirectoryStore;
}

async function harness(enabledScopes: ScopeId[] = [ALICE, BOB]) {
  const sessions = fakeSessions();
  const runs = fakeRuns();
  const signals = createMemoryRunSignalStore();
  const identities = createMemoryMap<PeerIdentity>();
  const directory = createPeerDirectory(identities);
  const board = createMemoryMessageBoardStore();
  const swarms = createMemorySwarmStore();
  const featureFlags = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
  for (const scope of enabledScopes) await featureFlags.setEnabled(FLAG, scope, true, "test");

  const spawned: Array<{ principalId: string; scopeId: ScopeId }> = [];
  const spawnFailsAfter = { count: Number.POSITIVE_INFINITY };
  const undeletable = new Set<string>();
  let nextChild = 0;
  const app = {
    async spawnSession(principalId: string, opts: { scopeId: ScopeId; title?: string }) {
      if (spawned.length >= spawnFailsAfter.count) return null;
      const id = `child-${++nextChild}`;
      sessions.seed({ id, threadRef: `web:${principalId}:${id}`, scopeId: opts.scopeId }, [principalId]);
      spawned.push({ principalId, scopeId: opts.scopeId });
      return { session: (await sessions.get(id))! };
    },
    async discardSession(sessionId: string) {
      if (undeletable.has(sessionId)) return false;
      await sessions.deleteSession(sessionId);
      return true;
    },
  };
  let clock = 1_000;
  let ids = 0;
  const service = createCoordinationService({
    directory,
    board,
    swarms,
    sessions,
    runs,
    signals,
    featureFlags,
    app,
    now: () => clock,
    newId: () => `id-${++ids}`,
  });
  return {
    sessions,
    runs,
    signals,
    identities,
    directory,
    board,
    swarms,
    featureFlags,
    service,
    spawned,
    spawnFailsAfter,
    undeletable,
    advance: (ms: number) => (clock += ms),
    at: () => clock,
  };
}

const cap = (sessionId: string | null, actorId: string, runId: string | null = null): CoordinationCaller => ({
  kind: "capability",
  sessionId,
  runId,
  actorId,
});
const SOURCE: CoordinationCaller = { kind: "source" };

async function registeredPeer(
  h: Awaited<ReturnType<typeof harness>>,
  sessionId: string,
  actorId: string,
  scope: ScopeId,
  character: Record<string, unknown> = {},
  participants: string[] = [actorId],
) {
  h.sessions.seed({ id: sessionId, threadRef: `web:${actorId}:${sessionId}`, scopeId: scope }, participants);
  const out = await h.service.registerPeer(cap(sessionId, actorId), {
    sessionId,
    agentName: sessionId,
    character,
  });
  assert.ok(out.ok, JSON.stringify(out));
  return out.value;
}

test("a peer identity is public without leaking the conversation's private surface", async () => {
  const h = await harness();
  h.sessions.seed({ id: "s-a", threadRef: "web:alice:s-a", scopeId: ALICE }, ["alice"]);
  const registered = await h.service.registerPeer(cap("s-a", "alice"), { sessionId: "s-a", agentName: "scout" });
  assert.ok(registered.ok);
  assert.deepEqual(registered.value, {
    sessionId: "s-a",
    agentName: "scout",
    character: {},
    characterVersion: 1,
    parentSessionId: null,
    swarmId: null,
    depth: 0,
    lifecycle: "active",
  });
  const body = JSON.stringify(await h.service.listPeers());
  assert.doesNotMatch(body, /threadRef|web:alice|acme merger/);
});

test("registration authority, scope, and participation are all pinned", async () => {
  const h = await harness();
  h.sessions.seed({ id: "s-a", threadRef: "web:alice:s-a", scopeId: ALICE }, ["alice"]);
  h.sessions.seed({ id: "s-team", threadRef: "web:alice:s-team", scopeId: scopeId("team", "T1") }, ["alice"]);

  const foreign = await h.service.registerPeer(cap("s-other", "alice"), { sessionId: "s-a", agentName: "x" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.status, 403);
  assert.equal(await h.directory.get("s-a"), null, "a refused registration writes no row");

  const team = await h.service.registerPeer(cap("s-team", "alice"), { sessionId: "s-team", agentName: "x" });
  assert.equal(team.ok === false && team.body.error, "unsupported_scope");

  const nonParticipant = await h.service.registerPeer(SOURCE, {
    sessionId: "s-a",
    agentName: "x",
    executionActorId: "mallory",
  });
  assert.equal(nonParticipant.ok === false && nonParticipant.status, 400);
  assert.equal(await h.directory.get("s-a"), null);

  await registeredPeer(h, "s-a", "alice", ALICE);
  const again = await h.service.registerPeer(cap("s-a", "alice"), { sessionId: "s-a", agentName: "other" });
  assert.equal(again.ok === false && again.body.error, "already_registered");
  assert.equal((await h.directory.get("s-a"))!.agentName, "s-a", "the refusal overwrites nothing");
});

test("executionActorId comes from the credential, never from participant ordering", async () => {
  const h = await harness();
  h.sessions.seed({ id: "s-proj", threadRef: "web:carol:s-proj", scopeId: scopeId("group", "P1") }, ["carol", "alice"]);
  const out = await h.service.registerPeer(cap("s-proj", "alice"), { sessionId: "s-proj", agentName: "worker" });
  assert.ok(out.ok);
  assert.equal((await h.directory.get("s-proj"))!.executionActorId, "alice");
});

test("character replacement is versioned and never rewrites identity fields", async () => {
  const h = await harness();
  const peer = await registeredPeer(h, "s-a", "alice", ALICE);
  const before = (await h.directory.get("s-a"))!;

  const missingVersion = await h.service.updateCharacter(cap("s-a", "alice"), "s-a", { character: { role: "worker" } });
  assert.equal(missingVersion.ok === false && missingVersion.status, 400);
  const notObject = await h.service.updateCharacter(cap("s-a", "alice"), "s-a", { character: 7, ifVersion: 1 });
  assert.equal(notObject.ok === false && notObject.status, 400);

  const ok = await h.service.updateCharacter(cap("s-a", "alice"), "s-a", {
    character: { group: "new-feature", role: "worker" },
    ifVersion: peer.characterVersion,
  });
  assert.ok(ok.ok);
  assert.equal(ok.value.characterVersion, 2);

  const stale = await h.service.updateCharacter(cap("s-a", "alice"), "s-a", { character: { role: "x" }, ifVersion: 1 });
  assert.equal(stale.ok === false && stale.body.error, "version_conflict");
  assert.equal(stale.ok === false && stale.body.characterVersion, 2);

  const foreign = await h.service.updateCharacter(cap("s-other", "mallory"), "s-a", {
    character: { role: "lead" },
    ifVersion: 2,
  });
  assert.equal(foreign.ok === false && foreign.status, 403);

  const after = (await h.directory.get("s-a"))!;
  assert.equal(after.scopeId, before.scopeId);
  assert.equal(after.executionActorId, before.executionActorId);
  assert.deepEqual(after.character, { group: "new-feature", role: "worker" });
});

test("a second directory over the same backing map reads the concurrent winner", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE);
  const other = createPeerDirectory(h.identities);
  await h.service.updateCharacter(cap("s-a", "alice"), "s-a", { character: { role: "worker" }, ifVersion: 1 });
  assert.deepEqual((await other.get("s-a"))!.character, { role: "worker" });
});

test("a foreign-org row is excluded from discovery and from the audience snapshot", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE, { group: "new-feature", role: "worker" });
  await h.identities.put("s-foreign", {
    sessionId: "s-foreign",
    orgId: "other-org",
    scopeId: ALICE,
    agentName: "intruder",
    character: { group: "new-feature", role: "worker" },
    characterVersion: 1,
    parentSessionId: null,
    swarmId: null,
    depth: 0,
    executionActorId: "mallory",
    createdAt: 0,
    updatedAt: 0,
  });
  assert.deepEqual(
    (await h.service.listPeers()).map((peer) => peer.sessionId),
    ["s-a"],
  );
  const preview = await h.service.previewAudience(cap("s-a", "alice"), {
    audience: '.[] | select(.group == "new-feature" and .role == "worker")',
  });
  assert.ok(preview.ok);
  assert.deepEqual(preview.value.recipientIds, ["s-a"]);
});

test("the plan's selector, single-addressing and _qm collision all resolve", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE, { group: "new-feature", role: "worker" });
  await registeredPeer(h, "s-b", "bob", BOB, { group: "new-feature", role: "lead" });
  await registeredPeer(h, "s-c", "alice", ALICE, { group: "new-feature", role: "worker", _qm: { keep: 1 } });
  const identities = await h.directory.list();

  assert.deepEqual(await evaluateAudience('.[] | select(.group == "new-feature" and .role == "worker")', identities), {
    ok: true,
    recipientIds: ["s-a", "s-c"],
  });
  assert.deepEqual(await evaluateAudience('.[] | select(._qm.sessionId == "s-b")', identities), {
    ok: true,
    recipientIds: ["s-b"],
  });
  assert.deepEqual(await evaluateAudience(".[] | select(._qm.character._qm.keep == 1)", identities), {
    ok: true,
    recipientIds: ["s-c"],
  });
  assert.deepEqual(await evaluateAudience(".[],.[]", identities), {
    ok: true,
    recipientIds: ["s-a", "s-b", "s-c"],
  });
  assert.deepEqual(await evaluateAudience('.[] | select(.role == "nobody")', identities), {
    ok: true,
    recipientIds: [],
  });
});

test("the evaluator accepts only the frozen candidate objects it handed jq", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE, { role: "worker" });
  const identities = await h.directory.list();
  const hostile = [
    '{"_qm":{"sessionId":"s-a"}}',
    ".[] | {_qm}",
    ".[] | ._qm.sessionId",
    '"s-a"',
    "$__loc__",
    "env",
    'include "escape"; .',
    'import "escape" as e; .',
    "input_filename",
    "-L/tmp/x",
    "--rawfile",
    ".[] | select(",
    "[range(500)] | .[] | {n:.}",
    "while(true; .)",
  ];
  for (const expr of hostile) {
    const out = await evaluateAudience(expr, identities);
    assert.equal(out.ok, false, `${expr} must resolve no recipients`);
  }
  assert.deepEqual(Object.keys(jqChildEnv()), ["PATH"], "no application secret reaches the jq child");
});

test("publication freezes recipients, writes both rows atomically, and never retargets", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE, { group: "new-feature", role: "worker" });
  await registeredPeer(h, "s-b", "bob", BOB, { group: "new-feature", role: "worker" });

  const blank = await h.service.publish(cap("s-a", "alice"), { text: "   ", audience: ".[]" });
  assert.equal(blank.ok === false && blank.status, 400);
  const both = await h.service.publish(cap("s-a", "alice"), { text: "x", audience: ".[]", recipients: ["s-b"] });
  assert.equal(both.ok === false && both.status, 400);
  const neither = await h.service.publish(cap("s-a", "alice"), { text: "x" });
  assert.equal(neither.ok === false && neither.status, 400);
  const unknownReply = await h.service.publish(cap("s-a", "alice"), {
    text: "x",
    recipients: ["s-b"],
    replyTo: "nope",
  });
  assert.equal(unknownReply.ok === false && unknownReply.status, 400);
  assert.deepEqual((await h.service.listMessages({})).messages, [], "every refusal leaves the board empty");

  const published = await h.service.publish(cap("s-a", "alice"), {
    text: "standup in five",
    audience: '.[] | select(.group == "new-feature" and .role == "worker")',
  });
  assert.ok(published.ok);
  assert.deepEqual(published.value.resolvedRecipientIds, ["s-a", "s-b"]);
  assert.equal((await h.board.deliveries(published.value.id)).length, 2);

  await h.service.updateCharacter(cap("s-b", "bob"), "s-b", { character: { group: "other" }, ifVersion: 1 });
  assert.deepEqual((await h.service.getMessage(published.value.id))!.resolvedRecipientIds, ["s-a", "s-b"]);

  const empty = await h.service.publish(cap("s-a", "alice"), { text: "anyone?", audience: ".[] | select(false)" });
  assert.ok(empty.ok);
  assert.deepEqual(empty.value.resolvedRecipientIds, []);
  assert.deepEqual(await h.board.deliveries(empty.value.id), []);
});

test("a capability caller can only publish as its own session", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-b", "bob", BOB);
  const forged = await h.service.publish(cap("s-a", "alice"), {
    senderSessionId: "s-b",
    text: "as bob",
    recipients: ["s-a"],
  });
  assert.equal(forged.ok === false && forged.status, 403);
  const sourceNoSender = await h.service.publish(SOURCE, { text: "x", recipients: ["s-a"] });
  assert.equal(sourceNoSender.ok === false && sourceNoSender.status, 400);
  const sourceOk = await h.service.publish(SOURCE, { senderSessionId: "s-b", text: "x", recipients: ["s-a"] });
  assert.ok(sourceOk.ok);
  assert.equal(sourceOk.value.senderSessionId, "s-b");
});

test("the board pages by cursor with no gap and no repeat, and reading wakes nobody", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE);
  for (let i = 0; i < 5; i++) {
    assert.ok((await h.service.publish(cap("s-a", "alice"), { text: `m${i}`, recipients: [] })).ok);
  }
  const first = await h.service.listMessages({ limit: 2 });
  assert.deepEqual(
    first.messages.map((m) => m.text),
    ["m0", "m1"],
  );
  const second = await h.service.listMessages({ limit: 2, afterSeq: first.nextCursor! });
  assert.deepEqual(
    second.messages.map((m) => m.text),
    ["m2", "m3"],
  );
  const third = await h.service.listMessages({ limit: 2, afterSeq: second.nextCursor! });
  assert.deepEqual(
    third.messages.map((m) => m.text),
    ["m4"],
  );
  assert.equal(third.nextCursor, null);
  assert.deepEqual(h.runs.withdrawn, []);
  assert.deepEqual(await h.signals.pendingRunIds(), []);
});

function dispatcherFor(
  h: Awaited<ReturnType<typeof harness>>,
  results: TurnResult[],
  names: Record<string, string> = { alice: "Alice Human", bob: "Bob Human" },
) {
  const calls: TurnRequest[] = [];
  const dispatcher = createPeerDispatcher({
    board: h.board,
    directory: h.directory,
    coordination: h.service,
    sessions: h.sessions,
    runs: h.runs,
    signals: h.signals,
    featureFlags: h.featureFlags,
    peopleDirectory: fakePeopleDirectory(names),
    turn: async (request) => {
      calls.push(request);
      return results.shift() ?? { status: "silent" };
    },
    now: h.at,
  });
  return { dispatcher, calls };
}

test("a dispatched peer delivery carries the recipient's own authority and the sender's identity", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-b", "bob", BOB);
  const published = await h.service.publish(cap("s-a", "alice"), { text: "ping", recipients: ["s-b"] });
  assert.ok(published.ok);

  h.runs.seed({ id: "run-1", sessionId: "web:bob:s-b", status: "running" });
  const { dispatcher, calls } = dispatcherFor(h, [{ status: "queued", runId: "run-1" }]);
  await dispatcher.tick();
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.equal(request.surface, "peer");
  assert.equal(request.actor.externalId, "bob");
  assert.equal(request.actor.displayName, "Bob Human");
  assert.equal(request.conversation.kind, "dm");
  assert.equal(request.conversation.threadRef, "web:bob:s-b");
  assert.deepEqual(request.origin, {
    kind: "peer",
    senderSessionId: "s-a",
    senderAgentName: "s-a",
    messageId: published.value.id,
  });
  assert.equal(request.redeliveryKey, `peer:${published.value.id}:s-b`);
  assert.equal(request.async, true);

  const [delivery] = await h.board.deliveries(published.value.id);
  assert.equal(delivery!.runId, "run-1");
  assert.notEqual(delivery!.dispatchedAt, null);
  assert.equal(delivery!.consumedAt, null, "delivery is not proof the recipient ran");
});

test("a shared-scope recipient is dispatched into its own project conversation", async () => {
  const PROJECT = scopeId("group", "P1");
  const h = await harness([ALICE, PROJECT]);
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-proj", "carol", PROJECT, {}, ["carol"]);
  const published = await h.service.publish(cap("s-a", "alice"), { text: "ping", recipients: ["s-proj"] });
  assert.ok(published.ok);

  const { dispatcher, calls } = dispatcherFor(h, [{ status: "queued", runId: "run-1" }], { carol: "Carol Human" });
  await dispatcher.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.conversation.kind, "group");
  assert.equal(calls[0]!.conversation.channelRef, "P1", "the channel ref is what arms the project roster gate");
  assert.equal(calls[0]!.actor.externalId, "carol");
});

test("consumption is stamped only once the linked run is terminal or gone", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-b", "bob", BOB);
  const published = await h.service.publish(cap("s-a", "alice"), { text: "ping", recipients: ["s-b"] });
  assert.ok(published.ok);
  const run = h.runs.seed({ id: "run-1", sessionId: "web:bob:s-b", status: "running" });

  const { dispatcher } = dispatcherFor(h, [{ status: "queued", runId: run.id }]);
  await dispatcher.tick();
  assert.equal((await h.board.deliveries(published.value.id))[0]!.consumedAt, null);

  h.runs.seed({ id: "run-1", sessionId: "web:bob:s-b", status: "done" });
  await dispatcher.tick();
  assert.notEqual((await h.board.deliveries(published.value.id))[0]!.consumedAt, null);
});

test("a withdrawn run still resolves its delivery instead of rescanning forever", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-b", "bob", BOB);
  const published = await h.service.publish(cap("s-a", "alice"), { text: "ping", recipients: ["s-b"] });
  assert.ok(published.ok);
  h.runs.seed({ id: "run-1", sessionId: "web:bob:s-b", status: "pending" });
  const { dispatcher } = dispatcherFor(h, [{ status: "queued", runId: "run-1" }]);
  await dispatcher.tick();
  await h.runs.withdraw("run-1");
  await dispatcher.tick();
  assert.notEqual((await h.board.deliveries(published.value.id))[0]!.consumedAt, null);
});

test("a steered result retires only against a durable signal record", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-b", "bob", BOB);
  const blocked = await h.service.publish(cap("s-a", "alice"), { text: "screened", recipients: ["s-b"] });
  assert.ok(blocked.ok);

  const { dispatcher } = dispatcherFor(h, [{ status: "queued", runId: "live-1", steered: true }]);
  await dispatcher.tick();
  const parked = (await h.board.deliveries(blocked.value.id))[0]!;
  assert.equal(parked.dispatchedAt, null);
  assert.equal(parked.runId, null);
  assert.equal(parked.consumedAt, null);
  assert.notEqual(parked.nextAttemptAt, null, "a blocked steer stays retryable");

  await h.signals.send("live-1", { kind: "steer", dedupeKey: `peer:${blocked.value.id}:s-b` });
  h.advance(10 * 60_000);
  const second = dispatcherFor(h, [{ status: "queued", runId: "live-1", steered: true }]);
  await second.dispatcher.tick();
  const retired = (await h.board.deliveries(blocked.value.id))[0]!;
  assert.notEqual(retired.dispatchedAt, null);
  assert.equal(retired.runId, "live-1");
});

test("refusals terminal-park, except the roster race that asks to be retried", async () => {
  const h = await harness();
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-b", "bob", BOB);
  const hard = await h.service.publish(cap("s-a", "alice"), { text: "one", recipients: ["s-b"] });
  const race = await h.service.publish(cap("s-a", "alice"), { text: "two", recipients: ["s-b"] });
  const pending = await h.service.publish(cap("s-a", "alice"), { text: "three", recipients: ["s-b"] });
  assert.ok(hard.ok && race.ok && pending.ok);

  const { dispatcher } = dispatcherFor(h, [
    { status: "refused", reason: "that conversation lives in a different context" },
    { status: "refused", reason: "project membership changed; retry from the current project" },
    { status: "pending_approval" },
  ]);
  await dispatcher.tick();
  assert.equal((await h.board.deliveries(hard.value.id))[0]!.nextAttemptAt, null, "a hard refusal stops retrying");
  assert.notEqual((await h.board.deliveries(race.value.id))[0]!.nextAttemptAt, null);
  assert.notEqual((await h.board.deliveries(pending.value.id))[0]!.nextAttemptAt, null);
  for (const message of [hard, race, pending]) {
    assert.ok(await h.service.getMessage(message.value.id), "a parked message stays readable on the board");
  }
});

test("with the flag off the dispatcher claims nothing, writes nothing, and calls nothing", async () => {
  const h = await harness([]);
  const forced = await harness([ALICE, BOB]);
  await registeredPeer(forced, "s-a", "alice", ALICE);
  await registeredPeer(forced, "s-b", "bob", BOB);
  const published = await forced.service.publish(cap("s-a", "alice"), { text: "ping", recipients: ["s-b"] });
  assert.ok(published.ok);
  await forced.featureFlags.setEnabled(FLAG, ALICE, false, "test");
  await forced.featureFlags.setEnabled(FLAG, BOB, false, "test");
  const before = (await forced.board.deliveries(published.value.id))[0]!;

  const { dispatcher, calls } = dispatcherFor(forced, []);
  await dispatcher.tick();
  assert.deepEqual(calls, []);
  assert.deepEqual((await forced.board.deliveries(published.value.id))[0], before);
  assert.equal(await h.service.availableAnywhere(), false);
});

test("a scope that is off parks its deliveries retryably instead of losing them", async () => {
  const h = await harness([ALICE, BOB]);
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-b", "bob", BOB);
  const published = await h.service.publish(cap("s-a", "alice"), { text: "ping", recipients: ["s-b"] });
  assert.ok(published.ok);
  await h.featureFlags.setEnabled(FLAG, BOB, false, "test");

  const { dispatcher, calls } = dispatcherFor(h, []);
  await dispatcher.tick();
  assert.deepEqual(calls, []);
  const parked = (await h.board.deliveries(published.value.id))[0]!;
  assert.notEqual(parked.nextAttemptAt, null, "a scope can be enabled later, so the row must survive");
  assert.equal(parked.dispatchedAt, null);
});

async function swarmHarness() {
  const h = await harness();
  const root = await registeredPeer(h, "s-root", "alice", ALICE);
  const created = await h.service.createSwarm(cap("s-root", "alice"), {
    rootSessionId: "s-root",
    scopeId: ALICE,
  });
  assert.ok(created.ok, JSON.stringify(created));
  return { h, root, swarm: created.value };
}

const briefs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ agentName: `worker-${i}`, brief: `do part ${i}` }));

test("creating a swarm counts the root and stamps its identity", async () => {
  const { h, swarm } = await swarmHarness();
  assert.equal(swarm.sessionsUsed, 1);
  const root = await h.service.getPeer("s-root");
  assert.ok(root.ok);
  assert.equal(root.value.swarmId, swarm.id);
  assert.equal(root.value.depth, 0);
  assert.equal(root.value.parentSessionId, null);
});

test("a swarm whose scopeId disagrees with the root identity is refused with nothing written", async () => {
  const h = await harness();
  await registeredPeer(h, "s-root", "alice", ALICE);
  const out = await h.service.createSwarm(cap("s-root", "alice"), { rootSessionId: "s-root", scopeId: BOB });
  assert.equal(out.ok === false && out.status, 400);
  const root = await h.directory.get("s-root");
  assert.equal(root!.swarmId, null);
});

test("a pool provisions each brief, charges the reservation once, and hands each child its brief", async () => {
  const { h, swarm } = await swarmHarness();
  const pool = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-1",
    parentSessionId: "s-root",
    count: 2,
    briefs: briefs(2),
  });
  assert.ok(pool.ok, JSON.stringify(pool));
  assert.equal(pool.value.sessionIds.length, 2);
  assert.equal(pool.value.sessionsUsed, 3, "the pool is descendant-inclusive and the root is in it");

  for (const [index, childId] of pool.value.sessionIds.entries()) {
    const child = await h.directory.get(childId);
    assert.equal(child!.parentSessionId, "s-root");
    assert.equal(child!.depth, 1);
    assert.equal(child!.executionActorId, "alice");
    assert.equal(child!.scopeId, ALICE);
    const addressed = (await h.service.listMessages({})).messages.filter((m) =>
      m.resolvedRecipientIds.includes(childId),
    );
    assert.equal(addressed.length, 1, "a child's only inbound message is its task brief");
    assert.equal(addressed[0]!.text, `do part ${index}`);
    assert.equal(addressed[0]!.senderSessionId, "s-root");
  }

  const replay = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-1",
    parentSessionId: "s-root",
    count: 2,
    briefs: briefs(2),
  });
  assert.ok(replay.ok);
  assert.deepEqual(replay.value.sessionIds, pool.value.sessionIds);
  assert.equal(replay.value.sessionsUsed, 3, "a replay never charges the pool twice");
  assert.equal(h.spawned.length, 2, "a replay creates nothing");
});

test("breadth, depth, and the descendant-inclusive pool each refuse with the counters unchanged", async () => {
  const { h, swarm } = await swarmHarness();
  const breadthOk = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "fill",
    parentSessionId: "s-root",
    count: DEFAULT_MAX_CHILDREN_PER_PARENT,
    briefs: briefs(DEFAULT_MAX_CHILDREN_PER_PARENT),
  });
  assert.ok(breadthOk.ok);
  const usedBefore = (await h.swarms.getSwarm(swarm.id))!.sessionsUsed;

  const breadth = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "over-breadth",
    parentSessionId: "s-root",
    count: 1,
    briefs: briefs(1),
  });
  assert.equal(breadth.ok === false && breadth.body.error, "breadth_exceeded");
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, usedBefore);
  assert.equal(await h.swarms.getReservation(swarm.id, "over-breadth"), null);

  const mismatched = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "mismatch",
    parentSessionId: "s-root",
    count: 3,
    briefs: briefs(2),
  });
  assert.equal(mismatched.ok === false && mismatched.status, 400);
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, usedBefore);
  assert.equal(await h.swarms.getReservation(swarm.id, "mismatch"), null);
});

test("depth bounds recursive spawning, which consumes the same counters", async () => {
  const h = await harness();
  await registeredPeer(h, "s-root", "alice", ALICE);
  const created = await h.service.createSwarm(cap("s-root", "alice"), {
    rootSessionId: "s-root",
    scopeId: ALICE,
    maxDepth: 1,
  });
  assert.ok(created.ok);
  const swarm = created.value;
  const pool = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "r1",
    parentSessionId: "s-root",
    count: 1,
    briefs: briefs(1),
  });
  assert.ok(pool.ok);
  const child = pool.value.sessionIds[0]!;
  const usedBefore = (await h.swarms.getSwarm(swarm.id))!.sessionsUsed;
  const deeper = await h.service.createPool(cap(child, "alice"), swarm.id, {
    requestId: "r2",
    parentSessionId: child,
    count: 1,
    briefs: briefs(1),
  });
  assert.equal(deeper.ok === false && deeper.body.error, "depth_exceeded");
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, usedBefore);
});

test("two swarms sharing a requestId keep their own reservations", async () => {
  const first = await swarmHarness();
  const secondRoot = await registeredPeer(first.h, "s-root2", "bob", BOB);
  assert.ok(secondRoot);
  const secondSwarm = await first.h.service.createSwarm(cap("s-root2", "bob"), {
    rootSessionId: "s-root2",
    scopeId: BOB,
  });
  assert.ok(secondSwarm.ok);

  const a = await first.h.service.createPool(cap("s-root", "alice"), first.swarm.id, {
    requestId: "req-1",
    parentSessionId: "s-root",
    count: 1,
    briefs: briefs(1),
  });
  const b = await first.h.service.createPool(cap("s-root2", "bob"), secondSwarm.value.id, {
    requestId: "req-1",
    parentSessionId: "s-root2",
    count: 1,
    briefs: briefs(1),
  });
  assert.ok(a.ok && b.ok);
  assert.notDeepEqual(a.value.sessionIds, b.value.sessionIds);
  assert.equal((await first.h.swarms.getSwarm(secondSwarm.value.id))!.sessionsUsed, 2);
});

test("a mid-provision failure that discards everything releases the whole reservation", async () => {
  const { h, swarm } = await swarmHarness();
  const before = (await h.swarms.getSwarm(swarm.id))!.sessionsUsed;
  h.spawnFailsAfter.count = 1;
  const out = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-fail",
    parentSessionId: "s-root",
    count: 2,
    briefs: briefs(2),
  });
  assert.equal(out.ok, false);
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, before);
  assert.equal((await h.swarms.getMember(swarm.id, "s-root"))!.childrenUsed, 0);
  assert.equal(await h.swarms.getReservation(swarm.id, "req-fail"), null);
  assert.equal(await h.directory.get("child-1"), null, "no orphan identity survives");
  assert.equal(await h.sessions.get("child-1"), null, "no orphan session survives");
});

test("a mid-provision failure that keeps a child leaves the reservation charged in full", async () => {
  const { h, swarm } = await swarmHarness();
  h.spawnFailsAfter.count = 2;
  h.undeletable.add("child-1");
  const out = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-resume",
    parentSessionId: "s-root",
    count: 3,
    briefs: briefs(3),
  });
  assert.equal(out.ok, false);
  const held = await h.swarms.getReservation(swarm.id, "req-resume");
  assert.deepEqual(
    held!.slots,
    ["child-1", null, null],
    "the discarded child frees its slot, the survivor keeps its own",
  );
  assert.equal(held!.n, 3);
  assert.equal(await h.directory.get("child-2"), null);
  assert.equal(await h.swarms.getMember(swarm.id, "child-2"), null);
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, 4, "the live reservation stays charged its full n");
  assert.equal((await h.swarms.getMember(swarm.id, "s-root"))!.childrenUsed, 3);

  h.spawnFailsAfter.count = Number.POSITIVE_INFINITY;
  const resumed = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-resume",
    parentSessionId: "s-root",
    count: 3,
    briefs: briefs(3),
  });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(resumed.value.sessionIds.length, 3);
  assert.equal(resumed.value.sessionIds[0], "child-1", "the surviving child is not re-provisioned");
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, 4, "the pool is never over-subscribed");
  assert.equal(
    (await h.swarms.getReservation(swarm.id, "req-resume"))!.slots.length,
    3,
    "the live children under the reservation equal what the pool was charged",
  );
});

test("a resume whose survivor is not the first child still delivers every brief exactly once", async () => {
  const { h, swarm } = await swarmHarness();
  h.spawnFailsAfter.count = 2;
  h.undeletable.add("child-2");
  const out = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-gap",
    parentSessionId: "s-root",
    count: 3,
    briefs: briefs(3),
  });
  assert.equal(out.ok, false);
  assert.deepEqual(
    (await h.swarms.getReservation(swarm.id, "req-gap"))!.slots,
    [null, "child-2", null],
    "the survivor holds the slot of the brief it was given",
  );

  h.spawnFailsAfter.count = Number.POSITIVE_INFINITY;
  const resumed = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-gap",
    parentSessionId: "s-root",
    count: 3,
    briefs: briefs(3),
  });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.deepEqual(resumed.value.sessionIds.slice().sort(), ["child-2", "child-3", "child-4"]);
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, 4, "the pool is never over-subscribed");

  const messages = await h.service.listMessages({});
  const delivered = new Map<string, string[]>();
  for (const childId of resumed.value.sessionIds) {
    const texts = messages.messages.filter((m) => m.resolvedRecipientIds.includes(childId)).map((m) => m.text);
    delivered.set(childId, texts);
    assert.equal(texts.length, 1, `${childId} receives exactly one brief`);
    assert.equal((await h.directory.get(childId))!.agentName, `worker-${texts[0]!.slice("do part ".length)}`);
  }
  assert.deepEqual([...delivered.values()].flat().sort(), ["do part 0", "do part 1", "do part 2"]);
});

test("two concurrent submits of one requestId provision a single pool", async () => {
  const { h, swarm } = await swarmHarness();
  const body = { requestId: "dup", parentSessionId: "s-root", count: 2, briefs: briefs(2) };
  const [a, b] = await Promise.all([
    h.service.createPool(cap("s-root", "alice"), swarm.id, body),
    h.service.createPool(cap("s-root", "alice"), swarm.id, body),
  ]);
  const winners = [a, b].filter((out) => out.ok);
  const losers = [a, b].filter((out) => !out.ok);
  assert.equal(winners.length, 1, `exactly one submit provisions: ${JSON.stringify([a, b])}`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0]!.ok === false && losers[0]!.body.error, "provisioning_in_progress");
  assert.equal(h.spawned.length, 2, "the duplicate submit spawns nothing");
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, 3, "the pool counter matches the live sessions");
  assert.equal((await h.swarms.getMember(swarm.id, "s-root"))!.childrenUsed, 2);

  const replay = await h.service.createPool(cap("s-root", "alice"), swarm.id, body);
  assert.ok(replay.ok, "once provisioning settles the same requestId replays");
  assert.deepEqual(replay.value.sessionIds, winners[0]!.ok === true ? winners[0]!.value.sessionIds : []);
  assert.equal(h.spawned.length, 2);
});

test("the board records which run authored a message", async () => {
  const h = await harness([ALICE, BOB]);
  await registeredPeer(h, "s-a", "alice", ALICE);
  await registeredPeer(h, "s-b", "bob", BOB);
  const published = await h.service.publish(cap("s-a", "alice", "run-7"), { text: "ping", recipients: ["s-b"] });
  assert.ok(published.ok);
  assert.equal(published.value.senderRunId, "run-7");
  assert.equal((await h.board.get(published.value.orgId, published.value.id))!.senderRunId, "run-7");

  const bySource = await h.service.publish(SOURCE, { senderSessionId: "s-a", text: "ping", recipients: ["s-b"] });
  assert.ok(bySource.ok);
  assert.equal(bySource.value.senderRunId, null, "a source caller authors no run");
});

test("a task brief records the run that spawned the pool", async () => {
  const { h, swarm } = await swarmHarness();
  const pool = await h.service.createPool(cap("s-root", "alice", "run-9"), swarm.id, {
    requestId: "req-run",
    parentSessionId: "s-root",
    count: 1,
    briefs: briefs(1),
  });
  assert.ok(pool.ok);
  const brief = (await h.service.listMessages({})).messages.find((m) =>
    m.resolvedRecipientIds.includes(pool.value.sessionIds[0]!),
  );
  assert.equal(brief!.senderRunId, "run-9");
});

test("a capability caller cannot spawn from, root, or stop someone else's swarm", async () => {
  const { h, swarm } = await swarmHarness();
  await registeredPeer(h, "s-out", "bob", BOB);
  const foreignPool = await h.service.createPool(cap("s-out", "bob"), swarm.id, {
    requestId: "x",
    parentSessionId: "s-root",
    count: 1,
    briefs: briefs(1),
  });
  assert.equal(foreignPool.ok === false && foreignPool.status, 403);
  const outsiderParent = await h.service.createPool(cap("s-out", "bob"), swarm.id, {
    requestId: "y",
    parentSessionId: "s-out",
    count: 1,
    briefs: briefs(1),
  });
  assert.equal(outsiderParent.ok === false && outsiderParent.status, 403);
  const foreignStop = await h.service.stop(cap("s-out", "bob"), swarm.id, { scope: "swarm" });
  assert.equal(foreignStop.ok === false && foreignStop.status, 403);
  const noThread = await h.service.createSwarm(cap(null, "bob"), { rootSessionId: "s-out", scopeId: BOB });
  assert.equal(noThread.ok === false && noThread.status, 403);
  assert.equal(h.spawned.length, 0);
});

test("parent, subtree, and swarm stop each withdraw pending runs and abort running ones", async () => {
  const { h, swarm } = await swarmHarness();
  const pool = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "r",
    parentSessionId: "s-root",
    count: 2,
    briefs: briefs(2),
  });
  assert.ok(pool.ok);
  const [childA, childB] = pool.value.sessionIds as [string, string];
  const grand = await h.service.createPool(cap(childA, "alice"), swarm.id, {
    requestId: "g",
    parentSessionId: childA,
    count: 1,
    briefs: briefs(1),
  });
  assert.ok(grand.ok);
  const grandchild = grand.value.sessionIds[0]!;

  h.runs.seed({ id: "run-a", sessionId: `web:alice:${childA}`, status: "pending" });
  h.runs.seed({ id: "run-g", sessionId: `web:alice:${grandchild}`, status: "running" });

  const parentStop = await h.service.stop(cap("s-root", "alice"), swarm.id, { scope: "parent", sessionId: childA });
  assert.ok(parentStop.ok);
  assert.deepEqual(parentStop.value.stopped, [childA]);
  assert.deepEqual(h.runs.withdrawn, ["run-a"]);
  const stoppedChild = await h.service.getPeer(childA);
  assert.ok(stoppedChild.ok);
  assert.equal(stoppedChild.value.lifecycle, "stopped");
  const siblingView = await h.service.getPeer(childB);
  assert.ok(siblingView.ok);
  assert.equal(siblingView.value.lifecycle, "active", "stopping a parent does not stop its peers");
  const grandView = await h.service.getPeer(grandchild);
  assert.ok(grandView.ok);
  assert.equal(grandView.value.lifecycle, "active", "parent stop is not implicit subtree stop");

  const subtree = await h.service.stop(cap("s-root", "alice"), swarm.id, { scope: "subtree", sessionId: childA });
  assert.ok(subtree.ok);
  assert.deepEqual(subtree.value.stopped, [childA, grandchild]);
  const aborted = await h.signals.takePending("run-g");
  assert.equal(aborted[0]?.kind, "abort", "a running member is aborted, not silently left alive");

  const swarmStop = await h.service.stop(cap("s-root", "alice"), swarm.id, { scope: "swarm" });
  assert.ok(swarmStop.ok);
  assert.equal((await h.swarms.getSwarm(swarm.id))!.stoppedAt, h.at());
  const again = await h.service.stop(cap("s-root", "alice"), swarm.id, { scope: "swarm" });
  assert.ok(again.ok, "stop is idempotent");
  assert.equal((await h.service.listPeers()).length, 4, "stop deletes no durable row");
  assert.ok((await h.service.listMessages({})).messages.length > 0);
});

test("a stopped member admits no further delivery and no further fan-out", async () => {
  const { h, swarm } = await swarmHarness();
  await registeredPeer(h, "s-b", "bob", BOB);
  await h.service.stop(cap("s-root", "alice"), swarm.id, { scope: "parent", sessionId: "s-root" });

  const published = await h.service.publish(SOURCE, {
    senderSessionId: "s-b",
    text: "still there?",
    recipients: ["s-root"],
  });
  assert.ok(published.ok);
  const { dispatcher, calls } = dispatcherFor(h, []);
  await dispatcher.tick();
  assert.deepEqual(calls, []);
  assert.equal(
    (await h.board.deliveries(published.value.id))[0]!.nextAttemptAt,
    null,
    "a stopped recipient is terminal",
  );

  const spawn = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "after-stop",
    parentSessionId: "s-root",
    count: 1,
    briefs: briefs(1),
  });
  assert.equal(spawn.ok === false && spawn.body.error, "parent_stopped");
});

test("a replayed requestId that asks for a different pool is refused, not silently re-shaped", async () => {
  const { h, swarm } = await swarmHarness();
  const first = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-1",
    parentSessionId: "s-root",
    count: 1,
    briefs: briefs(1),
  });
  assert.ok(first.ok);
  const widened = await h.service.createPool(cap("s-root", "alice"), swarm.id, {
    requestId: "req-1",
    parentSessionId: "s-root",
    count: 2,
    briefs: briefs(2),
  });
  assert.equal(widened.ok === false && widened.body.error, "reservation_conflict");
  assert.equal((await h.swarms.getSwarm(swarm.id))!.sessionsUsed, 2, "the original charge is untouched");
  assert.equal(h.spawned.length, 1);
});
