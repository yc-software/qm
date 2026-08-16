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
