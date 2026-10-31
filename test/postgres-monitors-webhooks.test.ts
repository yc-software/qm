import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { createPostgresMonitorRows } from "../src/monitors/monitor-table.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createPostgresWebhookRows } from "../src/webhooks/webhook-table.ts";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const ALICE = "alice@example.com";
const DAY = 24 * 60 * 60_000;
const base = { owner: ALICE, createdBy: ALICE, ownerScopeId: scopeId("personal", ALICE) };

const watch = (overrides: Record<string, unknown> = {}) => ({
  ...base,
  processId: "proc-1",
  command: "npm test",
  threadRef: "web:t1",
  expiresAt: Date.now() + DAY,
  ...overrides,
});

const hook = (action = "triage the event") => ({
  ...base,
  action,
  verification: { scheme: "github" as const, secret: "s3cret" },
  filters: [{ path: "action", in: ["opened"] }],
});

test("monitors are watched per thread, claimed across tenants and swept only when defunct", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresMonitorRows(url),
    async ({ store: rows, tenant, otherTenant }) => {
      const monitors = createMonitorStore(rows);
      const a = await withTenant(tenant, () => monitors.create(watch({ pattern: "FAIL" })));
      const b = await withTenant(otherTenant, () => monitors.create(watch()));
      await withTenant(tenant, async () => {
        assert.deepEqual(await monitors.get(a.id), a);
        assert.deepEqual(
          (await monitors.watching(["web:t1"])).map((m) => m.id),
          [a.id],
        );
        await monitors.advance(a.id, { cursor: 42, tail: "line", firedAt: 5 });
        await monitors.update(a.id, { cursor: 7 });
        const moved = await monitors.get(a.id);
        assert.equal(moved?.cursor, 7);
        assert.equal(moved?.tail, undefined);
        assert.equal(moved?.lastFiredAt, 5);
        assert.equal(await monitors.get(b.id), null);
      });
      assert.deepEqual(
        new Set((await monitors.enabled()).map((m) => `${m.tenantId}/${m.id}`)),
        new Set([`${tenant}/${a.id}`, `${otherTenant}/${b.id}`]),
      );
      assert.deepEqual(
        (await withTenant(tenant, () => monitors.enabled())).map((m) => m.id),
        [a.id],
      );
      await withTenant(otherTenant, () => monitors.setEnabled(b.id, false));
      assert.equal(await monitors.deleteDefunct(Date.now()), 0);
      assert.equal(await monitors.deleteDefunct(Date.now() + 9 * DAY), 1);
      assert.equal(await withTenant(otherTenant, () => monitors.get(b.id)), null);
      assert.equal((await withTenant(tenant, () => monitors.get(a.id)))?.enabled, true);
    },
  );
});

test("the monitor conversion backfills key-value rows into the instance tenant", { skip }, async () => {
  const legacy = {
    id: "m1",
    ...base,
    enabled: true,
    createdAt: 1_700_000_000_000,
    processId: "p1",
    command: "tail -f log",
    threadRef: "web:t9",
    cursor: 12,
    tail: "last line",
    expiresAt: 1_700_100_000_000,
  };
  await withTypedTableDb(
    (url) => createPostgresMonitorRows(url),
    async ({ store: rows, admin, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => rows.get("m1")), legacy);
      const { expiresAt: _expiresAt, ...unexpiring } = legacy;
      assert.deepEqual(await withTenant(tenant, () => rows.get("m2")), {
        ...unexpiring,
        id: "m2",
        expiresAt: legacy.createdAt,
      });
      const { rows: meta } = await admin.query(
        `SELECT tenant_id::text AS tenant, to_regclass('monitors_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'monitors') AS versions
           FROM monitors`,
      );
      assert.deepEqual(meta, [
        { tenant, dropped: true, versions: 0 },
        { tenant, dropped: true, versions: 0 },
      ]);
    },
    (admin) => {
      const { expiresAt: _expiresAt, ...unexpiring } = legacy;
      return seedKeyValueTable(admin, "monitors", { m1: legacy, m2: { ...unexpiring, id: "m2" } });
    },
  );
});

test("webhooks dedupe per tenant and keep the newest events per webhook", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresWebhookRows(url),
    async ({ store: rows, tenant, otherTenant }) => {
      const webhooks = createWebhookStore(rows);
      const mine = await withTenant(tenant, () => webhooks.create(hook()));
      await withTenant(tenant, async () => {
        assert.deepEqual(await webhooks.create(hook()), mine);
        await webhooks.setEnabled(mine.id, false);
        assert.equal((await webhooks.create(hook())).enabled, true);
        await webhooks.recordFire(mine.id, { at: 9, deliveryId: "d1", error: "boom" });
        await webhooks.recordFire(mine.id, { at: 10 });
        const fired = await webhooks.get(mine.id);
        assert.equal(fired?.lastDeliveryId, "d1");
        assert.equal(fired?.lastError, undefined);
        assert.equal(fired?.lastFiredAt, 10);
        assert.deepEqual(
          (await webhooks.ownedBy(base.ownerScopeId)).map((w) => w.id),
          [mine.id],
        );
        for (let i = 0; i < 55; i++) {
          await webhooks.recordEvent(mine.id, {
            deliveryId: `d${i}`,
            receivedAt: 1000 + i,
            payload: "x".repeat(20_000),
          });
        }
        await webhooks.recordEvent(mine.id, { deliveryId: "d54", receivedAt: 1, payload: "dup" });
        const events = await webhooks.listEvents(mine.id);
        assert.equal(events.length, 50);
        assert.deepEqual(events[0], { deliveryId: "d54", receivedAt: 1054, payload: "x".repeat(16_100) });
        assert.equal(events.at(-1)?.deliveryId, "d5");
      });
      await withTenant(otherTenant, async () => {
        assert.equal(await webhooks.get(mine.id), null);
        assert.deepEqual(await webhooks.list(), []);
        assert.deepEqual(await webhooks.listEvents(mine.id), []);
        assert.equal(await webhooks.update(mine.id, { action: "stolen" }), null);
        const twin = await webhooks.create(hook());
        assert.notEqual(twin.id, mine.id);
      });
      assert.equal((await withTenant(tenant, () => webhooks.get(mine.id)))?.action, "triage the event");
      await assert.rejects(
        withoutTenant(() => webhooks.list()),
        /No tenant is bound/,
      );
    },
  );
});

test(
  "webhook history keeps the newest events under concurrent deliveries from several instances",
  { skip },
  async () => {
    await withTypedTableDb(
      (url) => createPostgresWebhookRows(url),
      async ({ store: rows, url, tenant }) => {
        const other = createPostgresWebhookRows(url);
        try {
          const [a, b] = [createWebhookStore(rows), createWebhookStore(other)];
          await withTenant(tenant, async () => {
            const webhook = await a.create(hook("summarize"));
            await Promise.all(
              Array.from({ length: 60 }, (_, i) =>
                (i % 2 ? a : b).recordEvent(webhook.id, {
                  deliveryId: `event-${i}`,
                  receivedAt: i,
                  payload: "hello 🌊",
                }),
              ),
            );
            await b.recordEvent(webhook.id, { deliveryId: "event-59", receivedAt: 59, payload: "hello 🌊" });
            const events = await a.listEvents(webhook.id);
            assert.equal(events.length, 50);
            assert.equal(events[0]?.receivedAt, 59);
            assert.equal(events[0]?.payload, "hello 🌊");
            assert.equal(events.at(-1)?.receivedAt, 10);
            assert.equal(new Set(events.map((e) => e.deliveryId)).size, 50);
          });
        } finally {
          await other.close();
        }
      },
    );
  },
);

test("the webhook conversion backfills hooks and their event history", { skip }, async () => {
  const legacy = {
    id: "w1",
    ...base,
    enabled: true,
    createdAt: 1_700_000_000_000,
    action: "triage",
    verification: { scheme: "stripe", secret: "whsec" },
    lastDeliveryId: "evt_2",
  };
  await withTypedTableDb(
    (url) => createPostgresWebhookRows(url),
    async ({ store: rows, admin, tenant }) => {
      await withTenant(tenant, async () => {
        assert.deepEqual(await rows.get("w1"), legacy);
        assert.deepEqual(await rows.listEvents("w1"), [
          { deliveryId: "evt_2", receivedAt: 20, payload: "{}" },
          { deliveryId: "evt_1", receivedAt: 10, payload: '{"a":1}' },
        ]);
      });
      const { rows: meta } = await admin.query(
        `SELECT to_regclass('webhooks_kv') IS NULL AND to_regclass('webhook_history') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl IN ('webhooks', 'webhook_history')) AS versions,
                (SELECT array_agg(DISTINCT tenant_id::text) FROM webhook_events) AS tenants`,
      );
      assert.deepEqual(meta, [{ dropped: true, versions: 0, tenants: [tenant] }]);
    },
    async (admin) => {
      await seedKeyValueTable(admin, "webhooks", { w1: legacy });
      await seedKeyValueTable(admin, "webhook_history", {
        w1: {
          events: [
            { deliveryId: "evt_2", receivedAt: 20, payload: "{}" },
            { deliveryId: "evt_1", receivedAt: 10, payload: '{"a":1}' },
          ],
        },
      });
    },
  );
});
