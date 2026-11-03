import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { interceptPg } from "./support/pg-intercept.ts";
import { rawPg } from "./support/raw-pg.ts";

for (const backend of ["memory", "postgres"] as const) {
  test(
    `appendMany preserves ordering, counters, and leases: ${backend}`,
    {
      skip: backend === "postgres" && !process.env.DATABASE_URL,
    },
    async () => {
      const store =
        backend === "memory"
          ? createPostgresSessionStore(testDatabaseUrl())
          : createPostgresSessionStore(process.env.DATABASE_URL!);
      const scope = scopeId("personal", "batch-test");
      const session = await store.getOrCreateByThread(`web:batch-test:${randomUUID()}`, "dm", scope);
      await store.addParticipant(session.id, "batch-test");
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      await store.append(lease, { type: "user", payload: { text: "Before batch" }, scopeLabel: scope });
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
      assert.deepEqual((await store.getEntries(session.id)).slice(1), batch);
      assert.deepEqual(await store.appendMany(lease, []), []);
      const pool = backend === "postgres" ? rawPg(process.env.DATABASE_URL) : null;
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
                { type: "user", payload: { text: "Rolled back" }, scopeLabel: scope },
                { type: "assistant", payload: { text: "Fails item insert" }, scopeLabel: scope },
              ]),
            );
            assert.equal((await store.getEntries(session.id)).length, 4);
            const after = await pool.query("SELECT messages, turns FROM sessions WHERE id = $1", [session.id]);
            assert.deepEqual(after.rows, rows);
          } finally {
            await pool.query(`ALTER TABLE items DROP CONSTRAINT ${constraint}`);
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
        await pool?.close();
      }
    },
  );
}

test(
  "a postgres append holds the lease and concurrent appends keep distinct sequences",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const store = createPostgresSessionStore(process.env.DATABASE_URL!);
    const scope = scopeId("personal", "batch-test");
    const session = await store.getOrCreateByThread(`web:batch-test:${randomUUID()}`, "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    await store.append(lease, { type: "user", payload: { text: "warm" }, scopeLabel: scope });
    await store.append(lease, { type: "assistant", payload: { text: "counted" }, scopeLabel: scope });
    const appended = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.append(lease, { type: "assistant", payload: { text: `parallel ${i}` }, scopeLabel: scope }),
      ),
    );
    assert.deepEqual(
      appended.map((entry) => entry.seq).sort((a, b) => a - b),
      [2, 3, 4, 5, 6, 7, 8, 9],
    );
    await store.releaseLease(lease);
  },
);

test(
  "an empty-session cleanup waits for an in-flight append instead of deleting its entry",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const store = createPostgresSessionStore(process.env.DATABASE_URL!);
    const ahead = createPostgresSessionStore(process.env.DATABASE_URL!, { now: () => Date.now() + 10 * 60_000 });
    const scope = scopeId("personal", "batch-test");
    const session = await store.getOrCreateByThread(`web:batch-test:${randomUUID()}`, "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const reachedCommit = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    let held = false;
    await interceptPg(t, process.env.DATABASE_URL!, async (statement, run) => {
      if (statement.text !== "COMMIT" || held) return run();
      held = true;
      reachedCommit.resolve();
      await releaseCommit.promise;
      return run();
    });
    try {
      const appending = store.append(lease, { type: "user", payload: { text: "first" }, scopeLabel: scope });
      await reachedCommit.promise;
      t.mock.restoreAll();
      const deleting = ahead.deleteSessionIfEmpty(session.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      releaseCommit.resolve();
      await appending;
      assert.equal(await deleting, false);
    } finally {
      releaseCommit.resolve();
    }
    assert.equal((await store.getEntries(session.id)).length, 1);
  },
);
