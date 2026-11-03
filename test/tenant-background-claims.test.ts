import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
import pg from "pg";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { createWorker } from "../src/runs/worker.ts";
import {
  claimAcrossTenants,
  crossTenantLoop,
  inTenantOf,
  requireOwnerDatabase,
  rowTenant,
} from "../src/tenants/claim.ts";
import { TENANCY_BASE } from "../src/tenants/migrations.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId, type Principal } from "../src/types.ts";
import { createSweeper } from "../src/util/sweeper.ts";
import { createAskExpirySweep } from "../src/triggers/keychain-ask.ts";
import type { KeychainAsk } from "../src/credentials/keychain.ts";
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
  await assert.rejects(
    withTenant(A, () => claimAcrossTenants("postgres://app@127.0.0.1/qm", "SELECT 1")),
    /A cross-tenant claim cannot run while a tenant is bound/,
  );
});

test("startup fails without an owner database url", () => {
  const saved = process.env.DATABASE_OWNER_URL;
  delete process.env.DATABASE_OWNER_URL;
  try {
    assert.throws(requireOwnerDatabase, /DATABASE_OWNER_URL/);
  } finally {
    if (saved !== undefined) process.env.DATABASE_OWNER_URL = saved;
  }
});

test("only the claim helper reads the owner database url", async () => {
  const readers: string[] = [];
  for await (const file of glob("src/**/*.ts"))
    if ((await readFile(file, "utf8")).includes("DATABASE_OWNER_URL")) readers.push(file);
  assert.deepEqual(readers, ["src/tenants/claim.ts"]);
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
    await owner.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT, UPDATE ON due_work TO ${role}`);
    await owner.query(
      "INSERT INTO due_work(id, tenant_id, due) VALUES ('a1', $1, true), ('a2', $1, false), ('b1', $2, true)",
      [A, B],
    );
    const appUrl = new URL(url);
    appUrl.searchParams.set("options", `-c role=${role}`);
    const app = createPgPool(appUrl.toString());
    try {
      await assert.rejects(app.q("SELECT * FROM due_work"), /No tenant is bound/);
      const { rows } = await claimAcrossTenants(appUrl.toString(), "SELECT * FROM due_work WHERE due ORDER BY id");
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
