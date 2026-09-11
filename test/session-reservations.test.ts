import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  test(
    `reserved sessions: ${backend} retries retain identity and collisions never overwrite`,
    {
      skip: backend === "postgres" && !database,
    },
    async () => {
      const first = backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(database!);
      const second = backend === "memory" ? first : createPostgresSessionStore(database!);
      const id = randomUUID();
      const thread = `web:owner:${id}`;
      const replies = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? first : second).getOrCreateByThread(thread, "dm", "personal:owner", undefined, "web", id),
        ),
      );
      assert.ok(replies.every((session) => session.id === id));
      await assert.rejects(first.getOrCreateByThread(thread, "dm", "personal:owner", "changed", "slack", randomUUID()));
      await assert.rejects(first.getOrCreateByThread(thread, "dm", "personal:other", undefined, "web", id));
      await assert.rejects(first.getOrCreateByThread(thread, "group", "personal:owner", undefined, "web", id));
      await assert.rejects(
        first.getOrCreateByThread(`${thread}-different`, "dm", "personal:owner", undefined, "web", id),
      );
      await assert.rejects(first.getOrCreateByThread(thread, "dm", "personal:owner", undefined, "web", "invalid"));
      const stored = await second.get(id);
      assert.equal(stored?.threadRef, thread);
      assert.equal(stored?.scopeId, "personal:owner");
      assert.equal(stored?.channelName, undefined);
      assert.equal(stored?.surface, "web");
      assert.equal(await second.getByThread(`${thread}-different`), null);
      assert.equal((await first.getOrCreateByThread(thread, "dm", "personal:owner")).id, id);
    },
  );
}
