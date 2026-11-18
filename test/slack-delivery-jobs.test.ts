import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { createSlackCoreClient } from "../src/api/slack-core-client.ts";
import { installCronQueue } from "../src/cron/job-queue.ts";
import { grantAppRole } from "../src/persistence/app-role-grants.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresLeaderLease } from "../src/persistence/leader-lease.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";
import { createSlackDeliveryJobs, type DeliveryLane } from "../src/slack/delivery-jobs.ts";
import { currentTenant, withTenant } from "../src/tenants/context.ts";
import type { Delivery } from "../src/types.ts";
import { settle } from "./support/settle.ts";
import { APP_ROLE } from "./support/test-tenant.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

const rateLimited = (seconds: number) =>
  Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: seconds });

describeTwoTenants("slack deliveries run as pg-boss jobs per conversation across tenants and cores", (db) => {
  let a: string;
  let b: string;
  let cores: DeliveryStore[];
  let jobs: ReturnType<typeof createSlackDeliveryJobs>[] = [];
  const stops: Array<() => void> = [];

  before(async () => {
    [a, b] = db.tenants;
    await installCronQueue(db.ownerDatabaseUrl);
    await grantAppRole((text, params) => db.owner.q(text, params), APP_ROLE, "pgboss");
    cores = [createPostgresDeliveryStore(db.appDatabaseUrl)];
    await cores[0]!.claimDue("slack", 1);
    cores.push(createPostgresDeliveryStore(db.appDatabaseUrl));
    jobs = cores.map((core) => createSlackDeliveryJobs(db.app, core, 1_000));
  });

  const enqueue = (tenant: string, target: string, text: string) =>
    withTenant(tenant, () =>
      cores[0]!.enqueue({ destination: { type: "slack", target }, text, idempotencyKey: `${tenant}:${text}` }),
    );

  const serve = (core: number, tenant: string, lane: DeliveryLane): void => {
    stops.push(jobs[core]!.serve(tenant, lane));
  };

  const acking =
    (core: number, log: Array<[string, string, number]>, work?: (d: Delivery) => Promise<void>): DeliveryLane =>
    async (d) => {
      await work?.(d);
      log.push([d.text, currentTenant(), core]);
      await cores[core]!.ack(d.id, Date.now());
    };

  const stopAll = (): void => {
    for (const stop of stops.splice(0)) stop();
  };
  after(stopAll);

  it("drains two tenants at once on two cores, each row once under its own tenant", async () => {
    const log: Array<[string, string, number]> = [];
    let bSent!: () => void;
    const bDone = new Promise<void>((resolve) => (bSent = resolve));
    for (const core of [0, 1]) {
      serve(
        core,
        a,
        acking(core, log, () => bDone),
      );
      serve(core, b, async (d) => {
        await acking(core, log)(d);
        bSent();
      });
    }
    await enqueue(a, "C1:1.0", "a-first");
    await enqueue(b, "C1:1.0", "b-first");
    await settle(async () => log.length === 2);
    stopAll();
    assert.deepEqual(
      log.map(([text, tenant]) => [text, tenant]),
      [
        ["b-first", b],
        ["a-first", a],
      ],
    );
  });

  it("waits out a rate-limited conversation until Slack's retry time without delaying another tenant", async () => {
    const log: Array<[string, string, number]> = [];
    let limitedAt = 0;
    serve(
      0,
      a,
      acking(0, log, async () => {
        if (limitedAt) return;
        limitedAt = Date.now();
        throw rateLimited(1);
      }),
    );
    serve(0, b, acking(0, log));
    const first = await enqueue(a, "C2:1.0", "a-limited");
    await enqueue(a, "C2:1.0", "a-next");
    await enqueue(b, "C2:1.0", "b-free");
    await settle(async () => log.length === 3);
    stopAll();
    assert.deepEqual(
      log.map(([text]) => text),
      ["b-free", "a-limited", "a-next"],
    );
    const delivered = await withTenant(a, () => cores[0]!.get(first.id));
    assert.ok(delivered!.deliveredAt! - limitedAt >= 1_000);
  });

  it("retries a conversation on another core when the core delivering it goes away", async () => {
    const log: Array<[string, string, number]> = [];
    let claimedAt = 0;
    serve(0, a, async () => {
      claimedAt = Date.now();
      await new Promise<void>(() => {});
    });
    await enqueue(a, "C3:1.0", "orphaned");
    await settle(async () => claimedAt > 0);
    stopAll();
    serve(1, a, acking(1, log));
    await settle(async () => log.length === 1);
    stopAll();
    assert.deepEqual(log, [["orphaned", a, 1]]);
  });

  it("keeps a conversation's replies in order while another conversation proceeds", async () => {
    const log: Array<[string, string, number]> = [];
    const open = new Set<string>();
    let overlapped = false;
    for (const core of [0, 1])
      serve(
        core,
        a,
        acking(core, log, async (d) => {
          if (open.has(d.destination.target)) overlapped = true;
          open.add(d.destination.target);
          await new Promise((resolve) => setTimeout(resolve, 50));
          open.delete(d.destination.target);
        }),
      );
    for (const text of ["one", "two", "three"]) await enqueue(a, "C4:1.0", text);
    await enqueue(a, "C5:1.0", "elsewhere");
    await settle(async () => log.length === 4);
    stopAll();
    assert.equal(overlapped, false);
    assert.deepEqual(
      log.map(([text]) => text).filter((text) => text !== "elsewhere"),
      ["one", "two", "three"],
    );
    assert.ok(log.findIndex(([text]) => text === "elsewhere") < 2);
  });

  it("delivers rows that were pending before any core queued them, once another dispatcher's claim lapses", async () => {
    const log: Array<[string, string, number]> = [];
    await enqueue(b, "C6:1.0", "held");
    const [held] = await withTenant(b, () => cores[1]!.claimDue("slack", 2_000));
    await enqueue(b, "C7:1.0", "waiting");
    serve(1, b, acking(1, log));
    await settle(async () => log.length === 2);
    stopAll();
    assert.deepEqual(log.map(([text]) => text).sort(), ["held", "waiting"]);
    const delivered = await withTenant(b, () => cores[1]!.get(held!.id));
    assert.ok(delivered!.deliveredAt! >= held!.createdAt + 2_000);
  });

  it("holds directory sync per Slack bot account, so one tenant's crawl never blocks another's", async () => {
    const pg = createPgPool(db.ownerDatabaseUrl);
    const [first, second] = [0, 1].map(() =>
      createSlackCoreClient({ leaderLease: createPostgresLeaderLease(pg) } as never),
    );
    let release!: () => void;
    const crawling = first!.holdDirectorySync("T1:U1", () => new Promise<void>((r) => (release = r)));
    await settle(async () => release !== undefined);
    assert.equal(await second!.holdDirectorySync("T1:U1", async () => "T1:U1"), null);
    assert.equal(await second!.holdDirectorySync("T1:U2", async () => "T1:U2"), "T1:U2");
    release();
    await crawling;
    await pg.close();
  });
});
