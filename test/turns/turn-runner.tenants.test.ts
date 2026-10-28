import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Orchestrator, OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createJobWorker } from "../../src/jobs/job-worker.ts";
import { configurePgTenancy, createPgPool, migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import type { RunPriority } from "../../src/runs/run-store.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { registerTenantSettings, scopedTenant, tenant, tenantFor, withTenant, type Tenant } from "../../src/tenant.ts";
import { upsertTenant, type TenantRecord, type TenantSettings } from "../../src/tenants/registry.ts";
import { createTenantDirectory, useTenantDirectory, type TenantDirectory } from "../../src/tenants/directory.ts";
import { registerAbsurdSchema, TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import { createTurnLedger, TURN_READY_CHANNEL, type TurnLedger } from "../../src/turns/turn-ledger.ts";
import { createPostgresNotifyBus } from "../../src/persistence/postgres-notify-bus.ts";
import { createTurnRunner } from "../../src/turns/turn-runner.ts";
import type { TurnResult } from "../../src/types.ts";
import { eventually } from "../support/settle.ts";

const URL_ADMIN = process.env.DATABASE_URL;
const skip = URL_ADMIN ? false : "set DATABASE_URL (a Postgres) to run the multitenant runner test";
const DB = `qm_mt_runner_${process.pid}`;
const ROLE = "qm_mt_runner_app";

const acme = tenantFor("acme", "7d3f5e1a-0000-4000-8000-00000000a001", "acme");
const beta = tenantFor("beta", "9a1b2c3d-0000-4000-8000-00000000b002", "beta");
const GAMMA = "c4d5e6f7-0000-4000-8000-00000000c003";
const RETIRED = "e8f9a0b1-0000-4000-8000-00000000d004";
const retired = tenantFor("retired", RETIRED, "retired");
const WAITING = "f0a1b2c3-0000-4000-8000-00000000e005";
const waiting = tenantFor("waiting", WAITING, "waiting");
const withRetired = directoryOf(
  () => Promise.resolve([acme, beta]),
  (id) => Promise.resolve(id !== RETIRED),
);

async function absurdTask(queue: string, taskId: string) {
  const rows = await rls.q(
    `SELECT t.state, (SELECT r.failure_reason->>'message' FROM absurd.${pg.escapeIdentifier(`r_${queue}`)} r
        WHERE r.task_id = t.task_id AND r.failure_reason IS NOT NULL LIMIT 1) AS reason
       FROM absurd.${pg.escapeIdentifier(`t_${queue}`)} t WHERE t.task_id = $1`,
    [taskId],
  );
  return rows[0] as { state: string; reason: string | null } | undefined;
}

function directoryOf(
  active: () => Promise<Tenant[]>,
  exists: (id: string) => Promise<boolean> = () => Promise.resolve(true),
): TenantDirectory {
  return {
    active,
    async owner(id) {
      const found = (await active()).find((t) => t.id === id);
      if (found || id === undefined) return found;
      return (await exists(id)) ? undefined : "retired";
    },
    byHost: () => Promise.resolve(undefined),
    homeHosts: () => ({ hosts: [] }),
    watch: () => {},
    close: () => Promise.resolve(),
  };
}

const directory = directoryOf(() => Promise.resolve([acme, beta]));

let admin: pg.Client;
let appUrl = "";
let ledger: TurnLedger;
let rls: ReturnType<typeof createPgPool>;
let closers: Array<() => Promise<unknown>> = [];

before(async () => {
  if (!URL_ADMIN) return;
  admin = new pg.Client({ connectionString: URL_ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
  );
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  const url = new URL(URL_ADMIN);
  url.username = ROLE;
  url.password = ROLE;
  url.pathname = `/${DB}`;
  appUrl = url.toString();
  configurePgTenancy(true);
  useTenantDirectory(directory);
  registerTenantSettings(
    [acme, beta].map((t): TenantSettings => ({
      id: t.id,
      slug: t.slug!,
      orgId: t.orgId,
      hosts: [],
      status: "active",
      oidcAdmin: false,
      secrets: {},
    })),
  );
  registerAbsurdSchema(appUrl);
  const runStore = createPostgresRunStore(appUrl);
  createPostgresSessionStore(appUrl);
  ledger = createTurnLedger(appUrl);
  rls = createPgPool(appUrl);
  closers = [() => ledger.close(), () => runStore.close(), () => rls.close()];
  await migrateRegisteredPgSchemas(appUrl);
  await rls.query("INSERT INTO tenants(id, slug, org_id) VALUES ($1, 'acme', 'acme'), ($2, 'beta', 'beta')", [
    acme.id,
    beta.id,
  ]);
});

after(async () => {
  if (!URL_ADMIN) return;
  for (const close of closers) await close();
  configurePgTenancy(false);
  useTenantDirectory(undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

function admit(t: typeof acme, priority: RunPriority) {
  const thread = `web:${t.slug}:${randomUUID()}`;
  const request = {
    surface: "web",
    text: "hello",
    actor: { id: "alice@example.com", externalId: "alice@example.com", displayName: "Alice" },
    conversation: { kind: "dm", threadRef: thread },
    origin: { kind: "human" },
  } as unknown as OrchestratorInput;
  return withTenant(t, async () => (await ledger.admit({ sessionId: thread, request, priority })).run);
}

interface Seen {
  runId: string;
  tenantId: string | undefined;
  visible: string[];
}

function recordingOrchestrator(seen: Seen[]): Orchestrator {
  return {
    async handleTurn(input: OrchestratorInput): Promise<TurnResult> {
      const rows = await rls.q("SELECT id FROM runs");
      seen.push({ runId: input.runId!, tenantId: tenant().id, visible: rows.map((row) => String(row.id)) });
      return { status: "ok", sessionId: input.conversation.threadRef, reply: "done" };
    },
  } as unknown as Orchestrator;
}

test(
  "one runner wakes for every tenant's turn and runs each inside its tenant, seeing only its rows",
  { skip },
  async () => {
    const seen: Seen[] = [];
    const ready = createPostgresNotifyBus<string>(appUrl, TURN_READY_CHANNEL, "test turn readiness");
    const runner = createTurnRunner({
      ledger,
      orchestrator: recordingOrchestrator(seen),
      queues: TURN_QUEUES,
      slots: 2,
      pollMs: 60_000,
      ready,
    });
    withTenant(acme, () => runner.start());
    await new Promise((resolve) => setTimeout(resolve, 500));
    const runBoth = async () => {
      const b = await admit(beta, 0);
      await eventually(() => seen.length === 1, { label: "the other tenant's turn ran" });
      const a = await admit(acme, 0);
      await eventually(() => seen.length === 2, { label: "both turns ran" });
      return { a, b };
    };
    const { a, b } = await runBoth().finally(async () => {
      await runner.stopClaims();
      await ready.close?.();
    });
    const ranA = seen.find((each) => each.runId === a.id);
    const ranB = seen.find((each) => each.runId === b.id);
    assert.equal(ranA?.tenantId, acme.id);
    assert.equal(ranB?.tenantId, beta.id);
    assert.ok(ranA?.visible.includes(a.id) && !ranA.visible.includes(b.id));
    assert.ok(ranB?.visible.includes(b.id) && !ranB.visible.includes(a.id));
    await eventually(
      async () => (await withTenant(acme, () => rls.q("SELECT status FROM runs WHERE id = $1", [a.id])))[0]?.status,
      { until: (status) => status === "done", label: "acme's turn finished" },
    );
  },
);

test("a person's turn in one tenant is claimed before background work in another", { skip }, async () => {
  const seen: Seen[] = [];
  const background = await admit(acme, 2);
  const person = await admit(beta, 0);
  const runner = createTurnRunner({
    ledger,
    orchestrator: recordingOrchestrator(seen),
    queues: TURN_QUEUES,
    slots: 1,
    pollMs: 50,
  });
  runner.start();
  try {
    await eventually(() => seen.length === 2, { label: "both turns ran" });
  } finally {
    await runner.stopClaims();
  }
  assert.deepEqual(
    seen.map((each) => each.runId),
    [person.id, background.id],
  );
});

test(
  "one job worker runs keyed jobs in their tenant, periodic work once per tenant, and shared periodic work once",
  { skip },
  async () => {
    const jobs = createJobWorker(appUrl);
    const fired: Array<{ job: string; tenant: string | undefined }> = [];
    jobs.handle("probe", async (params) => {
      fired.push({ job: String((params as { name: string }).name), tenant: tenant().id });
      return "done";
    });
    const visits: Array<string | undefined> = [];
    jobs.every("tenant-visits", 60_000, () => visits.push(tenant().id), { due: "true" });
    const sharedVisits: Array<string | undefined> = [];
    jobs.every("shared-visits", 60_000, () => sharedVisits.push(scopedTenant()?.id), { shared: true });
    await withTenant(acme, () => jobs.spawn("probe", { name: "acme" }, "probe:1"));
    await withTenant(beta, () => jobs.spawn("probe", { name: "beta" }, "probe:1"));
    await jobs.start();
    try {
      await eventually(() => fired.length === 2 && visits.length === 2 && sharedVisits.length === 1, {
        label: "jobs ran",
      });
    } finally {
      await jobs.stop();
    }
    assert.deepEqual(
      fired.toSorted((x, y) => x.job.localeCompare(y.job)),
      [
        { job: "acme", tenant: acme.id },
        { job: "beta", tenant: beta.id },
      ],
    );
    assert.deepEqual(visits.toSorted(), [acme.id, beta.id].toSorted());
    assert.deepEqual(sharedVisits, [undefined]);
    const keys = await rls.q("SELECT idempotency_key FROM absurd.t_jobs WHERE task_name = 'probe' ORDER BY 1");
    assert.deepEqual(
      keys.map((row) => row.idempotency_key),
      [`tenant:${acme.id}:probe:1`, `tenant:${beta.id}:probe:1`].sort(),
    );
  },
);

test(
  "a job for a tenant the directory does not know waits, and a failing tenant list does not spin",
  { skip },
  async () => {
    useTenantDirectory(directoryOf(() => Promise.reject(new Error("registry down"))));
    const jobs = createJobWorker(appUrl);
    const ran: string[] = [];
    jobs.handle("orphan", () => {
      ran.push("orphan");
      return Promise.resolve("done");
    });
    jobs.every("spin-probe", 60_000, () => ran.push("every"), { due: "true" });
    await withTenant(acme, () => jobs.spawn("orphan", {}, "orphan:1"));
    await jobs.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await jobs.stop();
      useTenantDirectory(directory);
    }
    assert.deepEqual(ran, []);
    const rows = await rls.q(
      `SELECT t.task_name, t.state, t.attempts FROM absurd.t_jobs t
      WHERE t.task_name IN ('orphan', 'every:spin-probe') ORDER BY 1`,
    );
    assert.deepEqual(
      rows.map((row) => [row.task_name, row.state, Number(row.attempts) <= 2]),
      [
        ["every:spin-probe", "sleeping", true],
        ["orphan", "sleeping", true],
      ],
    );
  },
);

test(
  "with the real directory, a tenant added at runtime is served, a suspended one waits, and a reactivated one resumes",
  { skip, timeout: 60_000 },
  async () => {
    const gammaRecord: TenantRecord = {
      id: GAMMA,
      slug: "gamma",
      orgId: "gamma",
      hosts: [],
      status: "active",
      oidcAdmin: false,
      secrets: {},
    };
    const gamma = tenantFor("gamma", GAMMA, "gamma");
    const real = createTenantDirectory({
      databaseUrl: appUrl,
      pool: rls,
      secretsKey: undefined,
      home: tenant(),
      homeHosts: [],
      homeSandboxPrefix: "qm",
    });
    useTenantDirectory(real);
    const seen: Seen[] = [];
    const runner = createTurnRunner({
      ledger,
      orchestrator: recordingOrchestrator(seen),
      queues: TURN_QUEUES,
      slots: 2,
      pollMs: 50,
    });
    const status = async (runId: string) =>
      (await withTenant(gamma, () => rls.q("SELECT status FROM runs WHERE id = $1", [runId])))[0]?.status;
    try {
      await real.active();
      await upsertTenant(rls, gammaRecord, undefined);
      runner.start();
      const first = await admit(gamma, 0);
      await eventually(() => seen.some((each) => each.runId === first.id && each.tenantId === GAMMA), {
        label: "the new tenant's turn ran in it",
      });

      await upsertTenant(rls, { ...gammaRecord, status: "suspended" }, undefined);
      await eventually(async () => !(await real.active()).some((t) => t.id === GAMMA), {
        label: "the directory dropped the suspended tenant",
      });
      const second = await admit(gamma, 0);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.ok(!seen.some((each) => each.runId === second.id));
      assert.ok(["queued", "pending"].includes(String(await status(second.id))));

      await upsertTenant(rls, gammaRecord, undefined);
      await eventually(() => seen.some((each) => each.runId === second.id && each.tenantId === GAMMA), {
        label: "the reactivated tenant's turn ran",
        timeoutMs: 20_000,
      });
    } finally {
      await runner.stopClaims();
      await real.close();
      useTenantDirectory(directory);
    }
  },
);

test(
  "a job whose tenant no longer exists is failed with a reason, and one whose tenant is not ready waits",
  { skip },
  async () => {
    useTenantDirectory(withRetired);
    const jobs = createJobWorker(appUrl);
    const ran: string[] = [];
    jobs.handle("tenant-gone-probe", (params) => {
      ran.push(String((params as { name: string }).name));
      return Promise.resolve("done");
    });
    await withTenant(retired, () => jobs.spawn("tenant-gone-probe", { name: "retired" }, "gone:1"));
    await withTenant(waiting, () => jobs.spawn("tenant-gone-probe", { name: "waiting" }, "gone:1"));
    const ids = async (key: string) =>
      String((await rls.q("SELECT task_id::text AS id FROM absurd.t_jobs WHERE idempotency_key = $1", [key]))[0]?.id);
    const gone = await ids(`tenant:${RETIRED}:gone:1`);
    const later = await ids(`tenant:${WAITING}:gone:1`);
    await jobs.start();
    try {
      await eventually(async () => (await absurdTask("jobs", gone))?.state === "failed", {
        label: "the retired tenant's job was settled",
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await jobs.stop();
      useTenantDirectory(directory);
    }
    assert.deepEqual(ran, []);
    assert.deepEqual(await absurdTask("jobs", gone), {
      state: "failed",
      reason: `tenant ${RETIRED} no longer exists`,
    });
    assert.ok(["pending", "sleeping"].includes(String((await absurdTask("jobs", later))?.state)));
  },
);

test(
  "a turn whose tenant no longer exists is failed and cancelled, and one whose tenant is not ready waits",
  { skip },
  async () => {
    useTenantDirectory(withRetired);
    const seen: Seen[] = [];
    const runner = createTurnRunner({
      ledger,
      orchestrator: recordingOrchestrator(seen),
      queues: TURN_QUEUES,
      slots: 2,
      pollMs: 50,
    });
    const gone = await admit(retired, 0);
    const later = await admit(waiting, 0);
    const taskOf = async (t: Tenant, runId: string) =>
      String(
        (await withTenant(t, () => rls.q("SELECT absurd_task_id::text AS id FROM runs WHERE id = $1", [runId])))[0]?.id,
      );
    const goneTask = await taskOf(retired, gone.id);
    const laterTask = await taskOf(waiting, later.id);
    runner.start();
    try {
      await eventually(async () => (await absurdTask("turns_people", goneTask))?.state === "cancelled", {
        label: "the retired tenant's turn task was settled",
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await runner.stopClaims();
      useTenantDirectory(directory);
    }
    assert.ok(!seen.some((each) => each.runId === gone.id || each.runId === later.id));
    assert.deepEqual(await absurdTask("turns_people", goneTask), {
      state: "cancelled",
      reason: `tenant ${RETIRED} no longer exists`,
    });
    assert.notEqual((await absurdTask("turns_people", laterTask))?.state, "cancelled");
  },
);
