import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";

test("memory read epochs increment atomically without a lease or transcript mutation", async () => {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("epoch", "dm", "personal:alice");
  const other = await store.getOrCreateByThread("other-epoch", "dm", "personal:alice");
  assert.equal(await store.memoryReadEpoch(session.id), 0);
  const { lease } = await store.acquireLease(session.id, "turn");
  assert.ok(lease);
  const before = structuredClone(await store.get(session.id));
  await Promise.all(Array.from({ length: 40 }, () => store.noteMemoryRead(session.id)));
  assert.equal(await store.memoryReadEpoch(session.id), 40);
  assert.equal(await store.memoryReadEpoch(other.id), 0);
  assert.deepEqual(await store.get(session.id), before);
  assert.deepEqual(await store.getEntries(session.id), []);
  assert.deepEqual(await store.getTape(session.id), []);
  assert.equal((await store.peekLease(session.id))?.holder, "turn");
  await store.releaseLease(lease);
  await store.deleteSession(session.id);
  await assert.rejects(store.noteMemoryRead(session.id), /Session not found/);
  await assert.rejects(store.memoryReadEpoch(session.id), /Session not found/);
});
