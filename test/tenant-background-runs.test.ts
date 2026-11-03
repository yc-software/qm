import { test } from "node:test";
import assert from "node:assert/strict";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { createReaper } from "../src/runs/reaper.ts";
import { createRunPreemption, createWorker } from "../src/runs/worker.ts";
import { claimAcrossTenants } from "../src/tenants/claim.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import type { Principal } from "../src/types.ts";
import { TENANT_A, TENANT_B, twoTenantDatabase, twoTenantTestSkip } from "./support/two-tenants.ts";

const skip = twoTenantTestSkip();
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: "shared-thread", audience: [actor] },
  origin: { kind: "direct" },
  text,
});
const leaderLease: LeaderLease = {
  hold: async (_key, fn) => fn(new Promise<never>(() => {})),
};

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition never held");
}

test("a cross-tenant claim refuses to run while a tenant is bound", async () => {
  const store = createPgPool("postgres://127.0.0.1:1/unused");
  await assert.rejects(
    withTenant(TENANT_A, () => claimAcrossTenants(store, "SELECT 1")),
    /A cross-tenant claim cannot run while a tenant is bound/,
  );
});

test(
  "as the restricted login, one worker claims both tenants' runs in the same session id and runs each under its own tenant",
  { skip },
  async () => {
    const db = await twoTenantDatabase((url) => createPostgresRunStore(url));
    const app = createPostgresRunStore(db.appUrl);
    try {
      await withTenant(TENANT_A, () => app.runs.enqueue({ sessionId: "s", request: turn("a"), maxAttempts: 1 }));
      await withTenant(TENANT_B, () => app.runs.enqueue({ sessionId: "s", request: turn("b"), maxAttempts: 1 }));
      await assert.rejects(app.runs.list(), /No tenant is bound/);
      const ran: Array<[string, string | undefined, string]> = [];
      const orchestrator: Orchestrator = {
        async handleTurn(input) {
          const seen = await createPgPool(db.appUrl).q("SELECT count(*)::int AS n FROM runs");
          ran.push([input.text, boundTenant(), String(seen[0]!.n)]);
          return { status: "silent" };
        },
        screenSecuritySteer: async () => "allow",
        regenerateTitle: async () => null,
      };
      const worker = createWorker({ runs: app.runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5, slots: 2 });
      withTenant(TENANT_B, () => worker.start());
      await until(() => ran.length === 2);
      await worker.stop(1);
      assert.deepEqual(ran.sort(), [
        ["a", TENANT_A, "1"],
        ["b", TENANT_B, "1"],
      ]);
      const { rows } = await db.owner.query("SELECT tenant_id::text, status FROM runs ORDER BY tenant_id");
      assert.deepEqual(rows, [
        { tenant_id: TENANT_A, status: "done" },
        { tenant_id: TENANT_B, status: "done" },
      ]);
    } finally {
      await app.close();
      await db.close();
    }
  },
);

test(
  "the reaper requeues tenant A's expired lease under A and leaves tenant B's run in the same session id untouched",
  { skip },
  async () => {
    const db = await twoTenantDatabase((url) => createPostgresRunStore(url));
    const app = createPostgresRunStore(db.appUrl);
    try {
      const a = await withTenant(TENANT_A, async () => {
        const { run } = await app.runs.enqueue({ sessionId: "same", request: turn("a"), maxAttempts: 3 });
        return app.runs.claimById(run.id, "dead-worker", 1);
      });
      const b = await withTenant(TENANT_B, async () => {
        const { run } = await app.runs.enqueue({ sessionId: "same", request: turn("b"), maxAttempts: 3 });
        return app.runs.claimById(run.id, "live-worker", 60_000);
      });
      assert.ok(a && b);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const reaped: Array<[string, string | undefined]> = [];
      const reaper = createReaper(
        {
          ...app.runs,
          reapExpired: (opts) =>
            app.runs.reapExpired({
              ...opts,
              onReap: (event) => {
                reaped.push([event.runId, boundTenant()]);
                opts?.onReap?.(event);
              },
            }),
        },
        { intervalMs: 60_000, leaderLease },
      );
      await reaper.sweep();
      assert.deepEqual(reaped, [[a.id, TENANT_A]]);
      const { rows } = await db.owner.query(
        "SELECT id, tenant_id::text, status, lease_token, worker_id FROM runs ORDER BY tenant_id",
      );
      assert.deepEqual(rows, [
        { id: a.id, tenant_id: TENANT_A, status: "pending", lease_token: null, worker_id: null },
        { id: b.id, tenant_id: TENANT_B, status: "running", lease_token: b.leaseToken, worker_id: "live-worker" },
      ]);
    } finally {
      await app.close();
      await db.close();
    }
  },
);

test("preemption checks each held run for waiting people under that run's own tenant", { skip }, async () => {
  const db = await twoTenantDatabase((url) => createPostgresRunStore(url));
  const app = createPostgresRunStore(db.appUrl);
  try {
    const held = await Promise.all(
      [TENANT_A, TENANT_B].map((tenant) =>
        withTenant(tenant, async () => {
          const { run } = await app.runs.enqueue({ sessionId: "same", request: turn(tenant), maxAttempts: 3 });
          await db.owner.query("UPDATE runs SET claim_priority = 2 WHERE id = $1", [run.id]);
          const claimed = await app.runs.claimById(run.id, "w", 60_000);
          assert.ok(claimed);
          return { run: claimed, shutdown: new AbortController(), claimedAt: Date.now(), parkRequested: false };
        }),
      ),
    );
    await withTenant(TENANT_A, () => app.runs.enqueue({ sessionId: "same", request: turn("person"), maxAttempts: 1 }));
    await db.owner.query(
      "UPDATE runs SET created_at = created_at - 60000, claim_priority = 0 WHERE status = 'pending'",
    );
    const preemption = createRunPreemption({
      runs: app.runs,
      worker: {
        slots: 4,
        held: () => held,
        start() {},
        stopClaims: async () => {},
        drained: async () => {},
        stop: async () => {},
        releaseInFlight: async () => {},
      },
      graceMs: 0,
    });
    assert.equal(await preemption.sweep(), true);
    assert.deepEqual(
      held.map((h) => [h.run.tenantId, h.parkRequested]),
      [
        [TENANT_A, true],
        [TENANT_B, false],
      ],
    );
  } finally {
    await app.close();
    await db.close();
  }
});

test("orphaned run signals are reported with each run's tenant", { skip }, async () => {
  const db = await twoTenantDatabase((url) => createPostgresRunSignalStore(url));
  const signals = createPostgresRunSignalStore(db.appUrl);
  try {
    await withTenant(TENANT_A, () => signals.send("run-1", { kind: "steer", text: "a" }));
    await withTenant(TENANT_B, () => signals.send("run-1", { kind: "steer", text: "b" }));
    assert.deepEqual(await signals.pendingRuns(), [
      { runId: "run-1", tenantId: TENANT_A },
      { runId: "run-1", tenantId: TENANT_B },
    ]);
    await assert.rejects(
      withTenant(TENANT_A, () => signals.pendingRuns()),
      /cannot run while a tenant is bound/,
    );
  } finally {
    await signals.close?.();
    await db.close();
  }
});
