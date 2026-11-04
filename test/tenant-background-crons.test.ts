import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";
import type { CronFireJob, CronJobQueue } from "../src/cron/job-queue.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createKeychain, type KeychainAsk } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createAskExpirySweep } from "../src/triggers/keychain-ask.ts";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { createLoopIngress, type IngressDelivery, type LoopIngress } from "../src/loops/ingress.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createApprovalStore } from "../src/slack/approval-store.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { TENANCY } from "../src/tenants/migrations.ts";
import { useOwnerDatabase } from "../src/tenants/owner-pool.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId, type PendingApprovalRecord, type TurnRequest, type TurnResult } from "../src/types.ts";
import type { Cron, Monitor } from "../src/triggers/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { settle } from "./support/settle.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const TENANTS: Record<string, string> = { alpha: A, bravo: B };
const PAIRS: Array<[string, string]> = [
  [A, "a"],
  [B, "b"],
];
const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenant claim tests";

async function twoTenants(): Promise<{ url: string; admin: pg.Pool }> {
  const url = testDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  for (const migration of TENANCY) for (const statement of migration.statements) await admin.query(statement);
  await admin.query("INSERT INTO tenants(id) VALUES ($1), ($2) ON CONFLICT DO NOTHING", [A, B]);
  return { url, admin };
}

async function restrictedLogin(admin: pg.Pool, url: string): Promise<{ url: string; drop(): Promise<void> }> {
  const role = `qmt_app_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOBYPASSRLS`);
  await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  const appUrl = new URL(url);
  appUrl.username = role;
  appUrl.password = role;
  return {
    url: appUrl.toString(),
    async drop() {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    },
  };
}

function cronWorld(url: string) {
  const maps = createPostgresMapFactory(url);
  const crons = createCronStore(maps.map<Cron>("crons"), { fires: createPostgresCronFireStore(url) });
  const seen: Array<[string, string | undefined]> = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    seen.push([Object.keys(TENANTS).find((name) => req.text.includes(name)) ?? req.text, boundTenant()]);
    return { status: "ok", reply: "OUT" };
  };
  const deps = {
    ...singleProcessDeps(),
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(maps.map("idempotency")),
    identity: createIdentityService(maps.map("identities"), { externalMembers: maps.map("external_members") }),
    run,
  };
  return { crons, seen, deps };
}

async function createCrons(crons: ReturnType<typeof cronWorld>["crons"]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [action, tenant] of Object.entries(TENANTS)) {
    const cron = await withTenant(tenant, () =>
      crons.create({
        schedule: { everyMs: 1000, firstFireAt: 1 },
        action,
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      }),
    );
    ids[action] = cron.id;
  }
  return ids;
}

test("a scheduler tick fires each tenant's due cron under that tenant", { skip }, async () => {
  const { url, admin } = await twoTenants();
  try {
    const { crons, seen, deps } = cronWorld(url);
    const ids = await createCrons(crons);
    assert.deepEqual(
      (await crons.due(5000)).map((cron) => [cron.id, cron.tenantId]).sort(),
      [
        [ids.alpha, A],
        [ids.bravo, B],
      ].sort(),
    );
    await createScheduler(deps).tick(5000);
    assert.deepEqual(seen.sort(), Object.entries(TENANTS).sort());
    const fires = await admin.query("SELECT cron_id, tenant_id FROM cron_fires ORDER BY tenant_id");
    assert.deepEqual(
      fires.rows.map((row) => [row.cron_id, row.tenant_id]),
      [
        [ids.alpha, A],
        [ids.bravo, B],
      ],
    );
    const fired = await admin.query("SELECT tenant_id FROM crons WHERE json ? 'lastFiredAt' ORDER BY tenant_id");
    assert.deepEqual(
      fired.rows.map((row) => row.tenant_id),
      [A, B],
    );
    await admin.query("UPDATE cron_fires SET status = 'running', ended_at = NULL, fired_at = 0");
    assert.equal(await crons.sweepStrandedFires(Date.now()), 2);
    assert.equal(await crons.pruneFires(Date.now()), 0);
  } finally {
    await admin.end();
  }
});

test("queued cron jobs carry the tenant they were enqueued under and fire under it", { skip }, async () => {
  const { url, admin } = await twoTenants();
  try {
    const { crons, seen, deps } = cronWorld(url);
    const ids = await createCrons(crons);
    const jobs: CronFireJob[] = [];
    let handlers: Parameters<CronJobQueue["start"]>[0] | undefined;
    const scheduler = createScheduler({
      ...deps,
      jobQueue: {
        async start(next) {
          handlers = next;
        },
        async enqueueFire(job) {
          jobs.push(job);
        },
        healthy: () => true,
        async stop() {},
      },
    });
    scheduler.start(60_000);
    await settle(async () => handlers !== undefined);
    withTenant(B, () => scheduler.notifyChanged(ids.bravo!));
    await settle(async () => jobs.some((queued) => queued.cronId === ids.bravo));
    const job = jobs.find((queued) => queued.cronId === ids.bravo)!;
    assert.equal(job.tenantId, B);
    await handlers!.onFire(job);
    assert.deepEqual(seen, [["bravo", B]]);
    await scheduler.stop();
  } finally {
    await admin.end();
  }
});

function pendingAsk(id: string): KeychainAsk {
  return {
    id,
    credentialId: `cred-${id}`,
    ownerId: "U1",
    requesterId: "U2",
    requesterScopeId: scopeId("personal", "U2"),
    purpose: "deploy",
    status: "pending",
    createdAt: 1,
    expiresAt: 2,
  };
}

test("the ask sweep settles each tenant's asks under that tenant on the restricted login", { skip }, async () => {
  const { url, admin } = await twoTenants();
  const ownerMaps = createPostgresMapFactory(url);
  for (const [tenant, suffix] of PAIRS)
    await withTenant(tenant, async () => {
      await ownerMaps.map("keychain_creds").all();
      await ownerMaps.map("keychain_grants").all();
      await ownerMaps.map<KeychainAsk>("keychain_asks").put(`ask-${suffix}`, pendingAsk(`ask-${suffix}`));
    });
  const login = await restrictedLogin(admin, url);
  useOwnerDatabase(url);
  const appMaps = createPostgresMapFactory(login.url);
  try {
    await assert.rejects(appMaps.map("keychain_asks").all(), /No tenant is bound/);
    const keychain = createKeychain({
      lock: createNoopAdvisoryLock(),
      creds: appMaps.map("keychain_creds"),
      grants: appMaps.map("keychain_grants"),
      asks: appMaps.map("keychain_asks"),
      key: deriveConnectorKey("tenant-ask-sweep-key"),
      now: () => 10_000,
    });
    const fired: Array<[string, string | undefined]> = [];
    const sweep = createAskExpirySweep({
      keychain,
      fire: async (ask) => {
        fired.push([ask.id, boundTenant()]);
      },
    });
    await sweep(10_000);
    assert.deepEqual(fired.sort(), [
      ["ask-a", A],
      ["ask-b", B],
    ]);
    const rows = await admin.query(
      `SELECT id, tenant_id, json->>'status' AS status, json ? 'notifiedAt' AS notified
         FROM keychain_asks ORDER BY id`,
    );
    assert.deepEqual(rows.rows, [
      { id: "ask-a", tenant_id: A, status: "expired", notified: true },
      { id: "ask-b", tenant_id: B, status: "expired", notified: true },
    ]);
  } finally {
    useOwnerDatabase(undefined);
    await appMaps.pool.close();
    await ownerMaps.pool.close();
    await login.drop();
    await admin.end();
  }
});

function monitor(id: string, enabled: boolean): Monitor {
  return {
    id,
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
    enabled,
    createdAt: enabled ? Date.now() : 1,
    processId: `p-${id}`,
    command: "tail",
    threadRef: `t-${id}`,
    cursor: 0,
    expiresAt: enabled ? Date.now() + 60_000 : 1,
  };
}

test("monitor scans and retention run across tenants on the restricted login", { skip }, async () => {
  const { url, admin } = await twoTenants();
  const ownerMaps = createPostgresMapFactory(url);
  const ownerMonitors = ownerMaps.map<Monitor>("monitors");
  for (const [tenant, suffix] of PAIRS)
    await withTenant(tenant, async () => {
      await ownerMonitors.put(`live-${suffix}`, monitor(`live-${suffix}`, true));
      await ownerMonitors.put(`dead-${suffix}`, monitor(`dead-${suffix}`, false));
    });
  const login = await restrictedLogin(admin, url);
  useOwnerDatabase(url);
  const appMaps = createPostgresMapFactory(login.url);
  try {
    const monitors = createMonitorStore(appMaps.map<Monitor>("monitors"));
    assert.deepEqual(
      (await monitors.enabledAcrossTenants()).map((m) => [m.id, m.tenantId]),
      [
        ["live-a", A],
        ["live-b", B],
      ],
    );
    assert.equal(await monitors.deleteDefunct(Date.now()), 2);
    const rows = await admin.query("SELECT id, tenant_id FROM monitors ORDER BY id");
    assert.deepEqual(
      rows.rows.map((row) => [row.id, row.tenant_id]),
      [
        ["live-a", A],
        ["live-b", B],
      ],
    );
  } finally {
    useOwnerDatabase(undefined);
    await appMaps.pool.close();
    await ownerMaps.pool.close();
    await login.drop();
    await admin.end();
  }
});

function ingressSource(owner: string): LoopIngress {
  return { id: `src-${owner}`, loopId: `loop-${owner}`, owner, kind: "webhook", enabled: true, createdAt: 1 };
}

function finishedDelivery(owner: string): IngressDelivery {
  return {
    id: `old-${owner}`,
    ingressId: `src-${owner}`,
    queueKey: `src-${owner}`,
    receivedAt: 1,
    completedAt: 1,
    attempts: 1,
    nextAttemptAt: 1,
  };
}

test("loop ingress maintenance renews, processes and prunes each tenant's sources under it", { skip }, async () => {
  const { url, admin } = await twoTenants();
  const maps = createPostgresMapFactory(url);
  try {
    const sources = maps.map<LoopIngress>("loop_ingress", ["loopId"]);
    const deliveries = maps.map<IngressDelivery>("loop_ingress_deliveries", ["queueKey"]);
    for (const [owner, tenant] of Object.entries(TENANTS))
      await withTenant(tenant, async () => {
        await sources.put(`src-${owner}`, ingressSource(owner));
        await deliveries.put(`old-${owner}`, finishedDelivery(owner));
      });
    const checked = new Set<string>();
    const outputs = createLoopOutputStore(maps.map("loop_outputs"));
    const ingress = createLoopIngress({
      enabledFor: async (owner) => {
        checked.add(`${owner}:${boundTenant()}`);
        return false;
      },
      sources,
      deliveries,
      loops: createLoopStore(maps.map("loops")),
      items: createLoopItemLedger(maps.map("loop_items"), outputs),
      outputs,
      fire: { fire: async (): Promise<{ status: TurnResult["status"] }> => ({ status: "ok" }) },
      lock: createNoopAdvisoryLock(),
    });
    await ingress.maintain();
    assert.deepEqual([...checked].sort(), [`alpha:${A}`, `bravo:${B}`]);
    assert.equal((await admin.query("SELECT 1 FROM loop_ingress_deliveries")).rowCount, 0);
    assert.deepEqual(
      (await createLoopStore(maps.map("loops")).listAcrossTenants()).map((loop) => loop.tenantId),
      [],
    );
  } finally {
    await maps.pool.close();
    await admin.end();
  }
});

function approval(threadRef: string): PendingApprovalRecord {
  return {
    sessionId: threadRef,
    command: "publish",
    createdAt: 1,
    request: {
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "publish report",
    },
    kind: "input",
    grantModes: { session: false, always: false },
  };
}

test("approval redelivery enqueues each tenant's pending approval under that tenant", { skip }, async () => {
  const { url, admin } = await twoTenants();
  const ownerMaps = createPostgresMapFactory(url);
  const ownerApprovals = ownerMaps.map<PendingApprovalRecord>("pending_approvals");
  for (const [tenant, suffix] of PAIRS)
    await withTenant(tenant, () => ownerApprovals.put(`ap-${suffix}`, approval(`dm:${suffix}`)));
  const login = await restrictedLogin(admin, url);
  useOwnerDatabase(url);
  const appMaps = createPostgresMapFactory(login.url);
  try {
    const enqueued: Array<[string | undefined, string | undefined]> = [];
    const store = createDeliveryStore();
    const approvals = createApprovalStore(appMaps.map<PendingApprovalRecord>("pending_approvals"), {
      enqueue: async (delivery) => {
        enqueued.push([delivery.destination.commandApprovalId, boundTenant()]);
        return store.enqueue(delivery);
      },
    });
    await approvals.deliverPending();
    assert.deepEqual(enqueued.sort(), [
      ["ap-a", A],
      ["ap-b", B],
    ]);
  } finally {
    useOwnerDatabase(undefined);
    await appMaps.pool.close();
    await ownerMaps.pool.close();
    await login.drop();
    await admin.end();
  }
});
