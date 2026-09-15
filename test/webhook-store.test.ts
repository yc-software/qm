import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type Webhook } from "../src/types.ts";

const base = {
  ownerScopeId: scopeId("personal", "U1"),
  owner: "U1",
  createdBy: "U1",
  action: "triage the issue",
  verification: { scheme: "github" as const, secret: "s" },
};

test("create stores an enabled webhook with a generated id", async () => {
  const store = createWebhookStore();
  const wh = await store.create(base);
  assert.ok(wh.id);
  assert.equal(wh.enabled, true);
  assert.equal((await store.get(wh.id))?.owner, "U1");
  assert.equal((await store.list()).length, 1);
});

test("create rejects filters that could silently weaken or suppress the webhook", async () => {
  const store = createWebhookStore();
  await assert.rejects(
    () => store.create({ ...base, filters: [{ path: "", in: ["opened"] }] }),
    /filter requires a path/,
  );
  await assert.rejects(
    () => store.create({ ...base, filters: [{ path: "action", in: [] }] }),
    /filter requires a path/,
  );
  await assert.rejects(
    () => store.create({ ...base, filters: [{ path: "action", in: [""] }] }),
    /filter requires a path/,
  );
});

test("anti-escalation: a different owner requires that owner's consent", async () => {
  const store = createWebhookStore();
  await assert.rejects(store.create({ ...base, owner: "U2", createdBy: "U1" }), /consent/);
  const wh = await store.create({ ...base, owner: "U2", createdBy: "U1", ownerConsentedAt: Date.now() });
  assert.equal(wh.owner, "U2");
});

test("setEnabled disables a webhook", async () => {
  const store = createWebhookStore();
  const wh = await store.create(base);
  await store.setEnabled(wh.id, false);
  assert.equal((await store.get(wh.id))?.enabled, false);
});

test("recordFire stamps last fire + delivery id, and sets/clears the error note", async () => {
  const store = createWebhookStore();
  const wh = await store.create(base);
  await store.recordFire(wh.id, { at: 123, deliveryId: "d-9", error: "refused: nope" });
  assert.equal((await store.get(wh.id))?.lastFiredAt, 123);
  assert.equal((await store.get(wh.id))?.lastDeliveryId, "d-9");
  assert.equal((await store.get(wh.id))?.lastError, "refused: nope");
  await store.recordFire(wh.id, { at: 456, deliveryId: "d-10" });
  assert.equal((await store.get(wh.id))?.lastError, undefined);
});

test("create dedups a byte-identical retry: same input inserts once and returns the same id", async () => {
  const store = createWebhookStore();
  const a = await store.create(base);
  const b = await store.create(base);
  assert.equal(b.id, a.id, "the retry returns the first record, not a new one");
  assert.equal((await store.list()).length, 1, "only one webhook was inserted");
});

test("create treats empty filters and absent filters as the same registration", async () => {
  const store = createWebhookStore();
  const a = await store.create({ ...base, filters: [] });
  const b = await store.create(base);
  assert.equal(b.id, a.id);
  assert.equal((await store.list()).length, 1);
});

test("create does NOT dedup when any keyed field differs (distinct requests stay distinct)", async () => {
  const store = createWebhookStore();
  const a = await store.create(base);
  const diffAction = await store.create({ ...base, action: "do something else" });
  const diffVerification = await store.create({ ...base, verification: { scheme: "stripe", secret: "s" } });
  const diffFilters = await store.create({ ...base, filters: [{ path: "action", in: ["opened"] }] });
  const diffDest = await store.create({ ...base, destination: { type: "slack", target: "C1" } });
  const ids = new Set([a.id, diffAction.id, diffVerification.id, diffFilters.id, diffDest.id]);
  assert.equal(ids.size, 5, "each distinct request is its own record");
  assert.equal((await store.list()).length, 5);
});

test("a duplicate create returns the existing record WITHOUT clobbering its fire state", async () => {
  const store = createWebhookStore();
  const a = await store.create(base);
  await store.recordFire(a.id, { at: 123, deliveryId: "d-9" });
  const b = await store.create(base); // a blind retry after the webhook already fired
  assert.equal(b.id, a.id);
  assert.equal(b.lastFiredAt, 123, "the retry must not reset the already-fired webhook");
  assert.equal(b.lastDeliveryId, "d-9");
  assert.equal((await store.list()).length, 1);
});

test("create dedup survives a 'restart': a fresh store over the same backing still matches", async () => {
  const backing = createMemoryMap<Webhook>();
  const a = await createWebhookStore(backing).create(base);
  const b = await createWebhookStore(backing).create(base);
  assert.equal(b.id, a.id, "the content-keyed id dedups across a process restart");
  assert.equal((await backing.all()).length, 1);
});

test("re-creating a byte-identical disabled webhook re-enables it", async () => {
  const store = createWebhookStore();
  const input = {
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
    action: "triage",
    verification: { scheme: "github" as const, secret: "s1" },
  };
  const first = await store.create(input);
  await store.setEnabled(first.id, false);
  const second = await store.create(input);
  assert.equal(second.id, first.id);
  assert.equal(second.enabled, true);
  assert.equal((await store.get(first.id))?.enabled, true);
});

test("history survives reconstruction without entering webhook listings", async () => {
  const history = createMemoryMap<import("../src/webhooks/webhook-store.ts").WebhookHistory>();
  const backing = createMemoryMap<Webhook>();
  const store = createWebhookStore(backing, history);
  const wh = await store.create(base);
  const event = { deliveryId: "one", receivedAt: 1, payload: "hello" };
  await store.recordEvent(wh.id, event);
  const restored = createWebhookStore(backing, history);
  assert.deepEqual(await restored.listEvents(wh.id), [event]);
  assert.equal(JSON.stringify(await restored.list()).includes("hello"), false);
  assert.deepEqual(await restored.listEvents("unknown"), []);
});

test("history atomically retains the latest 50 and bounds payloads", async () => {
  const store = createWebhookStore();
  const wh = await store.create(base);
  await Promise.all(
    Array.from({ length: 70 }, (_, i) =>
      store.recordEvent(wh.id, {
        deliveryId: `delivery-${i}`,
        receivedAt: i,
        payload: "x".repeat(20_000),
      }),
    ),
  );
  const events = await store.listEvents(wh.id);
  assert.equal(events.length, 50);
  assert.equal(events[0]?.receivedAt, 69);
  assert.equal(events[1]?.payload.length, 16_100);
  assert.equal(events.at(-1)?.receivedAt, 20);
  events.pop();
  assert.equal((await store.listEvents(wh.id)).length, 50);
});

test("a repeated receipt preserves the original payload and timestamp", async () => {
  const store = createWebhookStore();
  const wh = await store.create(base);
  const original = { deliveryId: "one", receivedAt: 1, payload: "hello" };
  await store.recordEvent(wh.id, original);
  await store.recordEvent(wh.id, { ...original, receivedAt: 2, payload: "changed" });
  assert.deepEqual(await store.listEvents(wh.id), [original]);
});
