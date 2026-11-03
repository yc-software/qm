import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

for (const backend of ["memory", "postgres"] as const) {
  test(
    `appendMany preserves ordering and counters, and rejects writes to a deleted session: ${backend}`,
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
      const writer = { sessionId: session.id };
      await store.append(writer, { kind: "UserMessage", text: "Before batch" });
      const batch = await store.appendMany(writer, [
        { kind: "AgentMessage", text: "First answer" },
        { kind: "UserMessage", text: "Next question" },
        { kind: "AgentMessage", text: "Next answer" },
      ]);
      assert.deepEqual(
        batch.map((item) => [item.seq, item.kind, item.text]),
        [
          [1, "AgentMessage", "First answer"],
          [2, "UserMessage", "Next question"],
          [3, "AgentMessage", "Next answer"],
        ],
      );
      assert.deepEqual((await store.getItems(session.id)).slice(1), batch);
      assert.deepEqual(await store.appendMany(writer, []), []);
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
              store.appendMany(writer, [
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
        await store.deleteSession(session.id);
        await assert.rejects(store.appendMany(writer, [{ kind: "UserMessage", text: "Rejected" }]), /foreign key/);
        assert.equal((await store.getItems(session.id)).length, 0);
      } finally {
        await pool?.end();
      }
    },
  );
}

test(
  "a postgres append takes the session lock and writes in five statements, and concurrent appends keep distinct sequences",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const store = createPostgresSessionStore(process.env.DATABASE_URL!);
    const scope = scopeId("personal", "batch-test");
    const session = await store.getOrCreateByThread(`web:batch-test:${randomUUID()}`, "dm", scope);
    const writer = { sessionId: session.id };
    await store.append(writer, { kind: "UserMessage", text: "warm" });
    const query = pg.Client.prototype.query;
    let statements = 0;
    pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<typeof query>) {
      statements++;
      return query.apply(this, args);
    } as typeof query;
    try {
      await store.append(writer, { kind: "AgentMessage", text: "counted" });
    } finally {
      pg.Client.prototype.query = query;
    }
    assert.equal(statements, 5);
    const appended = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.append(writer, { kind: "AgentMessage", text: `parallel ${i}` })),
    );
    assert.deepEqual(
      appended.map((entry) => entry.seq).sort((a, b) => a - b),
      [2, 3, 4, 5, 6, 7, 8, 9],
    );
  },
);

test(
  "an empty-session cleanup waits for an in-flight append instead of deleting its entry",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const store = createPostgresSessionStore(process.env.DATABASE_URL!);
    const ahead = createPostgresSessionStore(process.env.DATABASE_URL!, { now: () => Date.now() + 10 * 60_000 });
    const scope = scopeId("personal", "batch-test");
    const session = await store.getOrCreateByThread(`web:batch-test:${randomUUID()}`, "dm", scope);
    const writer = { sessionId: session.id };
    const query = pg.Client.prototype.query;
    const reachedCommit = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    let held = false;
    pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<typeof query>) {
      if (args[0] === "COMMIT" && !held) {
        held = true;
        reachedCommit.resolve();
        return releaseCommit.promise.then(() => query.apply(this, args));
      }
      return query.apply(this, args);
    } as typeof query;
    try {
      const appending = store.append(writer, { kind: "UserMessage", text: "first" });
      await reachedCommit.promise;
      pg.Client.prototype.query = query;
      const deleting = ahead.deleteSessionIfEmpty(session.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      releaseCommit.resolve();
      await appending;
      assert.equal(await deleting, false);
    } finally {
      pg.Client.prototype.query = query;
      releaseCommit.resolve();
    }
    assert.equal((await store.getItems(session.id)).length, 1);
  },
);
