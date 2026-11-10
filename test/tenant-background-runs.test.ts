import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresRunStore, type PostgresRuntime } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import type { RunSignalStore } from "../src/runs/run-signal-store.ts";
import type { Run } from "../src/runs/run-store.ts";
import { createReaper } from "../src/runs/reaper.ts";
import { createRunPreemption, createWorker } from "../src/runs/worker.ts";
import { boundTenant, currentTenant, withTenant } from "../src/tenants/context.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import type { Principal } from "../src/types.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: "shared-thread", audience: [actor] },
  origin: { kind: "direct" },
  text,
});
const leaderLease: LeaderLease = { hold: async (_key, fn) => fn(new Promise<never>(() => {})) };

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition never held");
}

describeTwoTenants("runs claim then bind, as the app login", (db) => {
  let store: PostgresRuntime;
  let signals: RunSignalStore;
  let A = "";
  let B = "";

  before(async () => {
    [A, B] = db.tenants;
    store = createPostgresRunStore(db.appDatabaseUrl);
    signals = createPostgresRunSignalStore(db.appDatabaseUrl);
  });

  after(async () => {
    await signals?.close?.();
    await store?.close();
  });

  const tenantRuns = async (sessionId: string) =>
    db.owner.q("SELECT tenant_id::text AS tenant, status FROM runs WHERE session_id = $1 ORDER BY tenant_id", [
      sessionId,
    ]);

  it("one worker claims both tenants' runs in the same session id and runs each under its own tenant", async () => {
    await withTenant(A, () => store.runs.enqueue({ sessionId: "w", request: turn(A), maxAttempts: 1 }));
    await withTenant(B, () => store.runs.enqueue({ sessionId: "w", request: turn(B), maxAttempts: 1 }));
    await assert.rejects(store.runs.list(), /No tenant is bound/);
    const ran: Array<[string, string | undefined, number]> = [];
    const orchestrator = {
      async handleTurn(input: OrchestratorInput) {
        const seen = await db.app.q("SELECT count(*)::int AS n FROM runs WHERE session_id = 'w'");
        ran.push([input.text, boundTenant(), Number(seen[0]!.n)]);
        return { status: "silent" };
      },
      screenSecuritySteer: async () => "allow",
      regenerateTitle: async () => null,
    } as unknown as Orchestrator;
    const worker = createWorker({ runs: store.runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5, slots: 2 });
    worker.start();
    await until(() => ran.length === 2);
    await worker.stop(5_000);
    assert.deepEqual(
      ran.sort(),
      [
        [A, A, 1],
        [B, B, 1],
      ].sort(),
    );
    assert.deepEqual(
      await tenantRuns("w"),
      [A, B].sort().map((tenant) => ({ tenant, status: "done" })),
    );
  });

  it("the reaper requeues one tenant's expired lease under that tenant and leaves the other's run alone", async () => {
    const a = await withTenant(A, async () => {
      const { run } = await store.runs.enqueue({ sessionId: "r", request: turn("a"), maxAttempts: 3 });
      return store.runs.claimById(run.id, "dead-worker", 1);
    });
    const b = await withTenant(B, async () => {
      const { run } = await store.runs.enqueue({ sessionId: "r", request: turn("b"), maxAttempts: 3 });
      return store.runs.claimById(run.id, "live-worker", 60_000);
    });
    assert.ok(a && b);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reaped: Array<[string, string | undefined]> = [];
    const reaper = createReaper(
      {
        ...store.runs,
        reapExpired: (opts) =>
          store.runs.reapExpired({
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
    assert.deepEqual(reaped, [[a.id, A]]);
    const statuses = Object.fromEntries((await tenantRuns("r")).map((row) => [row.tenant, row.status]));
    assert.deepEqual(statuses, { [A]: "pending", [B]: "running" });
  });

  it("preemption checks each held run for waiting people under that run's own tenant", async () => {
    const held: Array<{ run: Run; shutdown: AbortController; claimedAt: number; parkRequested: boolean }> = [];
    for (const tenant of [A, B])
      held.push(
        await withTenant(tenant, async () => {
          const { run } = await store.runs.enqueue({ sessionId: "p", request: turn(tenant), maxAttempts: 3 });
          await db.owner.q("UPDATE runs SET claim_priority = 2 WHERE id = $1", [run.id]);
          const claimed = await store.runs.claimById(run.id, "w", 60_000);
          assert.ok(claimed);
          return { run: claimed, shutdown: new AbortController(), claimedAt: Date.now(), parkRequested: false };
        }),
      );
    await withTenant(A, () => store.runs.enqueue({ sessionId: "p", request: turn("person"), maxAttempts: 1 }));
    await db.owner.q(
      "UPDATE runs SET created_at = created_at - 60000, claim_priority = 0 WHERE status = 'pending' AND session_id = 'p'",
    );
    const preemption = createRunPreemption({
      runs: store.runs,
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
        [A, true],
        [B, false],
      ],
    );
  });

  it("finished runs are claimed across tenants and each is loaded under its own tenant", async () => {
    const finished: string[] = [];
    for (const tenant of [A, B])
      await withTenant(tenant, async () => {
        const { run } = await store.runs.enqueue({ sessionId: "t", request: turn(tenant), maxAttempts: 1 });
        const claimed = await store.runs.claimById(run.id, "w", 60_000);
        await store.runs.complete(run.id, claimed!.leaseToken!, { status: "silent" } as never);
        finished.push(run.id);
      });
    const batch = await store.runs.terminalFinished({ finishedAt: 0, id: "" }, Date.now() + 1_000, 1_000);
    const mine = batch.filter((run) => finished.includes(run.id));
    assert.deepEqual(mine.map((run) => run.tenantId).sort(), [A, B].sort());
    assert.equal(boundTenant(), undefined);
  });

  it("orphaned run signals are listed with each run's tenant and handled under it", async () => {
    await withTenant(A, () => signals.send("orphan", { kind: "steer", text: "a" }));
    await withTenant(B, () => signals.send("orphan", { kind: "steer", text: "b" }));
    const pending = (await signals.pendingRuns()).filter((row) => row.id === "orphan");
    assert.deepEqual(pending.map((row) => row.tenantId).sort(), [A, B].sort());
    for (const { tenantId, id } of pending)
      await withTenant(tenantId, async () => {
        assert.equal(currentTenant(), tenantId);
        assert.deepEqual(
          (await signals.takePending(id)).map((signal) => (signal as { text?: string }).text),
          [tenantId === A ? "a" : "b"],
        );
      });
  });
});
