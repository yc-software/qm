import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { scopeId } from "../src/types.ts";

function input(overrides: Record<string, unknown> = {}) {
  return {
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    processId: "p-1",
    command: "bg: npm run build",
    threadRef: "thread-1",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

test("create stores a monitor with cursor 0 and enabled", async () => {
  const store = createMonitorStore();
  const m = await store.create(input());
  assert.equal(m.cursor, 0);
  assert.equal(m.enabled, true);
  assert.equal(m.processId, "p-1");
  assert.equal(m.threadRef, "thread-1");
  assert.equal((await store.enabled()).length, 1);
});

test("create rejects assigning a different owner without consent (anti-escalation)", async () => {
  const store = createMonitorStore();
  await assert.rejects(() => store.create(input({ owner: "U2" })), /consent/);
});

test("advance moves the cursor, holds/clears the tail, and records the fire time", async () => {
  const store = createMonitorStore();
  const m = await store.create(input());
  await store.advance(m.id, { cursor: 42, tail: "partial li" });
  let got = await store.get(m.id);
  assert.equal(got?.cursor, 42);
  assert.equal(got?.tail, "partial li");
  assert.equal(got?.lastFiredAt, undefined);
  await store.advance(m.id, { cursor: 50, firedAt: 123 });
  got = await store.get(m.id);
  assert.equal(got?.cursor, 50);
  assert.equal(got?.tail, undefined);
  assert.equal(got?.lastFiredAt, 123);
});

test("setEnabled(false) removes a monitor from the enabled set but keeps the record", async () => {
  const store = createMonitorStore();
  const m = await store.create(input());
  await store.setEnabled(m.id, false);
  assert.equal((await store.enabled()).length, 0);
  assert.ok(await store.get(m.id));
});

test("recordError keeps the monitor armed and surfaces the error", async () => {
  const store = createMonitorStore();
  const m = await store.create(input());
  await store.recordError(m.id, "boom");
  const got = await store.get(m.id);
  assert.equal(got?.lastError, "boom");
  assert.equal(got?.enabled, true);
});
