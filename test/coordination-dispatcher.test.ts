import assert from "node:assert/strict";
import { test } from "node:test";
import { createPeerDispatcher } from "../src/coordination/dispatcher.ts";
import { createPeerBoard } from "../src/coordination/board.ts";
import { createPeerIdentity } from "../src/coordination/identity.ts";
import { createMemoryCoordinationRepository } from "../src/coordination/repository.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { scopeId, type PeerOrigin, type TurnRequest } from "../src/types.ts";

async function setup() {
  const repository = createMemoryCoordinationRepository();
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const signals = createMemoryRunSignalStore();
  const identity = createPeerIdentity(repository);
  const scope = scopeId("personal", "owner");
  const session = await sessions.getOrCreateByThread("web:owner:recipient", "dm", scope);
  const authority = {
    actor: { id: "owner", type: "internal" as const },
    conversation: { kind: "dm" as const, threadRef: session.threadRef, audience: [] },
    surface: "web",
  };
  await identity.ensure({ id: session.id, scopeId: scope, authority });
  await identity.ensure({ id: "sender", scopeId: scopeId("personal", "different-owner") });
  const board = createPeerBoard(repository);
  const message = await board.publish({
    senderId: "sender",
    senderRunId: "sender-run",
    idempotencyKey: "request",
    text: "Please review",
    audience: `.[] | select(._qm.id == ${JSON.stringify(session.id)})`,
  });
  const id = `${message.id}:${session.id}`;
  const state = {
    authorized: true,
    blocked: false,
    failAfterEnqueue: false,
  };
  const queued: TurnRequest[] = [];
  const dispatcher = createPeerDispatcher({
    repository,
    identity,
    sessions,
    runs,
    authorize: async (peer) => {
      assert.equal(peer.authority?.actor.id, "owner");
      return state.authorized ? peer.authority : null;
    },
    blocked: async () => state.blocked,
    enqueue: async (request) => {
      queued.push(request);
      const { run } = await runs.enqueue({
        sessionId: session.threadRef,
        dedupKey: request.idempotencyKey,
        request: { ...authority, text: request.text, origin: request.origin! },
      });
      if (state.failAfterEnqueue) {
        state.failAfterEnqueue = false;
        throw new Error("dispatcher crashed after enqueue");
      }
      return { status: "queued", runId: run.id };
    },
  });
  return { repository, sessions, runs, signals, session, authority, message, id, dispatcher, state, queued };
}

test("idle delivery uses recipient authority and recovers enqueue-before-bind crashes without duplicate runs", async () => {
  const f = await setup();
  f.state.failAfterEnqueue = true;
  await assert.rejects(f.dispatcher.dispatch(f.id), /crashed/);
  await Promise.all([f.dispatcher.dispatch(f.id), f.dispatcher.dispatch(f.id)]);
  assert.equal((await f.runs.list()).length, 1);
  const delivery = (await f.repository.get("delivery", f.id))!;
  assert.equal(delivery.state, "delivered");
  assert.equal(f.queued[0]?.actor.externalId, "owner");
  const origin = f.queued[0]?.origin as PeerOrigin;
  assert.equal(origin.senderSessionId, "sender");
  const { lease } = await f.sessions.acquireLease(f.session.id);
  assert.ok(lease);
  await f.sessions.append(lease, {
    type: "user",
    payload: { text: f.message.text, peerOrigin: origin },
    scopeLabel: f.session.scopeId,
  });
  await f.sessions.releaseLease(lease);
  await f.dispatcher.dispatch(f.id);
  assert.equal((await f.repository.get("delivery", f.id))?.state, "delivered");
  const claimed = await f.runs.claimById(delivery.runId!, "worker", 30_000);
  assert.ok(claimed);
  await f.runs.complete(claimed.id, claimed.leaseToken!, { status: "silent" });
  await f.dispatcher.dispatch(f.id);
  assert.equal((await f.repository.get("delivery", f.id))?.state, "delivered");
});

test("busy delivery queues a separate run without steering the active run", async () => {
  const f = await setup();
  const { run } = await f.runs.enqueue({
    sessionId: f.session.threadRef,
    request: { ...f.authority, text: "Working", origin: { kind: "human" } },
  });
  const claimed = await f.runs.claimById(run.id, "worker", 30_000);
  assert.ok(claimed);
  await f.dispatcher.dispatch(f.id);
  await f.dispatcher.dispatch(f.id);
  const signals = await f.signals.takeLive(run.id);
  assert.equal(signals.length, 0);
  assert.deepEqual(await f.signals.steerAuthors(run.id), []);
  assert.equal(f.queued.length, 1);
  assert.equal((await f.runs.list()).length, 2);
  await f.dispatcher.dispatch(f.id);
  assert.equal((await f.repository.get("delivery", f.id))?.state, "delivered");
  await f.runs.complete(run.id, claimed.leaseToken!, { status: "silent" });
  await f.dispatcher.dispatch(f.id);
  assert.equal(f.queued.length, 1);
  assert.notEqual((await f.repository.get("delivery", f.id))?.runId, run.id);
});

for (const blocker of ["authority", "approval", "paused", "archived"] as const) {
  test(`delivery retains notifications when blocked by ${blocker}`, async () => {
    const f = await setup();
    if (blocker === "authority") f.state.authorized = false;
    if (blocker === "approval") f.state.blocked = true;
    if (blocker === "paused" || blocker === "archived")
      await f.repository.transaction([`peer:${f.session.id}`], async (tx) => {
        const peer = (await tx.get("peer", f.session.id))!;
        await tx.put("peer", { ...peer, state: blocker });
      });
    await f.dispatcher.dispatch(f.id);
    assert.equal((await f.repository.get("delivery", f.id))?.state, "blocked");
    assert.equal(f.queued.length, 0);
    assert.equal((await f.runs.list()).length, 0);
  });
}

test("blocked delivery sweeps wait for the retry deadline then resume without losing the message", async (t) => {
  let now = 20_000;
  t.mock.method(Date, "now", () => now);
  const f = await setup();
  f.state.blocked = true;
  await f.dispatcher.sweep();
  const blocked = await f.repository.get("delivery", f.id);
  assert.equal(blocked?.state, "blocked");
  const events = await f.repository.events(0, 200);
  f.state.blocked = false;
  now += 4_999;
  await f.dispatcher.sweep();
  assert.equal(f.queued.length, 0);
  assert.deepEqual(await f.repository.get("delivery", f.id), blocked);
  assert.deepEqual(await f.repository.events(0, 200), events);
  now += 1;
  await f.dispatcher.sweep();
  assert.equal(f.queued.length, 1);
  assert.equal((await f.repository.get("delivery", f.id))?.state, "delivered");
  assert.equal((await f.repository.get("delivery", f.id))?.attempts, 2);
});

test("dispatcher uses bounded pending reads instead of scanning delivery history", async () => {
  const f = await setup();
  const list = f.repository.list.bind(f.repository);
  f.repository.list = async (kind, filter) => {
    assert.notEqual(kind, "delivery", "dispatch must not load all delivery history");
    return list(kind, filter);
  };
  await f.dispatcher.sweep(1);
  assert.equal(f.queued.length, 1);
});
