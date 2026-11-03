import { test } from "node:test";
import assert from "node:assert/strict";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { createWorker } from "../src/runs/worker.ts";
import { claimAcrossTenants, crossTenantLoop, inTenantOf, rowTenant } from "../src/tenants/claim.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId, type Principal } from "../src/types.ts";
import { createSweeper } from "../src/util/sweeper.ts";
import { createAskExpirySweep } from "../src/triggers/keychain-ask.ts";
import type { KeychainAsk } from "../src/credentials/keychain.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenants } from "./support/test-tenants.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the claim tests";
const [A, B] = skip ? ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b2"] : testTenants();
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: `t-${text}`, audience: [actor] },
  origin: { kind: "direct" },
  text,
});

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

test("one worker claims across tenants and runs each turn under its run's tenant", { skip }, async () => {
  const url = testDatabaseUrl();
  const { runs, close } = createPostgresRunStore(url);
  try {
    const first = (await withTenant(A, () => runs.enqueue({ sessionId: "s-a", request: turn("a"), maxAttempts: 1 })))
      .run;
    await withTenant(B, () => runs.enqueue({ sessionId: "s-b", request: turn("b"), maxAttempts: 1 }));
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
    assert.equal((await withTenant(A, () => runs.get(first.id)))?.tenantId, A);
  } finally {
    await close();
  }
});

test("the orphan sweep reports each run with its tenant", { skip }, async () => {
  const url = testDatabaseUrl();
  const signals = createPostgresRunSignalStore(url);
  try {
    await withTenant(A, () => signals.send("run-a", { kind: "steer", text: "hi" }));
    await withTenant(B, () => signals.send("run-b", { kind: "steer", text: "hi" }));
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

test("the ask sweep settles each resolved ask under its own tenant", async () => {
  const ask = (id: string, tenantId?: string): KeychainAsk & { tenantId?: string } => ({
    id,
    credentialId: "cred",
    ownerId: "U1",
    requesterId: "U2",
    requesterScopeId: scopeId("personal", "U1"),
    purpose: "test",
    status: "expired",
    createdAt: 0,
    expiresAt: 0,
    ...(tenantId === undefined ? {} : { tenantId }),
  });
  const fired: Array<[string, string | undefined]> = [];
  const notified: Array<[string, string | undefined]> = [];
  const sweep = createAskExpirySweep({
    keychain: {
      unnotifiedResolvedAsks: async () => [ask("a", A), ask("b", B), ask("c")],
      markAskNotified: async (id) => {
        notified.push([id, boundTenant()]);
      },
    },
    fire: async (settled) => fired.push([settled.id, boundTenant()]),
  });
  await sweep(1);
  const expected: Array<[string, string | undefined]> = [
    ["a", A],
    ["b", B],
    ["c", undefined],
  ];
  assert.deepEqual(fired, expected);
  assert.deepEqual(notified, expected);
});
