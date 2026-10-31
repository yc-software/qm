import assert from "node:assert/strict";
import test from "node:test";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createPostgresLoopRows } from "../src/loops/loop-table.ts";
import { createLoopItemLedger, loopItemId } from "../src/loops/item-ledger.ts";
import { createPostgresItemRows } from "../src/loops/item-table.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createPostgresOutputRows } from "../src/loops/output-table.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createPostgresShipGrantRows } from "../src/loops/ship-grant-table.ts";
import { createPostgresIngressDeliveryRows, createPostgresIngressSourceRows } from "../src/loops/ingress-table.ts";
import type { IngressDelivery, LoopIngress } from "../src/loops/ingress.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { PG_URL, seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const ALICE = "alice@example.com";

function ownerUrl(appUrl: string): string {
  const owner = new URL(appUrl);
  const base = new URL(PG_URL!);
  owner.username = base.username;
  owner.password = base.password;
  return owner.toString();
}

function loopTables(url: string) {
  const rows = {
    loops: createPostgresLoopRows(url),
    items: createPostgresItemRows(url),
    outputs: createPostgresOutputRows(url),
    grants: createPostgresShipGrantRows(url),
    sources: createPostgresIngressSourceRows(url),
    deliveries: createPostgresIngressDeliveryRows(url),
  };
  return {
    ...rows,
    loopStore: createLoopStore(rows.loops),
    ledger: createLoopItemLedger(rows.items),
    outputStore: createLoopOutputStore(rows.outputs),
    grantStore: createShipGrantStore(rows.grants),
    async close() {
      for (const table of Object.values(rows)) await table.close?.();
    },
  };
}

const loopInput = (overrides: Partial<Parameters<ReturnType<typeof createLoopStore>["create"]>[0]> = {}) => ({
  owner: ALICE,
  createdBy: ALICE,
  ownerScopeId: scopeId("personal", ALICE),
  name: "Inbox",
  playbook: "Draft replies",
  successCondition: "Every message has a draft",
  ...overrides,
});

const entry = (loopId: string, dedupeKey: string, extra: Record<string, unknown> = {}) => ({
  loopId,
  dedupeKey,
  source: "gmail",
  summary: `Thread ${dedupeKey}`,
  sourceAt: 1_000,
  sourcePayload: { title: "Hello", snippet: "Hi\u0000 there", automated: true, privateDetail: "x", ...extra },
});

test("loops round-trip through typed columns and the indexed lookups", { skip }, async () => {
  await withTypedTableDb(loopTables, async ({ store, tenant }) => {
    const loops = store.loopStore;
    await withTenant(tenant, async () => {
      const { loop, created } = await loops.create(
        loopInput({
          surface: "inbox:gmail",
          sources: ["gmail"],
          shipActions: [{ action: "send", gate: "hold" }],
          governor: { staleFireMs: 1_000 },
          cronId: "cron-1",
        }),
      );
      assert.equal(created, true);
      assert.deepEqual(await loops.get(loop.id), loop);
      assert.deepEqual(
        await loops.create(
          loopInput({
            surface: "inbox:gmail",
            sources: ["gmail"],
            shipActions: [{ action: "send", gate: "hold" }],
            governor: { staleFireMs: 1_000 },
            cronId: "cron-1",
          }),
        ),
        { loop, created: false },
      );
      const other = (await loops.create(loopInput({ name: "Other", ownerScopeId: scopeId("channel", "C1") }))).loop;
      assert.deepEqual((await loops.byOwner(ALICE, "inbox:gmail"))?.id, loop.id);
      assert.equal(await loops.byOwner(ALICE, "inbox:slack"), null);
      assert.deepEqual((await loops.byScope(scopeId("personal", ALICE), "inbox:gmail"))?.id, loop.id);
      assert.deepEqual((await loops.byCron("cron-1"))?.id, loop.id);
      assert.deepEqual((await loops.list()).map((l) => l.id).sort(), [loop.id, other.id].sort());
      const edited = await loops.update(loop.id, {
        playbookEdit: { playbook: "Draft better", by: ALICE },
        triage: { prioritize: { enabled: true } },
      });
      assert.equal(edited?.playbookVersion, 2);
      assert.equal(edited?.policyVersion, 2);
      assert.deepEqual(await loops.get(loop.id), edited);
      const unhealthy = await loops.setHealth(loop.id, "degraded", "slow", true);
      assert.equal(unhealthy?.healthReason, "slow");
      const healthy = await loops.setHealth(loop.id, "healthy");
      assert.equal("healthReason" in healthy!, false);
      assert.equal("throttle" in (await loops.get(loop.id))!, false);
      await loops.delete(other.id);
      assert.equal(await loops.get(other.id), null);
    });
  });
});

test(
  "a tenant cannot see or change another tenant's loop rows, and unbound access fails closed",
  { skip },
  async () => {
    await withTypedTableDb(loopTables, async ({ store, tenant, otherTenant }) => {
      const { loop } = await withTenant(tenant, () => store.loopStore.create(loopInput({ surface: "inbox" })));
      await withTenant(tenant, async () => {
        await store.ledger.ingest([entry(loop.id, "t1")]);
        const item = (await store.ledger.byLoop(loop.id))[0]!;
        await store.outputStore.capture({
          loopId: loop.id,
          itemId: item.id,
          attemptId: "a1",
          shipAction: "send",
          title: "Reply",
          capturedBy: "agent",
        });
        await store.grantStore.put({
          id: "g1",
          loopId: loop.id,
          shipAction: "send",
          actorId: ALICE,
          policyVersion: 1,
          createdAt: 1,
        });
        await store.sources.insert({
          id: "s1",
          loopId: loop.id,
          owner: ALICE,
          kind: "webhook",
          enabled: true,
          createdAt: 1,
        });
      });
      await withTenant(otherTenant, async () => {
        assert.equal(await store.loopStore.get(loop.id), null);
        assert.deepEqual(await store.loopStore.list(), []);
        assert.equal(await store.loopStore.byScope(loop.ownerScopeId, "inbox"), null);
        assert.equal(await store.loopStore.update(loop.id, { name: "stolen" }), null);
        await store.loopStore.delete(loop.id);
        assert.deepEqual(await store.ledger.byLoop(loop.id), []);
        assert.deepEqual(await store.ledger.summaries([loop.id]), []);
        assert.deepEqual(await store.outputStore.byLoop(loop.id), []);
        assert.deepEqual(await store.grantStore.byLoop(loop.id), []);
        assert.equal(await store.sources.get("s1"), null);
        await store.ledger.deleteByLoop(loop.id);
        await store.outputStore.deleteByLoop(loop.id);
        await store.grantStore.deleteByLoop(loop.id);
        const twin = await store.loopStore.create(loopInput({ surface: "inbox" }));
        assert.equal(twin.created, true);
        assert.notEqual(twin.loop.id, loop.id);
      });
      await withTenant(tenant, async () => {
        assert.equal((await store.loopStore.get(loop.id))?.name, "Inbox");
        assert.equal((await store.ledger.byLoop(loop.id)).length, 1);
        assert.equal((await store.outputStore.byLoop(loop.id)).length, 1);
        assert.equal((await store.grantStore.byLoop(loop.id)).length, 1);
        assert.ok(await store.sources.get("s1"));
      });
      await assert.rejects(store.loopStore.get(loop.id), /No tenant is bound/);
      await assert.rejects(store.ledger.byLoop(loop.id), /No tenant is bound/);
      await assert.rejects(store.loopStore.create(loopInput({ name: "Unbound" })), /No tenant is bound/);
    });
  },
);

test(
  "ledger queries run per loop: ids by source key, projected summaries, queue, stats and prune",
  { skip },
  async () => {
    await withTypedTableDb(loopTables, async ({ store, tenant }) => {
      await withTenant(tenant, async () => {
        const ledger = store.ledger;
        const outcome = await ledger.ingest([
          entry("L1", "t1"),
          entry("L1", "t2"),
          entry("L2", "t1"),
          entry("L1", "t1"),
        ]);
        assert.deepEqual(outcome, { created: 3, updated: 0, skipped: 1 });
        const first = (await ledger.get(loopItemId("L1", "t1")))!;
        assert.equal(first.sourcePayload?.snippet, "Hi there");
        assert.equal(first.inboxPreview?.title, "Hello");
        assert.deepEqual(first.runIds, []);
        await store.items.delete([first.id]);
        await store.items.insertIfAbsent({ ...first, id: "older-id" });
        assert.deepEqual(
          await store.items.idsBySourceKey("L1", ["t1", "t2", "missing"]),
          [
            { id: loopItemId("L1", "t2"), sourceKey: "t2" },
            { id: "older-id", sourceKey: "t1" },
          ].sort((a, b) => (a.id < b.id ? -1 : 1)),
        );
        await ledger.ingest([entry("L1", "t1", { snippet: "newer" }), { ...entry("L1", "t1"), sourceAt: 2_000.25 }]);
        assert.equal(await ledger.get(loopItemId("L1", "t1")), null);
        assert.equal((await ledger.get("older-id"))?.sourceAt, 2_000.25);
        const plain = await ledger.summaries(["L1"]);
        assert.equal(plain.length, 2);
        for (const row of plain)
          for (const key of ["sourcePayload", "proposal", "thread", "agentDrafts"]) assert.ok(!(key in row));
        const flagged = await ledger.summaries(["L1", "L2"], { includeInboxMetadata: true });
        assert.equal(flagged.length, 3);
        for (const row of flagged) {
          assert.equal(row.inboxPreview?.automated, true);
          assert.equal(row.inboxPreview?.privateDetail, undefined);
          assert.ok(!("sourcePayload" in row));
        }
        const queued = await ledger.queued("L1");
        assert.deepEqual(
          queued.map((item) => item.loopId),
          ["L1", "L1"],
        );
        assert.equal((await ledger.queued("L1", 1)).length, 1);
        const claimed = await ledger.claim("older-id");
        assert.equal(claimed?.status, "in_progress");
        assert.equal((await ledger.queued("L1")).length, 1);
        assert.equal(
          (await ledger.queued("L1")).some((item) => item.id === "older-id"),
          false,
        );
        const stats = await ledger.stats("L1", Date.now(), new Set());
        assert.equal(stats.queued, 1);
        assert.equal(stats.inProgress, 1);
        await ledger.recordAction(loopItemId("L1", "t2"), { kind: "send", outcome: "actioned" });
        assert.equal(await ledger.prune("L1", { maxItems: 10, retentionMs: 0 }), 1);
        assert.deepEqual(
          (await ledger.byLoop("L1")).map((item) => item.id),
          ["older-id"],
        );
        await ledger.deleteByLoop("L1");
        assert.deepEqual(await ledger.byLoop("L1"), []);
        assert.equal((await ledger.byLoop("L2")).length, 1);
      });
    });
  },
);

test("outputs and ship grants keep their state machines on typed rows", { skip }, async () => {
  await withTypedTableDb(loopTables, async ({ store, tenant }) => {
    await withTenant(tenant, async () => {
      const outputs = store.outputStore;
      const capture = (attemptId: string) =>
        outputs.capture({
          loopId: "L1",
          itemId: "I1",
          attemptId,
          shipAction: "send",
          title: "Reply",
          capturedBy: "agent",
        });
      const first = await capture("a1");
      assert.deepEqual(await capture("a1"), first);
      assert.deepEqual(
        (await outputs.promoteAttempt("I1", "a1")).map((o) => o.state),
        ["ready"],
      );
      const second = await capture("a2");
      assert.deepEqual(second.supersedesOutputIds, [first.id]);
      assert.deepEqual((await outputs.get(first.id))?.supersededByOutputIds, [second.id]);
      assert.deepEqual(
        (await outputs.awaitingReview("L1")).map((o) => o.id),
        [first.id],
      );
      const claim = await outputs.claimShipping(first.id);
      assert.ok(claim?.claimToken);
      assert.equal(await outputs.claimShipping(first.id), null);
      const shipped = await outputs.completeShipping(first.id, claim.claimToken, { actorId: ALICE }, { status: "ok" });
      assert.equal(shipped?.state, "shipped");
      assert.equal("claimToken" in shipped!, false);
      assert.deepEqual((await outputs.get(first.id))?.shipResult, { status: "ok" });
      await outputs.promoteAttempt("I1", "a2");
      assert.deepEqual(
        (await outputs.expireOlderThan("L1", Date.now() + 1)).map((o) => o.id),
        [second.id],
      );
      await outputs.rebindItem("I1", "L1", "L2");
      assert.deepEqual((await outputs.byLoop("L2")).length, 2);
      assert.deepEqual((await outputs.byItem("I1")).length, 2);

      const grants = store.grantStore;
      const grant = { id: "g1", loopId: "L2", shipAction: "send", actorId: ALICE, policyVersion: 1, createdAt: 1 };
      assert.deepEqual(await grants.put(grant), grant);
      assert.equal((await grants.revoke("g1", "bob"))?.revokedBy, "bob");
      const renewed = await grants.put({ ...grant, actorId: "carol", createdAt: 2 });
      assert.equal(renewed.actorId, "carol");
      assert.equal("revokedAt" in renewed, false);
      assert.equal(renewed.revocationHistory?.[0]?.revokedBy, "bob");
      assert.deepEqual(await grants.byLoop("L2"), [renewed]);
      await outputs.deleteByLoop("L2");
      await grants.deleteByLoop("L2");
      assert.deepEqual(await outputs.byItem("I1"), []);
      assert.equal(await grants.get("g1"), null);
    });
  });
});

const source = (id: string, overrides: Partial<LoopIngress> = {}): LoopIngress => ({
  id,
  loopId: "L1",
  owner: ALICE,
  kind: "webhook",
  enabled: true,
  createdAt: 1,
  ...overrides,
});

const delivery = (id: string, overrides: Partial<IngressDelivery> = {}): IngressDelivery => ({
  id,
  ingressId: "s1",
  queueKey: "s1",
  receivedAt: 1,
  attempts: 0,
  nextAttemptAt: 0,
  ...overrides,
});

test("ingress sources and deliveries queue per tenant and background claims span tenants", { skip }, async () => {
  await withTypedTableDb(loopTables, async ({ store, url, tenant, otherTenant }) => {
    const owner = loopTables(ownerUrl(url));
    try {
      const gmail = { email: "a@example.com", historyId: "1", expiresAt: 1 };
      await withTenant(tenant, async () => {
        await store.sources.insert(source("s1", { secret: "shh", channels: ["C1"] }));
        await store.sources.insert(source("s2", { kind: "gmail", gmail }));
        await store.sources.insert(source("s3", { enabled: false }));
        assert.deepEqual(
          (await store.sources.byLoop("L1")).map((s) => s.id),
          ["s1", "s2", "s3"],
        );
        const merged = await store.sources.update("s1", (s) => ({ ...s, lastError: undefined, nextWorkAt: 5 }));
        assert.equal(merged?.nextWorkAt, 5);
        assert.deepEqual((await store.sources.get("s1"))?.channels, ["C1"]);
        await store.deliveries.insertIfAbsent(delivery("d2", { receivedAt: 2, entries: [] }));
        await store.deliveries.insertIfAbsent(delivery("d1"));
        await store.deliveries.insertIfAbsent(delivery("d3", { nextAttemptAt: 10_000 }));
        await store.deliveries.insertIfAbsent(delivery("d1", { receivedAt: 99 }));
        assert.deepEqual(
          (await store.deliveries.pending("s1", 100, 20)).map((d) => d.id),
          ["d1", "d2"],
        );
        assert.deepEqual(
          (await store.deliveries.pending("s1", 100, 1)).map((d) => d.id),
          ["d1"],
        );
        await store.deliveries.update("d1", (d) => ({ ...d, completedAt: 50, queueKey: undefined, ingested: true }));
        assert.deepEqual(
          (await store.deliveries.pending("s1", 100, 20)).map((d) => d.id),
          ["d2"],
        );
        await store.loopStore.create(loopInput({ surface: "inbox:gmail", governor: { staleFireMs: 1 } }));
        await store.loopStore
          .create(loopInput({ name: "Archived", surface: "inbox" }))
          .then(({ loop }) => store.loopStore.setState(loop.id, "archived"));
      });
      await withTenant(otherTenant, async () => {
        await store.sources.insert(source("s9", { kind: "gmail", gmail }));
        await store.deliveries.insertIfAbsent(delivery("d9", { completedAt: 10 }));
        await store.loopStore.create(loopInput({ name: "Other inbox", surface: "inbox" }));
        assert.deepEqual(await store.deliveries.pending("s1", 100, 20), []);
      });
      assert.deepEqual(
        (await owner.sources.enabled()).map((s) => [s.tenantId, s.id]),
        [
          [tenant, "s1"],
          [tenant, "s2"],
          [otherTenant, "s9"],
        ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
      );
      assert.deepEqual(
        new Set((await owner.sources.gmailWatching("a@example.com")).map((s) => `${s.tenantId}/${s.id}`)),
        new Set([`${tenant}/s2`, `${otherTenant}/s9`]),
      );
      assert.equal(await owner.deliveries.pruneCompleted(60), 2);
      const inbox = await owner.loopStore.inboxLoops();
      assert.deepEqual(
        new Set(inbox.map((l) => `${l.tenantId}/${l.name}`)),
        new Set([`${tenant}/Inbox`, `${otherTenant}/Other inbox`]),
      );
      const stale = await owner.loopStore.staleGoverned(Date.now() + 10);
      assert.deepEqual(
        stale.map((l) => [l.tenantId, l.name]),
        [[tenant, "Inbox"]],
      );
      await assert.rejects(store.sources.enabled(), /No tenant is bound/);
      await assert.rejects(store.loopStore.inboxLoops(), /No tenant is bound/);
    } finally {
      await owner.close();
    }
  });
});

const LEGACY = {
  loops: {
    "loop-1": {
      id: "loop-1",
      ownerScopeId: "personal:alice@example.com",
      owner: ALICE,
      createdBy: ALICE,
      enabled: true,
      createdAt: 1_700_000_000_000,
      name: "Inbox",
      surface: "inbox",
      sources: ["gmail", "slack"],
      playbook: "Draft",
      playbookVersion: 2,
      playbookHistory: [{ version: 1, at: 1, by: ALICE }],
      successCondition: "Drafted",
      shipActions: [{ action: "send", gate: "hold" }],
      state: "enabled",
      health: "healthy",
      cronId: "cron-1",
      governor: { staleFireMs: 60_000 },
    },
    broken: { name: "no owner" },
  },
  loop_items: {
    "item-1": {
      id: "item-1",
      loopId: "loop-1",
      sourceKey: "t1",
      source: "gmail",
      sourcePayload: { title: "Hello", nested: { deep: [1, 2] } },
      proposal: { data: { body: "Hi" }, by: "agent", at: 5 },
      thread: [{ id: "m1", role: "human", text: "hey", at: 6 }],
      status: "ready",
      attempts: 1,
      runIds: ["r1"],
      outputIds: ["o1"],
      createdAt: 1,
      updatedAt: 7,
    },
  },
  loop_outputs: {
    o1: {
      id: "o1",
      loopId: "loop-1",
      itemId: "item-1",
      attemptId: "a1",
      shipAction: "send",
      title: "Reply",
      state: "ready",
      capturedBy: "agent",
      createdAt: 3,
      updatedAt: 4,
      supersedesOutputIds: ["o0"],
    },
  },
  loop_ship_grants: {
    g1: {
      id: "g1",
      loopId: "loop-1",
      shipAction: "send",
      actorId: ALICE,
      policyVersion: 1,
      createdAt: 2,
      revocationHistory: [{ revokedAt: 1, revokedBy: "bob" }],
    },
  },
  loop_ingress: {
    s1: {
      id: "s1",
      loopId: "loop-1",
      owner: ALICE,
      kind: "gmail",
      enabled: true,
      gmail: { email: "a@example.com", historyId: "9", expiresAt: 10 },
      createdAt: 1,
      nextWorkAt: 4,
    },
  },
  loop_ingress_deliveries: {
    d1: { id: "d1", ingressId: "s1", queueKey: "s1", receivedAt: 1, historyId: "9", attempts: 2, nextAttemptAt: 3 },
  },
} as const;

test(
  "the conversions backfill every loop table into the instance tenant and drop the old tables",
  { skip },
  async () => {
    await withTypedTableDb(
      loopTables,
      async ({ store, admin, tenant }) => {
        await withTenant(tenant, async () => {
          const { broken: _broken, ...loops } = LEGACY.loops;
          assert.deepEqual(await store.loopStore.get("loop-1"), { ...loops["loop-1"], policyVersion: 1 });
          assert.deepEqual(await store.ledger.get("item-1"), LEGACY.loop_items["item-1"]);
          assert.deepEqual(await store.outputStore.get("o1"), LEGACY.loop_outputs.o1);
          assert.deepEqual(await store.grantStore.get("g1"), LEGACY.loop_ship_grants.g1);
          assert.deepEqual(await store.sources.get("s1"), LEGACY.loop_ingress.s1);
          assert.deepEqual(await store.deliveries.pending("s1", 10, 5), [LEGACY.loop_ingress_deliveries.d1]);
        });
        for (const table of Object.keys(LEGACY)) {
          const { rows } = await admin.query(
            `SELECT count(*)::int AS n, bool_and(tenant_id::text = $1) AS stamped,
                  to_regclass('${table}_kv') IS NULL AS dropped,
                  (SELECT count(*)::int FROM durable_map_versions WHERE tbl = $2) AS versions
             FROM ${table}`,
            [tenant, table],
          );
          assert.deepEqual(rows, [{ n: 1, stamped: true, dropped: true, versions: 0 }], table);
        }
      },
      async (admin) => {
        for (const [table, rows] of Object.entries(LEGACY)) await seedKeyValueTable(admin, table, rows);
      },
    );
  },
);
