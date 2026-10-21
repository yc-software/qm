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
import { singleProcessDeps } from "./support/single-process.ts";

const activities = ["app", "brief", "deck", "hire", "plan"].map((id) => ({
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
    ...singleProcessDeps(),
    now: () => time,
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
  const initial = await f.service.get("alice", [], { timezone: "America/Los_Angeles" });
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

test("opening a new session refreshes stale suggestions; fresh ones are served as-is", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  f.advance(60 * 60_000);
  assert.deepEqual(await f.service.get("alice", []), { activities, pending: false });
  assert.equal(f.calls.length, 1);
  f.advance(4 * 60 * 60_000);
  assert.deepEqual(await f.service.get("alice", []), { activities, pending: true });
  await f.settle();
  assert.equal(f.calls.length, 2);
});

test("the nightly fire skips when no new session was opened since the last refresh (polls do not count) or the feature is off", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  const cron = (await f.crons.list())[0]!;
  assert.equal(await f.service.skipFire(cron), "no new sessions opened since the last refresh");
  f.advance(60_000);
  await f.service.get("alice", [], { poll: true });
  assert.equal(await f.service.skipFire(cron), "no new sessions opened since the last refresh");
  f.advance(60_000);
  await f.service.get("alice", []);
  assert.equal(await f.service.skipFire(cron), undefined);
  assert.equal(
    await createSuggestedActivityService({ ...f.deps, enabled: false }).skipFire(cron),
    "suggested activities are turned off",
  );
  assert.equal(await f.service.skipFire({ ...cron, id: "someone-elses" }), undefined);
});

test("invalid first results retry after cooldown without creating another cron", async () => {
  const f = fixture();
  f.output("invalid");
  await f.service.get("alice", []);
  await f.settle();
  assert.equal((await f.service.get("alice", [])).pending, false);
  assert.equal(f.calls.length, 1);
  f.advance(4 * 60 * 60_000);
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
  await createSuggestedActivityService({ ...f.deps, context: "Acme team guidance" }).get("alice", []);
  assert.match((await f.crons.get(id))!.action!, /Acme team guidance/);
  await f.crons.update(id, { action: "My custom research task" });
  await createSuggestedActivityService({ ...f.deps, context: "Changed guidance" }).get("alice", []);
  assert.equal((await f.crons.get(id))!.action, "My custom research task");
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

test("the newest valid run wins over older ones", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  const newer = activities.map((activity) => ({ ...activity, title: `${activity.title} today` }));
  f.output(JSON.stringify(newer));
  f.advance(5);
  await f.deps.scheduler.runNow((await f.crons.list())[0]!.id);
  await f.settle();
  assert.deepEqual(await f.service.get("alice", []), { activities: newer, pending: false });
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

test("dismissed suggestions stay hidden across restarts, leave the reserve, and reach the next run's task", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  assert.equal(await f.service.dismiss("alice", "brief"), true);
  assert.equal(await f.service.dismiss("alice", "missing"), false);
  assert.equal(await f.service.dismiss("bob", "brief"), false);
  const remaining = activities.filter((activity) => activity.id !== "brief");
  assert.deepEqual(await createSuggestedActivityService(f.deps).get("alice", []), {
    activities: remaining,
    pending: false,
  });
  assert.deepEqual((await f.service.get("bob", [])).activities, []);
  const cron = (await f.crons.list()).find((candidate) => candidate.owner === "alice")!;
  assert.ok(cron.action!.includes(JSON.stringify(["Build my brief"])));
  await f.crons.update(cron.id, { action: "My custom research task" });
  await f.service.dismiss("alice", "deck");
  assert.equal((await f.crons.get(cron.id))!.action, "My custom research task");
});

test("dismissed fallback seeds are hidden too", async () => {
  const f = fixture();
  f.output("invalid");
  await f.service.get("alice", activities);
  await f.settle();
  assert.equal(await f.service.dismiss("alice", "app"), true);
  assert.deepEqual((await f.service.get("alice", activities)).activities, activities.slice(1));
});

test("a refresh runs once per batch of dismissals and never while a run is in flight", async () => {
  const f = fixture();
  await f.service.get("alice", []);
  await f.settle();
  const cron = (await f.crons.list())[0]!;
  f.advance(60_000);
  assert.equal((await f.service.get("alice", [], { poll: true, refresh: true })).pending, false);
  await f.service.dismiss("alice", "app");
  f.advance(1_000);
  await f.service.dismiss("alice", "brief");
  f.advance(1_000);
  const fresh = activities.map((activity) => ({ ...activity, id: `${activity.id}-next` }));
  f.output(JSON.stringify(fresh));
  const results = await Promise.all([
    f.service.get("alice", [], { poll: true, refresh: true }),
    f.service.get("alice", [], { poll: true, refresh: true }),
  ]);
  assert.deepEqual(
    results.map((result) => result.pending),
    [true, true],
  );
  await f.settle();
  assert.equal(f.calls.length, 2);
  f.advance(1_000);
  assert.deepEqual(await f.service.get("alice", [], { poll: true, refresh: true }), {
    activities: fresh,
    pending: false,
  });
  await f.service.dismiss("alice", "app-next");
  f.advance(1_000);
  await f.crons.beginFire(cron.id, { fireKey: "in-flight", threadRef: "in-flight", firedAt: 0, status: "running" });
  assert.equal((await f.service.get("alice", [], { poll: true, refresh: true })).pending, true);
  await f.settle();
  assert.equal(f.calls.length, 2);
});
