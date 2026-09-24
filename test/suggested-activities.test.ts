import assert from "node:assert/strict";
import test from "node:test";
import { createSuggestedActivityService, type SuggestedActivityProfile } from "../src/suggestions/activities.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";

const activities = ["app", "brief", "deck"].map((id) => ({
  id,
  title: `Build my ${id}`,
  prompt: "Help me with this project. ".repeat(40).trim(),
  icon: "🛠️",
}));

function fixture() {
  let time = Date.now();
  let output = JSON.stringify(activities);
  const store = createMemoryMap<SuggestedActivityProfile>();
  const sessions = createMemorySessionStore();
  const crons = createCronStore();
  const deliveries = createDeliveryStore();
  const calls: TurnRequest[] = [];
  const settled: Promise<void>[] = [];
  const scheduler = createScheduler({
    crons,
    deliveries,
    identity: createIdentityService(),
    idempotency: createIdempotencyStore(),
    run: async (request) => {
      calls.push(request);
      const scope = scopeId("personal", request.actor.externalId);
      const session = await sessions.getOrCreateByThread(
        request.conversation.threadRef,
        "dm",
        scope,
        undefined,
        "cron",
      );
      const acquired = await sessions.acquireLease(session.id);
      assert.ok(acquired.lease);
      if (!acquired.lease) throw new Error("lease unavailable");
      await sessions.append(acquired.lease, { type: "assistant", scopeLabel: scope, payload: { text: output } });
      await sessions.releaseLease(acquired.lease);
      return { status: "ok", reply: output, sessionId: session.id };
    },
  });
  const deps = {
    store,
    sessions,
    crons,
    enabled: true,
    now: () => time,
    scheduler: {
      notifyChanged: (id: string) => scheduler.notifyChanged(id),
      runNow: async (id: string) => {
        const result = await scheduler.runNow(id);
        if (result.started) settled.push(result.settled);
        return result;
      },
    },
  };
  return {
    deps,
    service: createSuggestedActivityService(deps),
    calls,
    crons,
    sessions,
    store,
    deliveries,
    settle: () => Promise.all(settled),
    advance: (ms: number) => {
      time += ms;
    },
    output: (value: string) => {
      output = value;
    },
  };
}

test("normal personal cron produces durable suggestions without a notification destination", async () => {
  const f = fixture();
  const initial = await f.service.get("alice", [], "America/Los_Angeles");
  assert.equal(initial.pending, true);
  await f.settle();
  const cron = (await f.crons.list())[0]!;
  assert.equal(cron.owner, "alice");
  assert.equal(cron.ownerScopeId, "personal:alice");
  assert.equal(cron.destination, undefined);
  assert.equal(cron.schedule.timezone, "America/Los_Angeles");
  assert.match(cron.schedule.cron!, /^\d+ 2 \* \* \*$/);
  assert.equal(f.calls[0]?.readOnly, undefined);
  assert.equal(f.calls[0]?.actor.externalId, "alice");
  assert.equal(f.calls[0]?.triggered, true);
  assert.match(f.calls[0]!.text, /past conversations and unfinished work/);
  assert.deepEqual(await f.service.get("alice", []), { activities, pending: false });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.deliveries.pending("slack"), []);
  const restarted = createSuggestedActivityService(f.deps);
  assert.deepEqual(await restarted.get("alice", []), { activities, pending: false });
});

test("concurrent enrollment shares one cron and one first run", async () => {
  const f = fixture();
  await Promise.all([f.service.get("alice", []), createSuggestedActivityService(f.deps).get("alice", [])]);
  await f.settle();
  assert.equal((await f.crons.list()).length, 1);
  assert.equal(f.calls.length, 1);
});

test("each principal has an independent cron and unavailable or invalid results use seeds", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  f.output("not valid JSON");
  await f.service.get("bob", []);
  await f.settle();
  assert.equal((await f.crons.list()).length, 2);
  assert.deepEqual(await f.service.get("bob", activities), { activities, pending: false });
  const alice = (await f.store.get("alice"))!;
  const fire = (await f.crons.listFires(alice.cronId!)).runs[0]!;
  await f.sessions.deleteSession(fire.sessionId!);
  assert.deepEqual(await f.service.get("alice", []), { activities: [], pending: false });
});

test("busy users refresh four-hourly, cool down nightly, and can override or pause", async () => {
  const f = fixture();
  const scope = scopeId("personal", "alice");
  const session = await f.sessions.getOrCreateByThread("active-chat", "dm", scope, undefined, "web");
  await f.sessions.addParticipant(session.id, "alice");
  const acquired = await f.sessions.acquireLease(session.id);
  if (!acquired.lease) throw new Error("lease unavailable");
  for (let i = 0; i < 10; i++)
    await f.sessions.append(acquired.lease, {
      type: "user",
      scopeLabel: scope,
      payload: { text: "Work on my project" },
    });
  await f.sessions.releaseLease(acquired.lease);
  await f.service.get("alice", []);
  await f.settle();
  const id = (await f.crons.list())[0]!.id;
  assert.match((await f.crons.get(id))!.schedule.cron!, /2,6,10,14,18,22/);
  f.advance(25 * 60 * 60_000);
  await f.service.maintain();
  assert.match((await f.crons.get(id))!.schedule.cron!, /^\d+ 2 \* \* \*$/);
  await f.crons.update(id, { schedule: { cron: "0 8 * * 1", timezone: "UTC" } });
  f.advance(2 * 60 * 60_000);
  await f.service.maintain();
  assert.equal((await f.crons.get(id))!.schedule.cron, "0 8 * * 1");
  await f.crons.setEnabled(id, false);
  await f.service.get("alice", []);
  assert.equal((await f.crons.get(id))!.enabled, false);
});

test("global disable and prolonged inactivity pause only managed jobs", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  const id = (await f.crons.list())[0]!.id;
  const disabled = createSuggestedActivityService({ ...f.deps, enabled: false });
  await disabled.maintain();
  assert.equal((await f.crons.get(id))!.enabled, false);
  await disabled.get("bob", []);
  assert.equal((await f.crons.list()).length, 1);
  await f.service.get("alice", []);
  assert.equal((await f.crons.get(id))!.enabled, true);
  f.advance(31 * 24 * 60 * 60_000);
  await f.service.maintain();
  assert.equal((await f.crons.get(id))!.enabled, false);
});

test("invalid first results retry after cooldown without creating another cron", async () => {
  const f = fixture();
  f.output("invalid");
  await f.service.get("alice", []);
  await f.settle();
  assert.equal((await f.service.get("alice", [])).pending, false);
  assert.equal(f.calls.length, 1);
  f.advance(5 * 60_000);
  f.output(JSON.stringify(activities));
  assert.equal((await f.service.get("alice", [])).pending, true);
  await f.settle();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.crons.list()).length, 1);
  assert.deepEqual((await f.service.get("alice", [])).activities, activities);
});

test("guidance updates managed task text while preserving user edits", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  const id = (await f.crons.list())[0]!.id;
  const updated = createSuggestedActivityService({ ...f.deps, context: "Acme team guidance" });
  await updated.maintain();
  assert.match((await f.crons.get(id))!.action!, /Acme team guidance/);
  await f.crons.update(id, { action: "My custom research task" });
  await createSuggestedActivityService({ ...f.deps, context: "Changed guidance" }).maintain();
  assert.equal((await f.crons.get(id))!.action, "My custom research task");
});

test("recent conversation activity prevents pausing users who do not open new chats", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  const id = (await f.crons.list())[0]!.id;
  await f.store.merge("alice", { lastSeenAt: Date.now() - 31 * 24 * 60 * 60_000, lastCadenceCheckAt: 0 });
  const session = await f.sessions.getOrCreateByThread(
    "existing-slack-dm",
    "dm",
    scopeId("personal", "alice"),
    undefined,
    "slack",
  );
  await f.sessions.addParticipant(session.id, "alice");
  await f.service.maintain();
  assert.equal((await f.crons.get(id))!.enabled, true);
});

test("old valid results are returned while a newer refresh is running", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  const id = (await f.crons.list())[0]!.id;
  await f.crons.beginFire(id, {
    fireKey: "new-fire",
    threadRef: "new-thread",
    firedAt: Date.now() + 1000,
    status: "running",
  });
  assert.deepEqual(await f.service.get("alice", []), { activities, pending: true });
});

test("fire results cannot point at another personal scope or an unrelated thread", async () => {
  for (const foreignScope of [true, false]) {
    const f = fixture();
    f.output("invalid");
    await f.service.get("alice", []);
    await f.settle();
    const cron = (await f.crons.list())[0]!;
    const original = (await f.crons.listFires(cron.id)).runs[0]!;
    const scope = scopeId("personal", foreignScope ? "bob" : "alice");
    const session = await f.sessions.getOrCreateByThread("other-thread", "dm", scope, undefined, "cron");
    const { lease } = await f.sessions.acquireLease(session.id);
    assert.ok(lease);
    await f.sessions.append(lease, {
      type: "assistant",
      scopeLabel: scope,
      payload: { text: JSON.stringify(activities) },
    });
    await f.sessions.releaseLease(lease);
    await f.crons.recordFire(cron.id, {
      ...original,
      firedAt: original.firedAt + 1000,
      status: "ok",
      sessionId: session.id,
      threadRef: foreignScope ? session.threadRef : "unrelated-fire-thread",
    });
    assert.deepEqual(await f.service.get("alice", []), { activities: [], pending: false });
  }
});
