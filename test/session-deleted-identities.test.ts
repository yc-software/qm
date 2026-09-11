import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;
test("memory deletion waits for the complete session-locked operation and rechecks empty deletion", async () => {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("locked-session", "dm", scopeId("personal", "owner"));
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const operation = store.withSessionLocks!([session.id], async () => {
    entered.resolve();
    await finish.promise;
    assert.ok(await store.get(session.id));
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    await store.append(lease, { type: "user", payload: { text: "kept" }, scopeLabel: session.scopeId });
    await store.releaseLease(lease);
  });
  await entered.promise;
  const deletion = store.deleteSessionIfEmpty(session.id);
  finish.resolve();
  await operation;
  assert.equal(await deletion, false);
  assert.ok(await store.get(session.id));
  await store.deleteSession(session.id);
  assert.equal(await store.wasDeleted(session.id), true);
});
for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend}: deleted reservations cannot recreate session identities`,
    { skip: backend === "postgres" && !database },
    async () => {
      const store = backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(database!);
      const scope = scopeId("personal", "owner");
      for (const emptyOnly of [false, true]) {
        const id = randomUUID();
        const thread = `deleted-identity:${id}`;
        await store.getOrCreateByThread(thread, "dm", scope, undefined, "web", id);
        assert.equal(await store.wasDeleted(id), false);
        const { lease } = await store.acquireLease(id);
        assert.ok(lease);
        assert.equal(await store.deleteSessionIfEmpty(id), false);
        assert.equal(await store.wasDeleted(id), false);
        await store.releaseLease(lease);
        if (emptyOnly) assert.equal(await store.deleteSessionIfEmpty(id), true);
        else await store.deleteSession(id);
        assert.equal(await store.wasDeleted(id), true);
        const recovered = backend === "memory" ? store : createPostgresSessionStore(database!);
        await assert.rejects(
          recovered.getOrCreateByThread(thread, "dm", scope, undefined, "web", id),
          /deleted session/,
        );
        assert.equal(await recovered.get(id), null);
        const replacement = await recovered.getOrCreateByThread(thread, "dm", scope);
        assert.notEqual(replacement.id, id);
        await recovered.deleteSession(replacement.id);
      }
    },
  );
}
