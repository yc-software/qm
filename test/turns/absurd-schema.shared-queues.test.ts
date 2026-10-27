import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyPgMigrations, pgMigrationFrom } from "../../src/persistence/pg-pool.ts";
import { applyTenancy } from "../../src/persistence/tenancy.ts";
import {
  ABSURD_JOBS_MIGRATION,
  ABSURD_MIGRATION,
  ABSURD_UNPARTITIONED_MIGRATION,
  MERGE_TENANT_QUEUES,
  mergeTenantQueues,
} from "../../src/turns/absurd-schema.ts";
import { claimTasks } from "../../src/turns/absurd.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Absurd queue migration test";

const ACME = "7d3f5e1a-0000-4000-8000-00000000a001";
const BETA = "9a1b2c3d-0000-4000-8000-00000000b002";
const GONE = "11112222-0000-4000-8000-00000000c003";
const suffix = (id: string) => `_t${id.replace(/-/g, "").slice(0, 12)}`;

let pool: pg.Pool;

before(async () => {
  if (!URL) return;
  pool = new pg.Pool({ connectionString: URL, max: 2 });
  await applyPgMigrations(
    pool,
    [ABSURD_MIGRATION, ABSURD_UNPARTITIONED_MIGRATION, ABSURD_JOBS_MIGRATION].map(pgMigrationFrom),
  );
  await applyTenancy(pool);
  await pool.query("INSERT INTO tenants(id, slug, org_id) VALUES ($1, 'acme', 'acme'), ($2, 'beta', 'beta')", [
    ACME,
    BETA,
  ]);
});

after(async () => {
  if (URL) await pool.end();
});

async function spawn(queue: string, name: string, params: unknown, key: string) {
  const { rows } = await pool.query(
    "SELECT task_id::text, run_id::text FROM absurd.spawn_task($1, $2, $3::jsonb, $4::jsonb)",
    [queue, name, JSON.stringify(params), JSON.stringify({ idempotency_key: key, max_attempts: 5 })],
  );
  return rows[0] as { task_id: string; run_id: string };
}

async function task(queue: string, taskId: string) {
  const { rows } = await pool.query(
    `SELECT t.state, t.attempts, t.params, t.headers, t.idempotency_key, r.state AS run_state, r.claimed_by
       FROM absurd.${pg.escapeIdentifier(`t_${queue}`)} t
       JOIN absurd.${pg.escapeIdentifier(`r_${queue}`)} r ON r.run_id = t.last_attempt_run WHERE t.task_id = $1`,
    [taskId],
  );
  return rows[0] as Record<string, unknown> | undefined;
}

test(
  "the boot sweep folds per-tenant queues into the shared ones with their tasks, runs, waits and events, and again after an older build recreates one",
  { skip },
  async () => {
    for (const id of [ACME, BETA, GONE])
      for (const queue of ["turns_people", "turns_background", "jobs"])
        await pool.query("SELECT absurd.create_queue($1, 'unpartitioned')", [queue + suffix(id)]);
    const home = await spawn("turns_people", "turn", { tenantId: "home-id", turnId: "home-1" }, "home-1");
    const homeJob = await spawn("jobs", "cron:fire", { cronId: "c0" }, "cron:c0:1");
    const pending = await spawn(`turns_people${suffix(ACME)}`, "turn", { tenantId: ACME, turnId: "acme-1" }, "acme-1");
    const running = await spawn(`turns_people${suffix(BETA)}`, "turn", { tenantId: BETA, turnId: "beta-1" }, "beta-1");
    await pool.query("SELECT * FROM absurd.claim_task($1, 'old-process', 60, 1)", [`turns_people${suffix(BETA)}`]);
    const parked = await spawn(
      `turns_background${suffix(ACME)}`,
      "turn",
      { tenantId: ACME, turnId: "acme-bg" },
      "acme-bg",
    );
    await pool.query("SELECT * FROM absurd.claim_task($1, 'old-process', 60, 1)", [`turns_background${suffix(ACME)}`]);
    await pool.query("SELECT * FROM absurd.await_event($1, $2, $3, 'park:1', 'resume:acme-bg:1', NULL)", [
      `turns_background${suffix(ACME)}`,
      parked.task_id,
      parked.run_id,
    ]);
    await pool.query("SELECT absurd.emit_event($1, 'resume:beta-x:1', '{}'::jsonb)", [`turns_people${suffix(BETA)}`]);
    const cron = await spawn(`jobs${suffix(BETA)}`, "cron:fire", { cronId: "c1" }, "cron:c1:2");
    await spawn(`jobs${suffix(BETA)}`, "every:cron:repair", null, "every:cron:repair");
    await spawn(`jobs${suffix(GONE)}`, "cron:fire", { cronId: "c9" }, "cron:c9:3");

    await Promise.all([pool.query(MERGE_TENANT_QUEUES), pool.query(MERGE_TENANT_QUEUES)]);

    const { rows: queues } = await pool.query("SELECT queue_name FROM absurd.queues ORDER BY queue_name");
    assert.deepEqual(
      queues.map((row) => row.queue_name),
      ["jobs", "turns_background", "turns_delegated", "turns_people"],
    );
    assert.deepEqual(await task("turns_people", home.task_id), {
      state: "pending",
      attempts: 1,
      params: { tenantId: "home-id", turnId: "home-1" },
      headers: null,
      idempotency_key: "home-1",
      run_state: "pending",
      claimed_by: null,
    });
    assert.deepEqual((await task("turns_people", pending.task_id))?.headers, { tenantId: ACME });
    assert.deepEqual(
      { ...(await task("turns_people", running.task_id)), params: undefined },
      {
        state: "running",
        attempts: 1,
        params: undefined,
        headers: { tenantId: BETA },
        idempotency_key: "beta-1",
        run_state: "running",
        claimed_by: "old-process",
      },
    );
    assert.equal((await task("turns_background", parked.task_id))?.state, "sleeping");
    const waits = await pool.query("SELECT event_name FROM absurd.w_turns_background WHERE task_id = $1", [
      parked.task_id,
    ]);
    assert.deepEqual(
      waits.rows.map((row) => row.event_name),
      ["resume:acme-bg:1"],
    );
    const events = await pool.query("SELECT event_name FROM absurd.e_turns_people");
    assert.deepEqual(
      events.rows.map((row) => row.event_name),
      ["resume:beta-x:1"],
    );
    assert.deepEqual(await task("jobs", cron.task_id), {
      state: "pending",
      attempts: 1,
      params: { cronId: "c1" },
      headers: { tenantId: BETA },
      idempotency_key: `tenant:${BETA}:cron:c1:2`,
      run_state: "pending",
      claimed_by: null,
    });
    const jobs = await pool.query("SELECT task_name, idempotency_key FROM absurd.t_jobs ORDER BY idempotency_key");
    assert.deepEqual(
      jobs.rows.map((row) => row.idempotency_key),
      ["cron:c0:1", `tenant:${BETA}:cron:c1:2`],
    );

    await mergeTenantQueues(URL!);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM absurd.t_turns_people")).rows[0]?.n, 3);

    await pool.query("SELECT absurd.create_queue($1, 'unpartitioned')", [`turns_people${suffix(ACME)}`]);
    const late = await spawn(
      `turns_people${suffix(ACME)}`,
      "turn",
      { tenantId: ACME, turnId: "acme-late" },
      "acme-late",
    );
    await mergeTenantQueues(URL!);
    assert.deepEqual((await task("turns_people", late.task_id))?.headers, { tenantId: ACME });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM absurd.queues")).rows[0]?.n, 4);

    const claimed = await claimTasks(pool, "jobs", "new-process", 60, 2);
    assert.deepEqual(
      claimed.map((each) => [each.taskId, each.tenantId]).sort(),
      [
        [homeJob.task_id, undefined],
        [cron.task_id, BETA],
      ].sort(),
    );
  },
);
