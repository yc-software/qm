import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  createMemoryCoordinationRepository,
  createPostgresCoordinationRepository,
} from "../src/coordination/repository.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";

const database = process.env.COORDINATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend} coordination transactions reject expired run leases without committing events`,
    { skip: backend !== "memory" && !database },
    async (t) => {
      let databaseUrl = database;
      if (backend !== "memory") {
        const admin = createPgPool(database!);
        const schema = `coord_fence_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE SCHEMA ${schema}`);
        const url = new URL(database!);
        url.searchParams.set("options", `-c search_path=${schema}`);
        databaseUrl = url.toString();
        t.after(async () => {
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          await admin.close();
        });
      }
      const pool = createPgPool(databaseUrl ?? "postgres://unused");
      const runtime = backend === "postgres" ? createPostgresRunStore(databaseUrl!) : createMemoryRunStore();
      t.after(() => pool.close());
      t.after(() => runtime.runs.close?.());
      const repository =
        backend === "memory"
          ? createMemoryCoordinationRepository({ runs: runtime.runs })
          : createPostgresCoordinationRepository(pool, randomUUID());
      const id = randomUUID();
      const { run } = await runtime.runs.enqueue({
        sessionId: id,
        request: {
          actor: { id: "owner", type: "internal" },
          conversation: { kind: "dm", threadRef: id, audience: [] },
          text: "Work",
          origin: { kind: "human" },
        },
      });
      const claimed = (await runtime.runs.claimById(run.id, "worker", 60_000))!;
      assert.ok(claimed);
      assert.equal(await runtime.runs.bindSession(run.id, claimed.leaseToken!, id), true);
      const fence = { runId: run.id, attempt: claimed.attempts, sessionId: id, leaseToken: claimed.leaseToken! };
      await repository.transaction(
        [],
        async (tx) => {
          await tx.event("message", "accepted", Date.now());
        },
        fence,
      );
      const before = await repository.events(0, 200);
      assert.equal(before.length, 1);
      for (const invalid of [
        { ...fence, attempt: fence.attempt + 1 },
        { ...fence, sessionId: "other" },
        { ...fence, leaseToken: "replaced-token" },
      ])
        await assert.rejects(
          repository.transaction([], async () => assert.fail("Invalid fence entered transaction"), invalid),
          { code: "coordination_run_expired" },
        );
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      await assert.rejects(
        repository.transaction(
          [],
          async (tx) => {
            await tx.event("message", "rolled-back", Date.now());
            t.mock.timers.tick(60_001);
          },
          fence,
        ),
        { code: "coordination_run_expired" },
      );
      assert.deepEqual(await repository.events(0, 200), before);
      await assert.rejects(
        repository.transaction([], async () => assert.fail("Expired fence entered transaction"), fence),
        { code: "coordination_run_expired" },
      );
      t.mock.timers.reset();
      if (backend === "memory") {
        await assert.rejects(
          repository.transaction(
            [],
            async (tx) => {
              await tx.event("message", "retired", Date.now());
              await runtime.runs.releaseLease(run.id, claimed.leaseToken!);
            },
            fence,
          ),
          { code: "coordination_run_expired" },
        );
        assert.deepEqual(await repository.events(0, 200), before);
      } else {
        let retirement: Promise<boolean> | undefined;
        await repository.transaction(
          [],
          async (tx) => {
            await tx.event("message", "before-retirement", Date.now());
            retirement = runtime.runs.releaseLease(run.id, claimed.leaseToken!);
            assert.equal(await Promise.race([retirement.then(() => "retired"), setTimeout(100, "blocked")]), "blocked");
            assert.equal((await runtime.runs.get(run.id))?.status, "running");
          },
          fence,
        );
        assert.equal(await retirement, true);
        assert.equal((await repository.events(0, 200)).length, 2);
        assert.equal((await runtime.runs.get(run.id))?.status, "pending");
        await assert.rejects(
          repository.transaction([], async () => assert.fail("Retired run entered transaction"), fence),
          { code: "coordination_run_expired" },
        );
      }
      const retiring = await runtime.runs.enqueue({ sessionId: id, request: run.request });
      const retiringClaim = (await runtime.runs.claimById(retiring.run.id, "retiring", 60_000))!;
      assert.ok(retiringClaim);
      assert.equal(await runtime.runs.bindSession(retiringClaim.id, retiringClaim.leaseToken!, id), true);
      const retiringFence = {
        ...fence,
        runId: retiringClaim.id,
        attempt: retiringClaim.attempts,
        leaseToken: retiringClaim.leaseToken!,
      };
      const cleanupEntered = Promise.withResolvers<void>();
      const finishCleanup = Promise.withResolvers<void>();
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      t.mock.timers.tick(60_001);
      const reaping = runtime.runs.reapExpired(async (sessionIds) => {
        if (!sessionIds.includes(id)) return;
        assert.equal(await runtime.runs.heartbeat(retiringClaim.id, retiringFence.leaseToken, 60_000), false);
        cleanupEntered.resolve();
        await finishCleanup.promise;
      });
      try {
        await cleanupEntered.promise;
        const held = (await runtime.runs.get(retiringClaim.id))!;
        assert.equal(held.status, "running");
        assert.equal(held.attempts, retiringFence.attempt);
        assert.notEqual(held.leaseToken, retiringFence.leaseToken);
        assert.ok(held.leaseExpiresAt! > Date.now());
        const mutation = repository.transaction(
          [],
          async () => assert.fail("Retiring token entered transaction"),
          retiringFence,
        );
        await assert.rejects(mutation, { code: "coordination_run_expired" });
      } finally {
        finishCleanup.resolve();
        await reaping;
        t.mock.timers.reset();
      }
    },
  );
}
