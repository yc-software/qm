import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemorySessionStateBus, type SessionStateEvent } from "../src/runs/session-state-bus.ts";
import { createOutbound, createWebSender } from "../src/surfaces/outbound.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createTranscriptSource } from "../src/sessions/transcript-source.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { DeliveryProvenance, Destination, ScopeId } from "../src/types.ts";

const THREAD = "web:alice@example.com:conv-1";
const SCOPE = "personal:alice@example.com" as ScopeId;

const cronProvenance = (over: Partial<DeliveryProvenance> = {}): DeliveryProvenance => ({
  trigger: "cron",
  surface: "cron",
  fireKey: "agent:main:cron:c1:100",
  sourceScopeId: SCOPE,
  sourceThreadRef: "agent:main:cron:c1",
  sourceSessionId: "cron-session",
  ...over,
});

const webDestination = (target = THREAD): Destination => ({ type: "web", target, audienceScopeId: SCOPE });

async function webSession(sessions: SessionStore, threadRef = THREAD) {
  return sessions.getOrCreateByThread(threadRef, "dm", SCOPE, undefined, "web");
}

function wired(leaseWaitMs?: number) {
  const sessions = createMemorySessionStore();
  const bus = createMemorySessionStateBus();
  const states: SessionStateEvent[] = [];
  bus.subscribe((event) => void states.push(event));
  const outbound = createOutbound({ idempotency: createIdempotencyStore() });
  outbound.register(
    ["web"],
    createWebSender({ sessions, sessionStates: bus, ...(leaseWaitMs !== undefined ? { leaseWaitMs } : {}) }),
  );
  return { sessions, outbound, states };
}

test("a cron post to a web conversation becomes one assistant message there, however often it is sent", async () => {
  const { sessions, outbound, states } = wired();
  const session = await webSession(sessions);
  await sessions.addParticipant(session.id, "alice@example.com");
  const post = {
    destination: webDestination(),
    text: "Reminder: standup in 10 minutes",
    idempotencyKey: "agent:main:cron:c1:900",
    provenance: cronProvenance(),
  };
  await outbound.send(post);
  await outbound.send(post);
  const entries = (await createTranscriptSource(sessions).forRender(session.id)).entries;
  assert.deepEqual(
    entries.map((e) => [e.type, (e.payload as { text?: string }).text]),
    [["assistant", "Reminder: standup in 10 minutes"]],
  );
  assert.equal(states.length, 1, "open web views are told to reload once");
  assert.deepEqual(
    [states[0]!.threadRef, states[0]!.state, states[0]!.participants],
    [THREAD, "idle", ["alice@example.com"]],
  );
});

test("a post marks the web conversation unread for its participant", async () => {
  const { sessions, outbound } = wired();
  const session = await webSession(sessions);
  await sessions.addParticipant(session.id, "alice@example.com");
  await sessions.updateParticipantView(session.id, "alice@example.com", { readAt: 1 });
  await outbound.send({
    destination: webDestination(),
    text: "Reminder",
    idempotencyKey: "agent:main:cron:c1:901",
    provenance: cronProvenance(),
  });
  assert.equal((await sessions.getForParticipant(session.id, "alice@example.com"))!.unread, true);
});

test("a conversation's own posts are already in its transcript and write nothing", async () => {
  const { sessions, outbound, states } = wired();
  const session = await webSession(sessions);
  await outbound.send({
    destination: webDestination(),
    text: "spine post",
    idempotencyKey: "post:1",
    provenance: cronProvenance({ sourceThreadRef: THREAD, trigger: "conversation" }),
  });
  await outbound.send({ destination: webDestination(), text: "no provenance", idempotencyKey: "reach:1" });
  assert.equal((await sessions.getEntries(session.id)).length, 0);
  assert.equal(states.length, 0);
});

test("a recovered reply the turn never wrote is added to its own transcript", async () => {
  const { sessions, outbound } = wired();
  const session = await webSession(sessions);
  await outbound.send({
    destination: { ...webDestination(), webTranscript: { kind: "reply" } },
    text: "recovered reply",
    idempotencyKey: "run:r-1",
    provenance: cronProvenance({ sourceThreadRef: THREAD, trigger: "conversation" }),
  });
  const entries = await sessions.getEntries(session.id);
  assert.deepEqual(
    entries.map((e) => [e.type, (e.payload as { text?: string }).text]),
    [["assistant", "recovered reply"]],
  );
});

test("a busy conversation gets the message once its turn ends", async () => {
  const { sessions, outbound } = wired();
  const session = await webSession(sessions);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const sent = outbound.send({
    destination: webDestination(),
    text: "while you were busy",
    idempotencyKey: "agent:main:cron:c1:902",
    provenance: cronProvenance(),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await sessions.getEntries(session.id)).length, 0);
  await sessions.releaseLease(lease);
  await sent;
  assert.equal((await sessions.getEntries(session.id)).length, 1);
});

test("a conversation that stays busy fails the post, so the sender can retry it", async () => {
  const { sessions, outbound } = wired(100);
  const session = await webSession(sessions);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  const post = {
    destination: webDestination(),
    text: "retry me",
    idempotencyKey: "agent:main:cron:c1:903",
    provenance: cronProvenance(),
  };
  await assert.rejects(outbound.send(post), /stayed busy/);
  await sessions.releaseLease(lease!);
  await outbound.send(post);
  assert.equal((await sessions.getEntries(session.id)).length, 1);
});

test("a post to a web conversation that does not exist fails loudly", async () => {
  const { outbound } = wired();
  await assert.rejects(
    outbound.send({
      destination: webDestination("web:alice@example.com:gone"),
      text: "hello?",
      idempotencyKey: "agent:main:cron:c1:904",
      provenance: cronProvenance(),
    }),
    /does not exist/,
  );
});
