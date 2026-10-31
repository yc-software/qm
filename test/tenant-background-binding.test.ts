import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createWorker } from "../src/runs/worker.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresNotifyBus } from "../src/persistence/postgres-notify-bus.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createEngagedRegistry } from "../src/wake/engaged-registry.ts";
import { createWakeSweep } from "../src/wake/sweep.ts";
import { claimAcrossTenants, eachTenant, inTenantOf, type EachTenant } from "../src/tenants/claim.ts";
import { boundTenant, tenantKey, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { pgTenants } from "../src/tenants/resolver.ts";
import type { CronFireJob, CronJobQueue } from "../src/cron/job-queue.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { scopeId, type TurnResult } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testAdvisoryLock, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";
import { OTHER_TENANT, seedTestTenants, TEST_TENANT } from "./support/tenant.ts";
import { testCronRows, testIdempotencyStore, testIdentityService } from "./support/typed-stores.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the tenant claim tests";
before(() => (URL ? seedTestTenants(URL) : undefined));

const actor = { id: "internal:U1", type: "internal" as const };
const request = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: `binding-${randomUUID()}`, audience: [actor] },
  origin: { kind: "direct" },
  text,
});
const twoTenants: EachTenant = async (fn) => {
  for (const tenant of [TEST_TENANT, OTHER_TENANT]) await withTenant(tenant, fn);
};

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(await check(), "timed out");
}

test("a worker claims due runs across tenants and runs each under its own tenant", { skip }, () =>
  withoutTenant(async () => {
    const { runs, close } = createPostgresRunStore(URL!);
    const seen = new Map<string, string | undefined>();
    const orchestrator = {
      async handleTurn(input: OrchestratorInput): Promise<TurnResult> {
        seen.set(input.text, boundTenant());
        return { status: "ok", sessionId: "x", reply: input.text };
      },
    } as unknown as Orchestrator;
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    await withTenant(TEST_TENANT, () => runs.enqueue({ sessionId: randomUUID(), request: request(a) }));
    await withTenant(OTHER_TENANT, () => runs.enqueue({ sessionId: randomUUID(), request: request(b) }));
    const worker = createWorker({ runs, orchestrator, leaseTtlMs: 60_000, pollMs: 5 });
    worker.start();
    try {
      await until(() => seen.has(a) && seen.has(b));
      assert.equal(seen.get(a), TEST_TENANT);
      assert.equal(seen.get(b), OTHER_TENANT);
    } finally {
      await worker.releaseInFlight();
      await close();
    }
  }),
);

test("a bound claim only sees its own tenant's runs", { skip }, () =>
  withoutTenant(async () => {
    const { runs, close } = createPostgresRunStore(URL!);
    try {
      const sessionId = randomUUID();
      const queued = (await withTenant(OTHER_TENANT, () => runs.enqueue({ sessionId, request: request("other") }))).run;
      assert.equal(queued.tenantId, OTHER_TENANT);
      assert.equal(await withTenant(TEST_TENANT, () => runs.claimForSession(sessionId, "inline", 60_000)), null);
      const own = await withTenant(OTHER_TENANT, () => runs.claimForSession(sessionId, "inline", 60_000));
      assert.equal(own?.id, queued.id);
      await withTenant(OTHER_TENANT, () =>
        runs.complete(queued.id, own!.leaseToken!, { status: "ok", sessionId, reply: "" }),
      );
    } finally {
      await close();
    }
  }),
);

test("terminal listeners run under the finished run's tenant", { skip }, () =>
  withoutTenant(async () => {
    const { runs, close } = createPostgresRunStore(URL!);
    const terminal = new Map<string, string | undefined>();
    runs.onTerminal((run) => terminal.set(run.id, boundTenant()));
    try {
      const sessionId = randomUUID();
      const { run } = await withTenant(OTHER_TENANT, () => runs.enqueue({ sessionId, request: request("t") }));
      const claimed = await runs.claimById(run.id, "w", 60_000);
      assert.equal(claimed?.tenantId, OTHER_TENANT);
      await withTenant(OTHER_TENANT, () => runs.complete(run.id, claimed!.leaseToken!, { status: "ok", sessionId }));
      assert.equal(terminal.get(run.id), OTHER_TENANT);
    } finally {
      await close();
    }
  }),
);

test("deliveries drain across tenants unbound and only the bound tenant's rows when bound", { skip }, () =>
  withoutTenant(async () => {
    const store = createPostgresDeliveryStore(URL!);
    const type = `binding-${randomUUID()}`;
    const enqueue = (tenant: string, key: string) =>
      withTenant(tenant, () =>
        store.enqueue({ destination: { type, target: "x" } as never, text: key, idempotencyKey: key }),
      );
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    await enqueue(TEST_TENANT, a);
    await enqueue(OTHER_TENANT, b);
    const bound = await withTenant(TEST_TENANT, () => store.pending(type));
    assert.deepEqual(
      bound.map((d) => [d.text, d.tenantId]),
      [[a, TEST_TENANT]],
    );
    const claimed = await store.claimPending(type, 60_000);
    assert.deepEqual(
      claimed.map((d) => [d.text, d.tenantId]),
      [
        [a, TEST_TENANT],
        [b, OTHER_TENANT],
      ],
    );
  }),
);

test("the cross-tenant claim path requires every row to carry its tenant", { skip }, () =>
  withoutTenant(async () => {
    const db = createPgPool(URL!);
    try {
      await assert.rejects(claimAcrossTenants(db, "SELECT 1 AS n"), /must return each row's tenant_id/);
      const seen: Array<string | undefined> = [];
      await eachTenant(pgTenants(db))(async () => void seen.push(boundTenant()));
      assert.ok(seen.includes(TEST_TENANT) && seen.includes(OTHER_TENANT));
      assert.ok(seen.every((tenant) => tenant !== undefined));
    } finally {
      await db.close();
    }
  }),
);

test("an unbound tick cannot touch tenant rows", { skip }, () =>
  withoutTenant(async () => {
    const { runs, close } = createPostgresRunStore(URL!);
    try {
      await assert.rejects(
        runs.enqueue({ sessionId: randomUUID(), request: request("unbound") }),
        /No tenant is bound/,
      );
      await withTenant(TEST_TENANT, () =>
        inTenantOf(undefined, () =>
          assert.rejects(
            runs.enqueue({ sessionId: randomUUID(), request: request("tenantless") }),
            /No tenant is bound/,
          ),
        ),
      );
    } finally {
      await close();
    }
  }),
);

test("NOTIFY payloads carry the emitter's tenant to subscribers", { skip }, () =>
  withoutTenant(async () => {
    const bus = createPostgresNotifyBus<{ n: number }>(URL!, `binding_${randomUUID().slice(0, 8)}`, "binding");
    const received: Array<[number, string | undefined]> = [];
    const off = bus.subscribe((event) => void received.push([event.n, boundTenant()]));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      withTenant(TEST_TENANT, () => bus.emit({ n: 1 }));
      withTenant(OTHER_TENANT, () => bus.emit({ n: 2 }));
      await until(() => received.length === 2);
      assert.deepEqual(
        received.sort((x, y) => x[0] - y[0]),
        [
          [1, TEST_TENANT],
          [2, OTHER_TENANT],
        ],
      );
    } finally {
      off();
      await bus.close?.();
    }
  }),
);

test("the scheduler ticks each tenant bound and cron-fire jobs carry and rebind their tenant", () =>
  withoutTenant(async () => {
    const crons = createCronStore(testCronRows(), { fires: createPostgresCronFireStore(testDatabaseUrl()) });
    const dueUnder: Array<string | undefined> = [];
    const getUnder: Array<string | undefined> = [];
    const due = crons.due.bind(crons);
    const get = crons.get.bind(crons);
    crons.due = async (t) => (dueUnder.push(boundTenant()), due(t));
    crons.get = async (id) => (getUnder.push(boundTenant()), get(id));
    const enqueued: CronFireJob[] = [];
    let onFire: ((job: CronFireJob) => Promise<void>) | undefined;
    const jobQueue: CronJobQueue = {
      async start(handlers) {
        onFire = handlers.onFire;
      },
      async enqueueFire(job) {
        enqueued.push(job);
      },
      healthy: () => false,
      async stop() {},
    };
    const deps = {
      ...singleProcessDeps(),
      crons,
      deliveries: createDeliveryStore(),
      idempotency: testIdempotencyStore(),
      identity: testIdentityService(),
      run: async () => ({ status: "ok" as const, reply: "" }),
      tenants: twoTenants,
    };
    await createScheduler(deps).tick(Date.now());
    assert.deepEqual(dueUnder, [TEST_TENANT, OTHER_TENANT]);
    const scheduler = createScheduler({ ...deps, jobQueue });
    scheduler.start(1000);
    await scheduler.ready();
    const cron = await withTenant(OTHER_TENANT, () =>
      crons.create({
        schedule: { everyMs: 60_000 },
        action: "x",
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      }),
    );
    withTenant(OTHER_TENANT, () => scheduler.notifyChanged(cron.id));
    await until(() => enqueued.length > 0);
    assert.equal(enqueued[0]!.tenantId, OTHER_TENANT);
    getUnder.length = 0;
    await onFire!({ tenantId: TEST_TENANT, cronId: cron.id, scheduledAt: 0 });
    assert.deepEqual(getUnder, [TEST_TENANT]);
    await scheduler.stop();
  }));

test("engaged sessions and session admission locks are keyed by tenant", () =>
  withoutTenant(async () => {
    const engaged = createEngagedRegistry();
    withTenant(TEST_TENANT, () => engaged.engage("thread"));
    withTenant(OTHER_TENANT, () => engaged.engage("thread"));
    withTenant(TEST_TENANT, () => engaged.settle("thread"));
    assert.deepEqual(engaged.list(), [{ tenantId: OTHER_TENANT, threadRef: "thread" }]);
    const swept: Array<string | undefined> = [];
    const sweep = createWakeSweep(
      {
        engagedSessions: async () => engaged.list(),
        sweepSession: async () => (swept.push(boundTenant()), 0),
      },
      { ...singleProcessDeps(), intervalMs: 60_000 },
    );
    await sweep.sweep();
    assert.deepEqual(swept, [OTHER_TENANT]);

    const lock = testAdvisoryLock();
    const admission = () => tenantKey("session-run-admission");
    const held = Promise.withResolvers<void>();
    const holding = withTenant(TEST_TENANT, () => lock.withLock(admission(), () => held.promise));
    assert.equal(await withTenant(OTHER_TENANT, () => lock.tryWithLock!(admission(), async () => "free")), "free");
    assert.equal(await withTenant(TEST_TENANT, () => lock.tryWithLock!(admission(), async () => "free")), null);
    held.resolve();
    await holding;
  }));

test("cross-tenant claims run on the owner login when one is configured", { skip }, () =>
  withoutTenant(async () => {
    const owner = new globalThis.URL(URL!);
    owner.searchParams.set("application_name", "qm-owner-claims");
    configurePgPooling({ databaseUrl: URL!, ownerUrl: owner.toString() });
    const db = createPgPool(URL!);
    try {
      const [row] = await claimAcrossTenants(
        db,
        "SELECT current_setting('application_name') AS login, $1::text AS tenant_id",
        [TEST_TENANT],
      );
      assert.equal(row!.login, "qm-owner-claims");
    } finally {
      configurePgPooling({});
      await db.close();
    }
  }),
);
