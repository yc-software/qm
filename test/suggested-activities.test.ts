import assert from "node:assert/strict";
import test from "node:test";
import { createSuggestedActivityService, type SuggestedActivityProfile } from "../src/suggestions/activities.ts";
import { createSuggestionItems, createSuggestionsPass, SUGGESTIONS_SURFACE } from "../src/suggestions/loop-items.ts";
import { SUGGESTION_PROFILE_MIGRATIONS } from "../src/suggestions/migrations.ts";
import { createPgPool, PG_MIGRATIONS_TABLE } from "../src/persistence/pg-pool.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createLoopFireService } from "../src/loops/loop-fire.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";

const batch = (ids: string[]) =>
  ids.map((id) => ({ id, title: `Build my ${id}`, prompt: "Help me with this project.", icon: "🛠️" }));

const ids = (result: { activities: Array<{ id: string }> }) => result.activities.map((activity) => activity.id);

function fixture(opts: { enabled?: boolean } = {}) {
  let time = Date.now();
  let output = JSON.stringify(batch(["app", "brief", "deck", "hire", "plan"]));
  const store = testMap<SuggestedActivityProfile>();
  const crons = createCronStore(testMap(), { fires: createPostgresCronFireStore(testDatabaseUrl()) });
  const loops = createLoopStore(testMap());
  const ledger = createLoopItemLedger(testMap());
  let failIngest = false;
  const items: typeof ledger = {
    ...ledger,
    ingest: async (entries) => {
      if (!failIngest) return ledger.ingest(entries);
      failIngest = false;
      throw new Error("process stopped");
    },
  };
  const suggestions = createSuggestionItems({ loops, items });
  const deliveries = createDeliveryStore();
  const idempotency = createIdempotencyStore(testMap());
  const identity = createIdentityService(testMap(), { externalMembers: testMap() });
  const prompts: string[] = [];
  const settled: Promise<void>[] = [];
  const run = async (request: TurnRequest) => {
    prompts.push(request.text ?? "");
    return { status: "ok" as const, reply: output, sessionId: `s${prompts.length}` };
  };
  const loopFire = createLoopFireService({
    loops,
    crons,
    items,
    outputs: createLoopOutputStore(testMap()),
    grants: createShipGrantStore(testMap()),
    files: { listOwnedByScopes: async () => ({ files: [] }), open: async () => null } as never,
    systemPasses: {
      [SUGGESTIONS_SURFACE]: createSuggestionsPass({
        suggestions,
        seeds: async (owner) => (await store.get(owner))?.seeds ?? [],
        context: "Deployment context.",
      }),
    },
    trigger: { deliveries, idempotency, identity, run },
  });
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    now: () => time,
    crons,
    deliveries,
    identity,
    idempotency,
    run,
    fireLoop: (loopId, fireKey, cronId) => loopFire.fire(loopId, fireKey, cronId),
  });
  const service = createSuggestedActivityService({
    store,
    suggestions,
    crons,
    enabled: opts.enabled ?? true,
    now: () => time,
    scheduler: {
      notifyChanged: (id: string) => scheduler.notifyChanged(id),
      runNow: async (id: string) => {
        const result = await scheduler.runNow(id);
        if (result.started) settled.push(result.settled);
        return result;
      },
    },
  });
  return {
    service,
    scheduler,
    loopFire,
    failNextIngest: () => {
      failIngest = true;
    },
    store,
    crons,
    loops,
    items,
    prompts,
    settle: () => Promise.all(settled.splice(0)),
    advance: (ms: number) => {
      time += ms;
    },
    output: (value: string) => {
      output = value;
    },
  };
}

async function loopOf(f: ReturnType<typeof fixture>, principal = "alice") {
  return (await f.loops.get((await f.crons.get((await f.store.get(principal))!.cronId!))!.loopId!))!;
}

async function primed(f: ReturnType<typeof fixture>, principal = "alice") {
  await f.service.get(principal, [], { timezone: "America/Los_Angeles" });
  await f.settle();
  return f.service.get(principal, [], { poll: true });
}

test("a fresh user gets one hidden suggestions loop bound to the nightly cron, and items after a fire", async () => {
  const f = fixture();
  const first = await f.service.get("alice", [], { timezone: "America/Los_Angeles" });
  assert.equal(first.pending, true);
  await f.settle();
  const result = await f.service.get("alice", [], { poll: true });
  assert.deepEqual(ids(result), ["app", "brief", "deck", "hire", "plan"]);
  assert.equal(result.pending, false);
  const loop = await loopOf(f);
  assert.deepEqual(await f.loops.list(), [loop]);
  assert.equal(loop.surface, SUGGESTIONS_SURFACE);
  const cron = await f.crons.get(loop.cronId!);
  assert.equal(cron!.loopId, loop.id);
  assert.equal(cron!.ownerScopeId, scopeId("personal", "alice"));
  assert.match(f.prompts[0]!, /Deployment context\./);
  assert.equal(f.prompts.length, 1);
});

test("dismissing closes the item and a reserve item takes its place without a refill", async () => {
  const f = fixture();
  await primed(f);
  assert.equal(await f.service.dismiss("alice", "app"), true);
  assert.equal(await f.service.dismiss("alice", "app"), false);
  const result = await f.service.get("alice", [], { poll: true, refresh: true });
  assert.deepEqual(ids(result), ["brief", "deck", "hire", "plan"]);
  assert.equal(result.pending, false);
  assert.equal(f.prompts.length, 1);
});

test("dismissing past the reserve refills once, supersedes the old batch, and never suggests dismissed titles again", async () => {
  const f = fixture();
  await primed(f);
  await f.service.dismiss("alice", "app");
  await f.service.dismiss("alice", "brief");
  f.output(JSON.stringify(batch(["deck", "memo", "tour", "talk", "wiki"])));
  const refill = await f.service.get("alice", [], { poll: true, refresh: true });
  assert.equal(refill.pending, true);
  await f.service.get("alice", [], { poll: true, refresh: true });
  await f.settle();
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1]!, /Do not suggest them or close variants again:\n\["Build my app","Build my brief"\]/);
  const result = await f.service.get("alice", [], { poll: true });
  assert.deepEqual(ids(result), ["deck", "memo", "tour", "talk", "wiki"]);
  assert.equal(result.pending, false);
  const loop = await loopOf(f);
  assert.deepEqual((await f.items.byLoop(loop.id)).map((item) => `${item.sourceKey}:${item.status}`).toSorted(), [
    "app:skipped",
    "brief:skipped",
    "deck:ready",
    "memo:ready",
    "talk:ready",
    "tour:ready",
    "wiki:ready",
  ]);
  f.output(JSON.stringify(batch(["app", "brief", "hire", "plan", "deck"])));
  f.advance(5 * 60 * 60_000);
  await f.service.get("alice", []);
  await f.settle();
  assert.deepEqual(ids(await f.service.get("alice", [], { poll: true })), ["hire", "plan", "deck"]);
});

test("a three-item custom batch does not refill on every visit", async () => {
  const f = fixture();
  f.output(JSON.stringify(batch(["one", "two", "six"])));
  await primed(f);
  await f.service.get("alice", [], { refresh: true });
  await f.service.get("alice", []);
  assert.equal(f.prompts.length, 1);
});

test("a failed fire keeps serving seeds and retries only once the batch is stale", async () => {
  const f = fixture();
  f.output("not json");
  const seeds = batch(["seed"]);
  const result = await primed(f);
  assert.deepEqual(ids(await f.service.get("alice", seeds, { poll: true })), ["seed"]);
  assert.equal(result.pending, false);
  const { runs } = await f.crons.listFires((await loopOf(f)).cronId!, { limit: 1 });
  assert.match(runs[0]!.note ?? "", /the suggestions reply is not a valid list of activities/);
  await f.service.get("alice", seeds);
  assert.equal(f.prompts.length, 1);
  f.advance(3 * 60 * 60_000);
  await f.service.get("alice", seeds);
  assert.equal(f.prompts.length, 1);
  f.advance(60 * 60_000);
  await f.service.get("alice", seeds);
  await f.settle();
  assert.equal(f.prompts.length, 2);
});

test("a fire whose reply was not saved runs again when retried with the same key", async () => {
  const f = fixture();
  await primed(f);
  const loop = await loopOf(f);
  f.output(JSON.stringify(batch(["memo", "tour", "talk"])));
  f.failNextIngest();
  assert.equal((await f.loopFire.fire(loop.id, "retry")).status, "failed");
  assert.deepEqual(await f.loopFire.fire(loop.id, "retry"), { status: "silent", note: "3 suggestions" });
  assert.deepEqual(await f.loopFire.fire(loop.id, "retry"), { status: "silent", note: "duplicate fire key" });
  assert.deepEqual(ids(await f.service.get("alice", [], { poll: true })), ["memo", "tour", "talk"]);
  assert.equal(f.prompts.length, 3);
});

test("dismissed fallback seeds stay hidden", async () => {
  const f = fixture();
  f.output("not json");
  const seeds = batch(["seed", "other"]);
  await f.service.get("alice", seeds);
  await f.settle();
  assert.equal(await f.service.dismiss("alice", "seed"), true);
  assert.deepEqual(ids(await f.service.get("alice", seeds, { poll: true })), ["other"]);
});

test("the migration strips retired profile fields and keeps the cron claim", async () => {
  const owner = createPgPool(ownerUrl(testMigratedDatabaseUrl()).toString());
  try {
    await owner.q("INSERT INTO suggested_activity_profiles (tenant_id, id, json) VALUES ($1, $2, $3)", [
      TEST_TENANT,
      "bob",
      {
        timezone: "UTC",
        lastSeenAt: 1,
        cronId: "old",
        lastBootstrapAt: 2,
        managedAction: "Generate suggestions",
        dismissed: [{ id: "x", title: "X", at: 1 }],
        autoPaused: true,
      },
    ]);
    const strip = SUGGESTION_PROFILE_MIGRATIONS.at(-1)!;
    await owner.q(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [strip.id]);
    await owner.migrate(strip);
    assert.deepEqual(await owner.q("SELECT json FROM suggested_activity_profiles"), [
      { json: { timezone: "UTC", lastSeenAt: 1, cronId: "old", lastBootstrapAt: 2 } },
    ]);
  } finally {
    await owner.close();
  }
});

test("an old-style suggestions cron is replaced by a loop-bound one on its owner's next visit", async () => {
  const f = fixture();
  const unbound = await f.crons.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: scopeId("personal", "alice"),
    title: "Refresh my suggested activities",
    schedule: { cron: "0 2 * * *", timezone: "UTC" },
    action: "Generate suggestions",
  });
  await f.store.put("alice", { timezone: "UTC", lastSeenAt: 1, cronId: unbound.id, lastBootstrapAt: Date.now() });
  assert.deepEqual(ids(await primed(f)), ["app", "brief", "deck", "hire", "plan"]);
  const loop = await loopOf(f);
  assert.deepEqual(
    (await f.crons.list()).map((cron) => cron.id),
    [loop.cronId],
  );
});

test("nightly fires skip when nothing was opened since the last refresh, and when the feature is off", async () => {
  const f = fixture();
  await primed(f);
  const cron = (await f.crons.list())[0]!;
  const skipped = createSuggestedActivityService({
    store: f.store,
    suggestions: createSuggestionItems({ loops: f.loops, items: f.items }),
    crons: f.crons,
    enabled: false,
    scheduler: { notifyChanged: () => {}, runNow: async () => ({ started: false, reason: "disabled" }) as never },
  });
  assert.equal(await skipped.skipFire(cron), "suggested activities are turned off");
  assert.equal(await f.service.skipFire(cron), "no new sessions opened since the last refresh");
  f.advance(60_000);
  await f.service.get("alice", []);
  assert.equal(await f.service.skipFire(cron), undefined);
});

test("each principal has an independent loop and cron", async () => {
  const f = fixture();
  await primed(f, "alice");
  await primed(f, "dave");
  const loops = [await loopOf(f, "alice"), await loopOf(f, "dave")];
  assert.equal(new Set(loops.map((loop) => loop.owner)).size, 2);
  assert.equal(new Set(loops.map((loop) => loop.cronId)).size, 2);
});
