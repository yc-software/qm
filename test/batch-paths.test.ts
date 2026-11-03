import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";

for (const backend of ["memory", "postgres"] as const) {
  const skip = backend === "postgres" && !process.env.DATABASE_URL;
  test(
    `batch map mutations serialize duplicates and concurrent writers, and roll back: ${backend}`,
    { skip },
    async () => {
      const factory = backend === "postgres" ? createPostgresMapFactory(process.env.DATABASE_URL!) : null;
      const map = factory?.map<{ n: number }>(`batch_${randomUUID().replaceAll("-", "")}`) ?? testMap<{ n: number }>();
      try {
        const increment = (value: { n: number } | null) => ({ n: (value?.n ?? 0) + 1 });
        assert.deepEqual(
          await map.mutateMany([
            { id: "a", apply: increment },
            { id: "a", apply: increment },
          ]),
          [{ n: 1 }, { n: 2 }],
        );
        await Promise.all(
          Array.from({ length: 10 }, () =>
            map.mutateMany([
              { id: "a", apply: increment },
              { id: "b", apply: increment },
            ]),
          ),
        );
        await Promise.all([map.mutateMany([{ id: "a", apply: increment }]), map.update!("a", increment)]);
        assert.deepEqual(await map.get("a"), { n: 14 });
        assert.deepEqual(await map.get("b"), { n: 10 });
        await assert.rejects(
          map.mutateMany([
            {
              id: "a",
              apply: (value) => {
                value!.n = 999;
                return value!;
              },
            },
            {
              id: "c",
              apply: () => {
                throw new Error("rollback");
              },
            },
          ]),
          /rollback/,
        );
        assert.deepEqual(await map.get("a"), { n: 14 });
        assert.equal(await map.get("c"), null);
        assert.deepEqual(await map.mutateMany([]), []);
      } finally {
        await factory?.pool.close();
      }
    },
  );

  test(`batch appends keep order and roll back atomically: ${backend}`, { skip }, async () => {
    const store =
      backend === "memory"
        ? createPostgresSessionStore(testDatabaseUrl())
        : createPostgresSessionStore(process.env.DATABASE_URL!);
    const scope = scopeId("personal", "batch");
    for (let i = 0; i < 2; i++) {
      const session = await store.getOrCreateByThread(`web:batch:${randomUUID()}`, "dm", scope);
      const writer = { sessionId: session.id };
      const entries = await store.appendMany(
        writer,
        Array.from({ length: 5 }, (_, n) => ({ kind: "UserMessage" as const, text: `message ${n}` })),
      );
      assert.deepEqual(
        entries.map((entry) => entry.seq),
        [0, 1, 2, 3, 4],
      );
      assert.deepEqual((await store.getItems(session.id)).slice(-5), entries);
      assert.deepEqual(await store.appendMany(writer, []), []);
      const batch = [5, 6].map((n) => ({ kind: "UserMessage" as const, text: `message ${n}` }));
      if (backend === "postgres") {
        const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const constraint = `items_batch_${randomUUID().replaceAll("-", "")}`;
          await pool.query(
            `ALTER TABLE items ADD CONSTRAINT ${constraint} CHECK (session_id <> '${session.id}' OR seq <> 6) NOT VALID`,
          );
          try {
            await assert.rejects(store.appendMany(writer, batch));
            assert.equal((await store.getItems(session.id)).length, 5);
          } finally {
            await pool.query(`ALTER TABLE items DROP CONSTRAINT ${constraint}`);
          }
        } finally {
          await pool.end();
        }
      }
    }
  });
  test(`session goals live on the session row: ${backend}`, { skip }, async () => {
    const store =
      backend === "memory"
        ? createPostgresSessionStore(testDatabaseUrl())
        : createPostgresSessionStore(process.env.DATABASE_URL!);
    const scope = scopeId("personal", "batch");
    const goal = (objective: string) => ({
      objective,
      status: "active" as const,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const session = await store.getOrCreateByThread(`web:batch:${randomUUID()}`, "dm", scope);
      ids.push(session.id);
    }
    for (const [i, id] of ids.slice(0, 2).entries()) {
      const writer = { sessionId: id };
      await store.setGoal(writer, goal(`first ${i}`));
      const notice = {
        kind: "Wake" as const,
        wakeCause: "system" as const,
        body: { kind: "goal_cancelled", objective: `goal ${i}`, cancelledBy: "u" },
      };
      await store.setGoal(writer, { ...goal(`goal ${i}`), status: "paused" }, [notice]);
      assert.deepEqual(
        (await store.getItems(id)).map(({ kind, wakeCause, body }) => ({ kind, wakeCause, body })),
        [notice],
        "the notice lands with the goal",
      );
    }
    const found = await store.goals([...ids, "missing"]);
    assert.deepEqual(
      [...found.entries()].sort(([a], [b]) => ids.indexOf(a) - ids.indexOf(b)),
      [
        [ids[0], { ...goal("goal 0"), status: "paused" }],
        [ids[1], { ...goal("goal 1"), status: "paused" }],
      ],
    );
    assert.deepEqual(await store.goals([]), new Map());
  });
}
