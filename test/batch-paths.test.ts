import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createMemoryMap, createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { scopeId } from "../src/types.ts";

for (const backend of ["memory", "postgres"] as const) {
  const skip = backend === "postgres" && !process.env.DATABASE_URL;
  test(
    `batch map mutations serialize duplicates and concurrent writers, and roll back: ${backend}`,
    { skip },
    async () => {
      const factory = backend === "postgres" ? createPostgresMapFactory(process.env.DATABASE_URL!) : null;
      const map =
        factory?.map<{ n: number }>(`batch_${randomUUID().replaceAll("-", "")}`) ?? createMemoryMap<{ n: number }>();
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

  test(`batch appends keep order, roll back atomically and check leases: ${backend}`, { skip }, async () => {
    const store =
      backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(process.env.DATABASE_URL!);
    const scope = scopeId("personal", "batch");
    for (let i = 0; i < 2; i++) {
      const session = await store.getOrCreateByThread(`web:batch:${randomUUID()}`, "dm", scope);
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      const entries = await store.appendMany(
        lease,
        Array.from({ length: 5 }, (_, n) => ({ kind: "UserMessage" as const, text: `message ${n}` })),
      );
      assert.deepEqual(
        entries.map((entry) => entry.seq),
        [0, 1, 2, 3, 4],
      );
      assert.deepEqual((await store.getItems(session.id)).slice(-5), entries);
      assert.deepEqual(await store.appendMany(lease, []), []);
      const batch = [5, 6].map((n) => ({ kind: "UserMessage" as const, text: `message ${n}` }));
      if (backend === "postgres") {
        const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const constraint = `items_batch_${randomUUID().replaceAll("-", "")}`;
          await pool.query(
            `ALTER TABLE items ADD CONSTRAINT ${constraint} CHECK (session_id <> '${session.id}' OR seq <> 6) NOT VALID`,
          );
          try {
            await assert.rejects(store.appendMany(lease, batch));
            assert.equal((await store.getItems(session.id)).length, 5);
          } finally {
            await pool.query(`ALTER TABLE items DROP CONSTRAINT ${constraint}`);
          }
        } finally {
          await pool.end();
        }
      }
      await store.releaseLease(lease);
      await assert.rejects(store.appendMany(lease, batch), /lease/);
    }
  });
  test(`session goals live on the session row behind its lease: ${backend}`, { skip }, async () => {
    const store =
      backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(process.env.DATABASE_URL!);
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
      const { lease } = await store.acquireLease(id);
      assert.ok(lease);
      await store.setGoal(lease, goal(`first ${i}`));
      const notice = {
        kind: "Wake" as const,
        wakeCause: "system" as const,
        body: { kind: "goal_cancelled", objective: `goal ${i}`, cancelledBy: "u" },
      };
      await store.setGoal(lease, { ...goal(`goal ${i}`), status: "paused" }, [notice]);
      await store.releaseLease(lease);
      await assert.rejects(store.setGoal(lease, goal("stale lease"), [notice]), /valid session lease/);
      assert.deepEqual(
        (await store.getItems(id)).map((item) => ({ kind: item.kind, wakeCause: item.wakeCause, body: item.body })),
        [notice],
        "the notice lands with the goal and not with a rejected write",
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

  test(`latest runs batch matches single reads including private messages and ties: ${backend}`, { skip }, async () => {
    const runtime = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(process.env.DATABASE_URL!);
    const { runs } = runtime;
    const ids = [`batch:${randomUUID()}`, `batch:${randomUUID()}`];
    const actor = { id: "internal:batch", type: "internal" as const };
    try {
      for (const id of ids)
        for (const privateSessionMessage of [false, true])
          await runs.enqueue({
            sessionId: id,
            request: {
              actor,
              conversation: { kind: "dm", threadRef: id, audience: [actor] },
              origin: { kind: "direct" },
              text: "batch",
              ...(privateSessionMessage ? { privateSessionMessage: true as const } : {}),
            },
          });
      for (const excludePrivateMessages of [false, true]) {
        const batch = await runs.latestForThreads([...ids, "missing", ids[0]!], { excludePrivateMessages });
        assert.equal(batch.size, 2);
        for (const id of ids)
          assert.deepEqual(batch.get(id), await runs.latestForThread(id, { excludePrivateMessages }));
      }
      assert.deepEqual(await runs.latestForThreads([]), new Map());
    } finally {
      await runs.close?.();
    }
  });
}
