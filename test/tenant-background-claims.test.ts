import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { createWorker } from "../src/runs/worker.ts";
import { claimAcrossTenants, crossTenantLoop, inTenantOf, rowTenant } from "../src/tenants/claim.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import type { Principal } from "../src/types.ts";
import { createSweeper } from "../src/util/sweeper.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the claim tests";
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: `t-${text}`, audience: [actor] },
  origin: { kind: "direct" },
  text,
});

async function withTenantColumn(url: string, table: string, tenants: Record<string, string>): Promise<void> {
  const admin = new pg.Pool({ connectionString: url });
  try {
    await admin.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id uuid`);
    for (const [id, tenant] of Object.entries(tenants))
      await admin.query(`UPDATE ${table} SET tenant_id = $2 WHERE ${table === "runs" ? "id" : "run_id"} = $1`, [
        id,
        tenant,
      ]);
  } finally {
    await admin.end();
  }
}

test("a cross-tenant claim refuses to run under a bound tenant", async () => {
  let ran = 0;
  const pg = { query: async () => ({ rows: [{ ran: ++ran }], rowCount: 1 }) };
  await assert.rejects(
    withTenant(A, () => claimAcrossTenants(pg, "SELECT 1")),
    /A cross-tenant claim cannot run while a tenant is bound/,
  );
  assert.equal(ran, 0);
  assert.deepEqual((await claimAcrossTenants(pg, "SELECT 1")).rows, [{ ran: 1 }]);
});

test("loop bodies and sweeps run unbound even when started under a tenant", async () => {
  const seen: Array<string | undefined> = [];
  await withTenant(A, () => crossTenantLoop(async () => void seen.push(boundTenant()))());
  const sweeper = createSweeper(() => seen.push(boundTenant()), 60_000, { immediate: true });
  withTenant(A, () => sweeper.start());
  await sweeper.stop();
  assert.deepEqual(seen, [undefined, undefined]);
});

test("a claimed row binds its own tenant, and a row without one runs unbound", () => {
  assert.deepEqual(rowTenant({ tenant_id: A }), { tenantId: A });
  assert.deepEqual(rowTenant({ tenant_id: null }), {});
  assert.equal(
    withTenant(B, () => inTenantOf(A, boundTenant)),
    A,
  );
  assert.equal(
    withTenant(B, () => inTenantOf(undefined, boundTenant)),
    undefined,
  );
});

test(
  "once runs carry tenant_id, one worker claims across tenants and runs each turn under its run's tenant",
  { skip },
  async () => {
    const url = testDatabaseUrl();
    const { runs, close } = createPostgresRunStore(url);
    try {
      const first = (await runs.enqueue({ sessionId: "s-a", request: turn("a"), maxAttempts: 1 })).run;
      const second = (await runs.enqueue({ sessionId: "s-b", request: turn("b"), maxAttempts: 1 })).run;
      await withTenantColumn(url, "runs", { [first.id]: A, [second.id]: B });
      const ran: Array<[string, string | undefined]> = [];
      const orchestrator = {
        async handleTurn(input: OrchestratorInput) {
          ran.push([input.text, boundTenant()]);
          return { status: "silent" as const };
        },
      } as unknown as Orchestrator;
      const worker = withTenant(A, () => createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 }));
      withTenant(B, () => worker.start());
      for (let i = 0; i < 400 && ran.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      await worker.stop(1);
      assert.deepEqual(ran.sort(), [
        ["a", A],
        ["b", B],
      ]);
      assert.equal((await runs.get(first.id))?.tenantId, A);
    } finally {
      await close();
    }
  },
);

test("once run signals carry tenant_id, the orphan sweep reports each run with its tenant", { skip }, async () => {
  const url = testDatabaseUrl();
  const signals = createPostgresRunSignalStore(url);
  try {
    await signals.send("run-a", { kind: "steer", text: "hi" });
    await signals.send("run-b", { kind: "steer", text: "hi" });
    assert.deepEqual(await signals.pendingRuns(), [{ runId: "run-a" }, { runId: "run-b" }]);
    await withTenantColumn(url, "run_signals", { "run-a": A, "run-b": B });
    assert.deepEqual(await signals.pendingRuns(), [
      { runId: "run-a", tenantId: A },
      { runId: "run-b", tenantId: B },
    ]);
    await assert.rejects(
      withTenant(A, () => signals.pendingRuns()),
      /cannot run while a tenant is bound/,
    );
  } finally {
    await signals.close?.();
  }
});
