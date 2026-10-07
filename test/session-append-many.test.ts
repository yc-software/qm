import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

for (const backend of ["memory", "postgres"] as const) {
  test(
    `appendMany preserves ordering, tape, counters, and leases: ${backend}`,
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
      await store.append(lease, { type: "user", payload: { text: "Before batch" }, scopeLabel: scope });
      await store.appendTape(lease, { kind: "context_event", payload: { event: "test" }, scopeLabel: scope });
      const batch = await store.appendMany(lease, [
        { type: "assistant", payload: { text: "First answer" }, scopeLabel: scope },
        { type: "user", payload: { text: "Next question" }, scopeLabel: scope },
        { type: "assistant", payload: { text: "Next answer" }, scopeLabel: scope },
      ]);
      assert.deepEqual(
        batch.map((entry) => [entry.seq, entry.parentSeq]),
        [
          [1, 0],
          [2, 1],
          [3, 2],
        ],
      );
      assert.deepEqual((await store.getTranscriptEntries(session.id)).slice(1), batch);
      assert.deepEqual(
        (await store.getTape(session.id)).map((entry) => entry.seq),
        [0, 1, 2, 3, 4],
      );
      assert.deepEqual(await store.appendMany(lease, []), []);
      const pool = backend === "postgres" ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;
      try {
        if (pool) {
          const { rows } = await pool.query("SELECT messages, turns FROM sessions WHERE id = $1", [session.id]);
          assert.equal(Number(rows[0].messages), 4);
          assert.equal(Number(rows[0].turns), 2);
          const constraint = `batch_failure_${randomUUID().replaceAll("-", "")}`;
          await pool.query(
            `ALTER TABLE session_tape ADD CONSTRAINT ${constraint} CHECK (session_id <> '${session.id}' OR entry_seq <> 5)`,
          );
          try {
            await assert.rejects(
              store.appendMany(lease, [
                { type: "user", payload: { text: "Rolled back" }, scopeLabel: scope },
                { type: "assistant", payload: { text: "Fails tape insert" }, scopeLabel: scope },
              ]),
            );
            assert.equal((await store.getEntries(session.id)).length, 4);
            assert.equal((await store.getTape(session.id)).length, 5);
            const after = await pool.query("SELECT messages, turns FROM sessions WHERE id = $1", [session.id]);
            assert.deepEqual(after.rows, rows);
          } finally {
            await pool.query(`ALTER TABLE session_tape DROP CONSTRAINT ${constraint}`);
          }
        }
        await store.releaseLease(lease);
        await assert.rejects(
          store.appendMany(lease, [{ type: "user", payload: { text: "Rejected" }, scopeLabel: scope }]),
          /lease/,
        );
        await assert.rejects(store.appendMany(lease, []), /lease/);
        assert.equal((await store.getEntries(session.id)).length, 4);
      } finally {
        await pool?.end();
      }
    },
  );
}
