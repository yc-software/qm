import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

const url = process.env.DATABASE_URL;

test(
  "pg session append accepts text truncated mid-emoji (lone surrogate)",
  { skip: !url && "requires Postgres" },
  async () => {
    const store = createPostgresSessionStore(url!);
    const session = await store.getOrCreateByThread(`lone-${randomUUID()}`, "dm", scopeId("personal", "ULONE"));
    try {
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      const entry = await store.append(lease, {
        type: "user",
        payload: { text: "😀".slice(0, 1) },
        scopeLabel: session.scopeId,
      });
      await store.releaseLease(lease);
      assert.deepEqual(entry.payload, { text: "\ufffd" });
      const [read] = await store.getEntries(session.id);
      assert.deepEqual(read?.payload, { text: "\ufffd" });
    } finally {
      await store.deleteSession(session.id);
    }
  },
);
