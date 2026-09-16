import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

for (const backend of ["memory", "postgres"]) {
  test(
    `${backend}: idle delivery is chosen atomically and survives duplicate admission`,
    {
      skip: backend === "postgres" && !process.env.DATABASE_URL ? "DATABASE_URL required" : false,
    },
    async () => {
      const runtime = backend === "memory" ? createMemoryRunStore() : createPostgresRunStore(process.env.DATABASE_URL!);
      const { runs } = runtime;
      const threadRef = `dm:idle-${randomUUID()}`;
      const actor = { id: "person", type: "internal" as const };
      const input = (index: number) => ({
        sessionId: `${threadRef}:task:${index}`,
        request: {
          actor,
          conversation: { kind: "dm", threadRef, audience: [actor] },
          origin: { kind: "human" },
          text: "test",
          deliveryTarget: `D1:${index}`,
        } as OrchestratorInput,
        dedupKey: `${threadRef}:${index}`,
        idleDelivery: { threadRef, target: "D1" },
      });
      try {
        const admitted = await Promise.all([1, 2, 3].map((index) => runs.enqueue(input(index))));
        assert.equal(admitted.filter(({ run }) => run.request.deliveryTarget === "D1").length, 1);
        const first = admitted[0]!;
        assert.equal((await runs.enqueue(input(1))).run.request.deliveryTarget, first.run.request.deliveryTarget);
        for (const { run } of admitted) {
          const claimed = await runs.claimById(run.id, "test", 10000);
          assert.ok(claimed);
          await runs.complete(run.id, claimed.leaseToken!, { status: "ok", reply: "done" });
        }
        const resumed = await runs.enqueue(input(4));
        assert.equal(resumed.run.request.deliveryTarget, "D1");
        await runs.withdraw(resumed.run.id);
        const explicit = await runs.enqueue({ ...input(5), idleDelivery: undefined });
        assert.equal(explicit.run.request.deliveryTarget, "D1:5");
        await runs.withdraw(explicit.run.id);
      } finally {
        if ("close" in runtime && typeof runtime.close === "function") await runtime.close();
      }
    },
  );
}
