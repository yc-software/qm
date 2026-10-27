import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createJobWorker } from "../../src/jobs/job-worker.ts";
import { createPostgresNotifyBus } from "../../src/persistence/postgres-notify-bus.ts";
import { registerTenantSettings, tenant, tenantFor, withTenant, type Tenant } from "../../src/tenant.ts";
import { useTenantDirectory, type TenantDirectory } from "../../src/tenants/directory.ts";
import { tenantJobWorkers, tenantTurnRunners } from "../../src/tenants/fan-out.ts";
import { ABSURD_QUEUES, ensureTenantQueues, tenantQueue } from "../../src/turns/absurd-schema.ts";
import { createTurnRunner } from "../../src/turns/turn-runner.ts";
import type { Orchestrator } from "../../src/core/orchestrator.ts";
import type { Run } from "../../src/runs/run-store.ts";
import type { TurnLedger } from "../../src/turns/turn-ledger.ts";
import { settle } from "../support/settle.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the tenant background tests";

const home = tenant();
const acme = tenantFor("acme", randomUUID(), "acme");
const beta = tenantFor("beta", randomUUID(), "beta");

function directoryOf(tenants: Tenant[]): TenantDirectory {
  registerTenantSettings(
    tenants.flatMap((t) =>
      t.id
        ? [
            {
              id: t.id,
              slug: t.slug!,
              orgId: t.orgId,
              hosts: [],
              status: "active" as const,
              oidcAdmin: false,
              secrets: {},
            },
          ]
        : [],
    ),
  );
  return {
    byHost: async () => undefined,
    active: async () => tenants,
    watch: () => {},
    close: async () => {},
  };
}

before(async () => {
  if (!URL) return;
  for (const t of [acme, beta]) await withTenant(t, () => ensureTenantQueues(URL));
  useTenantDirectory(directoryOf([home, acme, beta]));
});

after(async () => {
  useTenantDirectory(undefined);
  registerTenantSettings([]);
  if (!URL) return;
  const admin = new pg.Client({ connectionString: URL });
  await admin.connect();
  for (const t of [acme, beta])
    for (const queue of ABSURD_QUEUES) await admin.query("SELECT absurd.drop_queue($1)", [tenantQueue(queue, t.id)]);
  await admin.end();
});

test("a recurring job runs once for every active tenant, inside that tenant", { skip, timeout: 30_000 }, async () => {
  const jobs = tenantJobWorkers(() => createJobWorker(URL!));
  const ran: (string | null)[] = [];
  jobs.every(`probe-${randomUUID()}`, 60 * 60_000, () => void ran.push(tenant().id ?? null));
  await jobs.start();
  try {
    await settle(() => ran.length === 3);
    assert.deepEqual(new Set(ran), new Set([null, acme.id, beta.id]));
  } finally {
    await jobs.stop();
  }
});

test("the turn runner claims each tenant's queues and runs every turn inside its tenant", async () => {
  const claimedIn: (string | null)[] = [];
  const ranIn: Record<string, string | null> = {};
  const finishedIn: Record<string, string | null> = {};
  const pending = new Map<string | null, Run>([
    [acme.id!, { id: "turn-acme", sessionId: "s-acme", priority: 0, request: {} } as unknown as Run],
    [beta.id!, { id: "turn-beta", sessionId: "s-beta", priority: 0, request: {} } as unknown as Run],
  ]);
  const ledger = {
    async claim() {
      const id = tenant().id ?? null;
      claimedIn.push(id);
      const run = pending.get(id);
      pending.delete(id);
      return run ? { claimed: true, run } : { claimed: false };
    },
    async extend() {
      return "held";
    },
    async finish(run: Run) {
      finishedIn[run.id] = tenant().id ?? null;
      return true;
    },
  } as unknown as TurnLedger;
  const orchestrator = {
    async handleTurn(input: { runId: string }) {
      ranIn[input.runId] = tenant().id ?? null;
      return { status: "ok", sessionId: "s" };
    },
  } as unknown as Orchestrator;
  const runner = tenantTurnRunners(() =>
    createTurnRunner({ ledger, orchestrator, queues: ["turns_people"], slots: 4, pollMs: 20 }),
  );
  runner.start();
  try {
    await settle(() => Object.keys(finishedIn).length === 2);
  } finally {
    await runner.stopClaims();
  }
  assert.ok(claimedIn.includes(null) && claimedIn.includes(acme.id!) && claimedIn.includes(beta.id!));
  assert.deepEqual(ranIn, { "turn-acme": acme.id, "turn-beta": beta.id });
  assert.deepEqual(finishedIn, { "turn-acme": acme.id, "turn-beta": beta.id });
});

test(
  "a tenant's subscribers see only its own events; startup subscribers get each event in its tenant",
  { skip, timeout: 20_000 },
  async () => {
    const bus = createPostgresNotifyBus<string>(URL!, `tenant_probe_${randomUUID().replaceAll("-", "")}`, "probe");
    const acmeSaw: string[] = [];
    const startupSaw: Array<[string, string | null]> = [];
    const offAcme = withTenant(acme, () => bus.subscribe((event) => acmeSaw.push(event)));
    const offStartup = bus.subscribe((event) => startupSaw.push([event, tenant().id ?? null]));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      withTenant(beta, () => bus.emit("from-beta"));
      withTenant(acme, () => bus.emit("from-acme"));
      bus.emit("from-home");
      await settle(() => startupSaw.length === 3);
      assert.deepEqual(acmeSaw, ["from-acme"]);
      assert.deepEqual(
        new Map(startupSaw),
        new Map([
          ["from-beta", beta.id!],
          ["from-acme", acme.id!],
          ["from-home", null],
        ]),
      );
    } finally {
      offAcme();
      offStartup();
      await bus.close?.();
    }
  },
);
