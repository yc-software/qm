import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
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
import { createLoopIngress, type IngressDelivery, type LoopIngress } from "../src/loops/ingress.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createLoopFireService } from "../src/loops/loop-fire.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { boundTenant, currentTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";
import type { Cron } from "../src/triggers/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { settle } from "./support/settle.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

const personal = scopeId("personal", "U1");

describe("background sweeps claim across tenants and bind each row's tenant", () => {
  let db: TwoTenants;
  let maps: ReturnType<typeof createPostgresMapFactory>;

  before(async () => {
    db = await twoTenants();
    maps = createPostgresMapFactory(db.appDatabaseUrl);
  });

  after(async () => {
    await maps?.pool.close();
    await db?.close();
  });

  const names = (): Record<string, string> => ({ alpha: db.tenants[0], bravo: db.tenants[1] });

  function cronWorld() {
    const crons = createCronStore(maps.map<Cron>("crons", ["ownerScopeId"]), {
      fires: createPostgresCronFireStore(db.appDatabaseUrl),
    });
    const seen: Array<[string, string | undefined]> = [];
    const run = async (req: TurnRequest): Promise<TurnResult> => {
      seen.push([Object.keys(names()).find((name) => req.text.includes(name)) ?? req.text, boundTenant()]);
      return { status: "ok", reply: "OUT" };
    };
    const deps = {
      ...singleProcessDeps(),
      crons,
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(maps.map("idempotency")),
      identity: createIdentityService(maps.map("deactivated_principals"), {
        externalMembers: maps.map("external_members"),
      }),
      run,
    };
    return { crons, seen, deps };
  }

  async function createCrons(crons: ReturnType<typeof cronWorld>["crons"], prefix: string) {
    const ids: Record<string, string> = {};
    for (const [action, tenant] of Object.entries(names())) {
      const cron = await withTenant(tenant, () =>
        crons.create({
          schedule: { everyMs: 1000, firstFireAt: 1 },
          action: `${prefix} ${action}`,
          owner: "U1",
          createdBy: "U1",
          ownerScopeId: personal,
        }),
      );
      ids[action] = cron.id;
    }
    return ids;
  }

  it("fires each tenant's due cron under that tenant and sweeps and prunes fires across tenants", async () => {
    const { crons, seen, deps } = cronWorld();
    const ids = await createCrons(crons, "tick");
    const [a, b] = db.tenants;
    assert.deepEqual(
      (await crons.due(5000)).map((cron) => [cron.id, cron.tenantId]).sort(),
      [
        [ids.alpha, a],
        [ids.bravo, b],
      ].sort(),
    );
    await createScheduler(deps).tick(5000);
    assert.deepEqual(seen.sort(), [
      ["alpha", a],
      ["bravo", b],
    ]);
    const fires = await db.owner.q("SELECT cron_id, tenant_id::text AS tenant_id FROM cron_fires ORDER BY cron_id");
    assert.deepEqual(
      fires.map((row) => [row.cron_id, row.tenant_id]).sort(),
      [
        [ids.alpha, a],
        [ids.bravo, b],
      ].sort(),
    );
    const fired = await db.owner.q(
      "SELECT tenant_id::text AS tenant_id FROM crons WHERE json ? 'lastFiredAt' ORDER BY tenant_id",
    );
    assert.deepEqual(
      fired.map((row) => row.tenant_id),
      [a, b].sort(),
    );
    await db.owner.q("UPDATE cron_fires SET status = 'running', ended_at = NULL, fired_at = 0");
    assert.equal(await crons.sweepStrandedFires(Date.now()), 2);
    const failed = await db.owner.q("SELECT tenant_id::text AS tenant_id FROM cron_fires WHERE status = 'failed'");
    assert.deepEqual(failed.map((row) => row.tenant_id).sort(), [a, b].sort());
    await db.owner.q("UPDATE cron_fires SET ended_at = 1");
    assert.equal(await crons.pruneFires(Date.now()), 0);
    await db.owner.q("DELETE FROM crons");
    await db.owner.q("DELETE FROM cron_fires");
  });

  it("queues each tenant's next slot with its tenant and fires a queued job under that tenant", async () => {
    const { crons, seen, deps } = cronWorld();
    const ids = await createCrons(crons, "queued");
    const [a, b] = db.tenants;
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
    await settle(async () => jobs.length >= 2);
    assert.deepEqual(
      jobs.map((job) => [job.cronId, job.tenantId]).sort(),
      [
        [ids.alpha, a],
        [ids.bravo, b],
      ].sort(),
    );
    withTenant(b, () => scheduler.notifyChanged(ids.bravo!));
    await settle(async () => jobs.length >= 3);
    assert.equal(jobs.at(-1)!.tenantId, b);
    await handlers!.onFire(jobs.at(-1)!);
    assert.deepEqual(seen, [["bravo", b]]);
    await scheduler.stop();
    await db.owner.q("DELETE FROM crons");
  });

  it("settles each tenant's resolved asks under that tenant", async () => {
    const asks = maps.map<KeychainAsk>("keychain_asks");
    const pending = (id: string): KeychainAsk => ({
      id,
      credentialId: `cred-${id}`,
      ownerId: "U1",
      requesterId: "U2",
      requesterScopeId: scopeId("personal", "U2"),
      purpose: "deploy",
      status: "pending",
      createdAt: 1,
      expiresAt: 2,
    });
    const [a, b] = db.tenants;
    await withTenant(a, () => asks.put("ask-a", pending("ask-a")));
    await withTenant(b, () => asks.put("ask-b", pending("ask-b")));
    await assert.rejects(asks.get("ask-a"), /No tenant is bound/);
    const keychain = createKeychain({
      lock: createNoopAdvisoryLock(),
      creds: maps.map("keychain_credentials", ["ownerId"]),
      grants: maps.map("keychain_grants", ["ownerId"]),
      asks,
      key: deriveConnectorKey("tenant-ask-sweep-key"),
      now: () => 10_000,
    });
    const fired: Array<[string, string]> = [];
    const sweep = createAskExpirySweep({
      keychain,
      fire: async (ask) => {
        fired.push([ask.id, currentTenant()]);
      },
    });
    await sweep(10_000);
    assert.deepEqual(fired.sort(), [
      ["ask-a", a],
      ["ask-b", b],
    ]);
    const rows = await db.owner.q(
      `SELECT id, tenant_id::text AS tenant_id, json->>'status' AS status, json ? 'notifiedAt' AS notified
         FROM keychain_asks ORDER BY id`,
    );
    assert.deepEqual(rows, [
      { id: "ask-a", tenant_id: a, status: "expired", notified: true },
      { id: "ask-b", tenant_id: b, status: "expired", notified: true },
    ]);
  });

  it("renews, processes and prunes each tenant's loop ingress under that tenant", async () => {
    const sources = maps.map<LoopIngress>("loop_ingress", ["loopId"]);
    const deliveries = maps.map<IngressDelivery>("loop_ingress_deliveries", ["queueKey"]);
    for (const [owner, tenant] of Object.entries(names()))
      await withTenant(tenant, async () => {
        await sources.put(`src-${owner}`, {
          id: `src-${owner}`,
          loopId: `loop-${owner}`,
          owner,
          kind: "webhook",
          enabled: true,
          createdAt: 1,
        });
        await deliveries.put(`old-${owner}`, {
          id: `old-${owner}`,
          ingressId: `src-${owner}`,
          queueKey: `src-${owner}`,
          receivedAt: 1,
          completedAt: 1,
          attempts: 1,
          nextAttemptAt: 1,
        });
      });
    const checked = new Set<string>();
    const ingress = createLoopIngress({
      enabledFor: async (owner) => {
        checked.add(`${owner}:${currentTenant()}`);
        return false;
      },
      sources,
      deliveries,
      loops: createLoopStore(maps.map("loops")),
      items: createLoopItemLedger(maps.map("loop_items", ["loopId"])),
      outputs: createLoopOutputStore(maps.map("loop_outputs", ["itemId"])),
      fire: { fire: async (): Promise<{ status: TurnResult["status"] }> => ({ status: "ok" }) },
      lock: createNoopAdvisoryLock(),
    });
    await ingress.maintain();
    const [a, b] = db.tenants;
    assert.deepEqual([...checked].sort(), [`alpha:${a}`, `bravo:${b}`].sort());
    assert.equal((await db.owner.q("SELECT 1 FROM loop_ingress_deliveries")).length, 0);
  });

  it("pings each tenant's stale loop under that tenant", async () => {
    const loops = createLoopStore(maps.map("loops"));
    const sent: Array<[string, string]> = [];
    const fire = createLoopFireService({
      crons: cronWorld().crons,
      triageEnabledFor: async () => true,
      loops,
      items: createLoopItemLedger(maps.map("loop_items", ["loopId"])),
      outputs: createLoopOutputStore(maps.map("loop_outputs", ["itemId"])),
      grants: createShipGrantStore(maps.map("loop_ship_grants")),
      files: {} as never,
      trigger: {
        deliveries: {
          enqueue: async (d: { text: string }) => {
            sent.push([d.text, currentTenant()]);
            return { id: "d1" };
          },
        } as never,
        idempotency: createIdempotencyStore(maps.map("idempotency")),
        identity: { refresh: async () => {}, classify: () => ({ type: "internal" as const }) } as never,
        run: async (): Promise<TurnResult> => ({ status: "ok", reply: "ok" }),
      },
    });
    const created: number[] = [];
    for (const tenant of db.tenants)
      await withTenant(tenant, async () => {
        const { loop } = await loops.create({
          owner: "josh",
          createdBy: "josh",
          ownerScopeId: scopeId("personal", "josh"),
          name: "Sentry triage",
          playbook: "triage sentry issues",
          successCondition: "a fix PR is linked",
          shipActions: [{ action: "open_pr", gate: "hold" }],
          governor: { staleFireMs: 1_000 },
          destination: { type: "slack", target: "C1", audienceScopeId: scopeId("personal", "josh") },
        } as never);
        created.push(loop.createdAt);
      });
    await fire.sweepStale(Math.max(...created) + 1_001);
    assert.deepEqual(sent.map(([, tenant]) => tenant).sort(), [...db.tenants].sort());
    for (const [text] of sent) assert.match(text, /trigger looks dead/);
  });
});
