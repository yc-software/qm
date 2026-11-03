import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { createWorker } from "../src/runs/worker.ts";
import { claimAcrossTenants, inTenantOf, rowTenant } from "../src/tenants/claim.ts";
import { TENANCY_BASE } from "../src/tenants/migrations.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId, type Principal } from "../src/types.ts";
import { createSweeper } from "../src/util/sweeper.ts";
import { createAskExpirySweep } from "../src/triggers/keychain-ask.ts";
import type { KeychainAsk } from "../src/credentials/keychain.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

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
  let opened = 0;
  const store = createPgPool("postgres://127.0.0.1:1/none");
  store.query = async () => assert.fail(`opened ${++opened}`);
  await assert.rejects(
    withTenant(A, () => claimAcrossTenants(store, "SELECT 1")),
    /A cross-tenant claim cannot run while a tenant is bound/,
  );
  assert.equal(opened, 0);
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
      const { rows } = await claimAcrossTenants(app, "SELECT * FROM due_work WHERE due ORDER BY id");
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
  const sweeper = createSweeper(() => seen.push(boundTenant()), 60_000, { immediate: true });
  withTenant(A, () => sweeper.start());
  await sweeper.stop();
  assert.deepEqual(seen, [undefined]);
});

test(
  "under the restricted app login, one worker claims runs across tenants and runs each turn under its run's tenant",
  { skip },
  async () => {
    const url = testDatabaseUrl();
    const owner = createPostgresRunStore(url);
    const role = `qmt_app_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    let app: ReturnType<typeof createPostgresRunStore> | undefined;
    try {
      const first = (await owner.runs.enqueue({ sessionId: "s-a", request: turn("a"), maxAttempts: 1 })).run;
      const second = (await owner.runs.enqueue({ sessionId: "s-b", request: turn("b"), maxAttempts: 1 })).run;
      await withTenantColumn(url, "runs", { [first.id]: A, [second.id]: B });
      for (const statement of TENANCY_BASE.statements) await admin.query(statement);
      await admin.query("ALTER TABLE runs ENABLE ROW LEVEL SECURITY");
      await admin.query(
        "CREATE POLICY runs_tenant ON runs USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())",
      );
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOBYPASSRLS`);
      await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      const appUrl = new URL(url);
      appUrl.username = role;
      appUrl.password = role;
      app = createPostgresRunStore(appUrl.toString());
      await assert.rejects(app.runs.get(first.id), /No tenant is bound/);
      const ran: Array<[string, string | undefined]> = [];
      const orchestrator = {
        async handleTurn(input: OrchestratorInput) {
          ran.push([input.text, boundTenant()]);
          return { status: "silent" as const };
        },
      } as unknown as Orchestrator;
      const worker = createWorker({ runs: app.runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
      withTenant(B, () => worker.start());
      for (let i = 0; i < 400 && ran.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      await worker.stop(1);
      assert.deepEqual(ran.sort(), [
        ["a", A],
        ["b", B],
      ]);
      assert.deepEqual(
        (await admin.query("SELECT id, status FROM runs ORDER BY id")).rows.map((row) => row.status),
        ["done", "done"],
      );
    } finally {
      await app?.close();
      await owner.close();
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
      await admin.end();
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
      const stale = (await built.runs.enqueue({ sessionId: "s-stale", request: turn("stale"), maxAttempts: 3 })).run;
      assert.equal((await built.runs.claim("dead-worker", 10))[0]?.id, stale.id);
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
      let status = (await built.runs.get(stale.id))?.status;
      for (let i = 0; i < 200 && status !== "pending"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = (await built.runs.get(stale.id))?.status;
      }
      assert.equal(status, "pending");
    } finally {
      await built.runtime.stop();
    }
  },
);
