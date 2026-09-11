import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  test(
    `run deferral: ${backend} preserves history and retry budget while yielding capacity`,
    { skip: backend === "postgres" && !database },
    async (t) => {
      const runtime = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(database!);
      const { runs } = runtime;
      t.after(async () => {
        await runs.close?.();
      });
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const thread = randomUUID();
      const request = {
        actor: { id: "owner", type: "internal" as const },
        conversation: { kind: "dm" as const, threadRef: thread, audience: [] },
        text: "Work",
        origin: { kind: "human" as const },
      };
      const { run } = await runs.enqueue({ sessionId: thread, request, dedupKey: thread });
      const claimed = (await runs.claimById(run.id, "worker", 60_000))!;
      assert.equal(claimed.attempts, 1);
      const token = claimed.leaseToken!;
      assert.equal(await runs.defer(run.id, "wrong", 100), false);
      assert.equal(await runs.defer(run.id, token, 100), true);
      const pending = (await runs.get(run.id))!;
      assert.equal(pending.status, "pending");
      assert.equal(pending.startedAt, null);
      assert.equal(pending.attempts, 0);
      assert.equal(pending.errorAttempts, 0);
      assert.equal(pending.dedupKey, thread);
      assert.equal(await runs.claimById(run.id, "other", 60_000), null);
      assert.equal(await runs.complete(run.id, token, { status: "ok" }), false);
      now += 100;
      const resumed = (await runs.claimById(run.id, "other", 60_000))!;
      assert.equal(resumed.attempts, 1);
      assert.notEqual(resumed.leaseToken, token);
      assert.equal(await runs.defer(run.id, token, 100), false);
      await runs.complete(run.id, resumed.leaseToken!, { status: "ok" });
      assert.equal((await runs.get(run.id))?.status, "done");
    },
  );
}
