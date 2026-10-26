import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

for (const backend of ["memory", "postgres"] as const) {
  test(
    `appendMany preserves ordering, counters, and leases: ${backend}`,
    {
      skip: backend === "postgres" && !process.env.DATABASE_URL,
    },
    async () => {
      const store =
        backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(process.env.DATABASE_URL!);
      const scope = scopeId("personal", "batch-test");
      const session = await store.getOrCreateByThread(`web:batch-test:${randomUUID()}`, "dm", scope);
      await store.addParticipant(session.id, "batch-test");
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      await store.append(lease, { kind: "UserMessage", text: "Before batch" });
      const batch = await store.appendMany(lease, [
        { kind: "AgentMessage", text: "First answer" },
        { kind: "UserMessage", text: "Next question" },
        { kind: "AgentMessage", text: "Next answer" },
      ]);
      assert.deepEqual(
        batch.map((item) => item.seq),
        [1, 2, 3],
      );
      assert.deepEqual((await store.getItems(session.id)).slice(1), batch);
      assert.deepEqual(await store.appendMany(lease, []), []);
      const pool = backend === "postgres" ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;
      try {
        if (pool) {
          const { rows } = await pool.query("SELECT messages, turns FROM sessions WHERE id = $1", [session.id]);
          assert.equal(Number(rows[0].messages), 4);
          assert.equal(Number(rows[0].turns), 2);
          const constraint = `batch_failure_${randomUUID().replaceAll("-", "")}`;
          await pool.query(
            `ALTER TABLE items ADD CONSTRAINT ${constraint} CHECK (session_id <> '${session.id}' OR seq <> 5)`,
          );
          try {
            await assert.rejects(
              store.appendMany(lease, [
                { kind: "UserMessage", text: "Rolled back" },
                { kind: "AgentMessage", text: "Fails item insert" },
              ]),
            );
            assert.equal((await store.getItems(session.id)).length, 4);
            const after = await pool.query("SELECT messages, turns FROM sessions WHERE id = $1", [session.id]);
            assert.deepEqual(after.rows, rows);
          } finally {
            await pool.query(`ALTER TABLE items DROP CONSTRAINT ${constraint}`);
          }
        }
        await store.releaseLease(lease);
        await assert.rejects(store.appendMany(lease, [{ kind: "UserMessage", text: "Rejected" }]), /lease/);
        await assert.rejects(store.appendMany(lease, []), /lease/);
        assert.equal((await store.getItems(session.id)).length, 4);
      } finally {
        await pool?.end();
      }
    },
  );
}
