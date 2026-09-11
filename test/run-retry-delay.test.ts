import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

const request: OrchestratorInput = {
  actor: { id: "retry-test", type: "internal" },
  conversation: { kind: "dm", threadRef: "retry-test", audience: [] },
  origin: { kind: "direct" },
  text: "test",
};

for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend}: retry deadline is respected across claim paths and preserves session order`,
    {
      skip: backend === "postgres" && !process.env.DATABASE_URL,
    },
    async (t) => {
      let connectionString = process.env.DATABASE_URL!;
      let admin: Pool | undefined;
      const schema = `retry_${randomUUID().replaceAll("-", "")}`;
      if (backend === "postgres") {
        const pg = (await import("pg")).default;
        admin = new pg.Pool({ connectionString });
        await admin.query(`CREATE SCHEMA ${schema}`);
        const url = new URL(connectionString);
        url.searchParams.set("options", `-c search_path=${schema}`);
        connectionString = url.toString();
      }
      const runtime = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(connectionString);
      let { runs } = runtime;
      const sessionId = randomUUID();
      try {
        const first = (await runs.enqueue({ sessionId, request })).run;
        const lease = await runs.claimById(first.id, "worker-1", 60_000);
        assert.ok(lease?.leaseToken);
        const now = Date.now();
        t.mock.timers.enable({ apis: ["Date"], now });
        await runs.fail(first.id, lease.leaseToken, "temporary outage", { retryAfterMs: 30_000 });
        if (backend === "postgres") {
          await runs.close?.();
          runs = createPostgresRunStore(connectionString).runs;
        }
        const later = (await runs.enqueue({ sessionId, request })).run;
        const other = (await runs.enqueue({ sessionId: randomUUID(), request })).run;
        assert.equal(await runs.claimById(first.id, "worker-2", 60_000), null);
        assert.equal(await runs.claimById(later.id, "worker-2", 60_000), null);
        const unrelated = await runs.claim("worker-2", 60_000);
        assert.equal(unrelated?.id, other.id);
        await runs.complete(other.id, unrelated!.leaseToken!, { status: "ok", sessionId: other.sessionId });
        t.mock.timers.tick(29_999);
        assert.equal(await runs.claim("worker-3", 60_000), null);
        t.mock.timers.tick(1);
        const retried = await runs.claim("worker-3", 60_000);
        assert.equal(retried?.id, first.id);
        assert.equal(retried?.attempts, 2);
        assert.equal(retried?.errorAttempts, 1);
        await runs.complete(first.id, retried!.leaseToken!, { status: "ok", sessionId });
        const next = await runs.claim("worker-3", 60_000);
        assert.equal(next?.id, later.id);
        await runs.complete(later.id, next!.leaseToken!, { status: "ok", sessionId });
      } finally {
        t.mock.timers.reset();
        await runs.close?.();
        if (admin) {
          try {
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          } finally {
            await admin.end();
          }
        }
      }
    },
  );
}
