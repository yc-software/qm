import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
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

  test(`batch appends keep recent-entry boundaries per session: ${backend}`, { skip }, async () => {
    const store =
      backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(process.env.DATABASE_URL!);
    const scope = scopeId("personal", "batch");
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const session = await store.getOrCreateByThread(`web:batch:${randomUUID()}`, "dm", scope);
      ids.push(session.id);
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      const entries = await store.appendMany(
        lease,
        Array.from({ length: 5 }, (_, n) => ({
          type: "user" as const,
          payload: { text: `message ${n}` },
          scopeLabel: scope,
        })),
      );
      assert.equal(entries.length, 5);
      await store.releaseLease(lease);
    }
    const recent = await store.getRecentEntries([...ids, "missing", ids[0]!], 2);
    for (const id of ids) assert.deepEqual(recent.get(id), await store.getEntries(id, { sinceSeq: 2 }));
    assert.deepEqual(recent.get("missing"), []);
    assert.deepEqual(await store.getRecentEntries([], 2), new Map());
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
