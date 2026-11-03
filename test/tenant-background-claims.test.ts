import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { createWorker } from "../src/runs/worker.ts";
import { claimAcrossTenants, crossTenantLoop, inTenantOf, useOwnerDatabase, rowTenant } from "../src/tenants/claim.ts";
import { TENANCY_BASE } from "../src/tenants/migrations.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId, type Principal } from "../src/types.ts";
import { createSweeper } from "../src/util/sweeper.ts";
import { createAskExpirySweep } from "../src/triggers/keychain-ask.ts";
import type { KeychainAsk } from "../src/credentials/keychain.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenants } from "./support/test-tenants.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

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
  await assert.rejects(
    withTenant(A, () => claimAcrossTenants("SELECT 1")),
    /A cross-tenant claim cannot run while a tenant is bound/,
  );
});

test("startup fails without an owner database url", () => {
  assert.throws(() => useOwnerDatabase(undefined), /DATABASE_OWNER_URL/);
});

test("only startup hands the owner database url to the claim helper", async () => {
  const readers: string[] = [];
  for await (const file of glob("src/**/*.ts"))
    if (/DATABASE_OWNER_URL|databaseOwnerUrl/.test(await readFile(file, "utf8"))) readers.push(file);
  assert.deepEqual(readers.sort(), [
    "src/config.ts",
    "src/index.ts",
    "src/runs/worker-main.ts",
    "src/tenants/claim.ts",
  ]);
});

test(
  "under the restricted app login, one claim returns both tenants' due rows and each row's work runs bound",
  { skip },
  async () => {
    const url = testDatabaseUrl();
    const role = `qmt_app_${randomBytes(6).toString("hex")}`;
    const owner = new pg.Pool({ connectionString: url, max: 1 });
    for (const statement of TENANCY_BASE.statements) await owner.query(statement);
    await owner.query(`CREATE TABLE due_work(
    id TEXT PRIMARY KEY,
    tenant_id UUID NOT NULL DEFAULT qm_bound_tenant(),
    due BOOLEAN NOT NULL,
    done_by UUID
  )`);
    await owner.query("ALTER TABLE due_work ENABLE ROW LEVEL SECURITY");
    await owner.query(
      "CREATE POLICY due_work_tenant ON due_work USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())",
    );
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT, UPDATE ON due_work TO ${role}`);
    await owner.query(
      "INSERT INTO due_work(id, tenant_id, due) VALUES ('a1', $1, true), ('a2', $1, false), ('b1', $2, true)",
      [A, B],
    );
    const appUrl = new URL(url);
    appUrl.username = role;
    appUrl.password = role;
    const app = createPgPool(appUrl.toString());
    try {
      await assert.rejects(app.q("SELECT * FROM due_work"), /No tenant is bound/);
      const { rows } = await claimAcrossTenants("SELECT * FROM due_work WHERE due ORDER BY id");
      assert.deepEqual(
        rows.map((row) => [row.id, row.tenant_id]),
        [
          ["a1", A],
          ["b1", B],
        ],
      );
      for (const row of rows)
        await inTenantOf(rowTenant(row).tenantId, async () => {
          assert.deepEqual(
            (await app.q("SELECT id FROM due_work ORDER BY id")).map((visible) => visible.id),
            row.tenant_id === A ? ["a1", "a2"] : ["b1"],
          );
          const updated = await app.query("UPDATE due_work SET done_by = qm_bound_tenant() WHERE id = $1", [row.id]);
          assert.equal(updated.rowCount, 1);
        });
      assert.deepEqual((await owner.query("SELECT id, done_by FROM due_work ORDER BY id")).rows, [
        { id: "a1", done_by: A },
        { id: "a2", done_by: null },
        { id: "b1", done_by: B },
      ]);
    } finally {
      await app.close();
      await owner.query(`DROP OWNED BY ${role}`);
      await owner.query(`DROP ROLE ${role}`);
      await owner.end();
    }
  },
);

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

test(
  "a human turn under a bound tenant pokes the reaper unbound, and the poke reaps an expired run",
  { skip },
  async () => {
    const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "reaper-poke-")), workers: 0 }));
    try {
      const stale = (
        await withTenant(A, () => built.runs.enqueue({ sessionId: "s-stale", request: turn("stale"), maxAttempts: 3 }))
      ).run;
      assert.equal((await built.runs.claim("dead-worker", 10))?.id, stale.id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await withTenant(A, () =>
        built.app.turn({
          surface: "test",
          actor: { externalId: "U1" },
          conversation: { kind: "dm", threadRef: "poke" },
          origin: { kind: "human" },
          text: "hello",
          async: true,
        }),
      );
      let status = (await withTenant(A, () => built.runs.get(stale.id)))?.status;
      for (let i = 0; i < 200 && status !== "pending"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = (await withTenant(A, () => built.runs.get(stale.id)))?.status;
      }
      assert.equal(status, "pending");
    } finally {
      await built.runtime.stop();
    }
  },
);

test(
  "under the restricted app login, spend refresh claims dirty rows across tenants and rolls each day up under its row's tenant",
  { skip },
  async () => {
    const url = testDatabaseUrl();
    const base = Date.UTC(2024, 0, 1);
    const owner = createPostgresSessionStore(url, { now: () => base + 123 });
    await owner.refreshSpendRollup!();
    const role = `qmt_app_${randomBytes(6).toString("hex")}`;
    const raw = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await raw.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOBYPASSRLS`);
      await raw.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await raw.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await raw.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      const appUrl = new URL(url);
      appUrl.username = role;
      appUrl.password = role;
      const store = createPostgresSessionStore(appUrl.toString(), { now: () => base + 123 });
      const spent = [
        [A, 0.25],
        [B, 0.5],
      ] as const;
      for (const [tenant, costUsd] of spent)
        await withTenant(tenant, async () => {
          const scope = scopeId("personal", "spend");
          const session = await store.getOrCreateByThread(scope, "dm", scope);
          await store.recordLlmRequest(session.id, {
            turnSeq: null,
            step: 0,
            model: "saved",
            scopeLabel: scope,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd },
          });
        });
      await store.refreshSpendRollup!();
      assert.equal((await raw.query("SELECT 1 FROM session_spend_dirty")).rowCount, 0);
      assert.equal((await raw.query("SELECT 1 FROM session_spend_days")).rowCount, 2);
      for (const [tenant, costUsd] of spent) {
        const saved = await withTenant(tenant, () => store.spendReport!({ from: base, to: base + 86_400_000 }));
        assert.deepEqual(
          saved.rows.map((row) => [row.calls, row.costUsd]),
          [[1, costUsd]],
        );
      }
    } finally {
      await raw.query(`DROP OWNED BY ${role}`);
      await raw.query(`DROP ROLE ${role}`);
      await raw.end();
    }
  },
);

test("pruning ended cron fires keeps the newest per cron within each tenant", { skip }, async () => {
  const url = testDatabaseUrl();
  const fires = createPostgresCronFireStore(url);
  const raw = new pg.Pool({ connectionString: url, max: 1 });
  try {
    for (const tenant of [A, B])
      await withTenant(tenant, async () => {
        for (const [fireKey, endedAt] of [
          ["k1", 10],
          ["k2", 20],
          ["k3", 30],
        ] as const)
          await fires.record("c-shared", { fireKey, threadRef: fireKey, firedAt: endedAt, endedAt, status: "ok" });
      });
    assert.equal(await fires.pruneEnded({ endedBefore: 25, keepPerCron: 2 }), 2);
    const kept = await raw.query("SELECT tenant_id, fire_key FROM cron_fires");
    assert.deepEqual(
      kept.rows.map((row) => [row.tenant_id, row.fire_key]).sort(),
      [
        [A, "k2"],
        [A, "k3"],
        [B, "k2"],
        [B, "k3"],
      ].sort(),
    );
  } finally {
    await raw.end();
  }
});
