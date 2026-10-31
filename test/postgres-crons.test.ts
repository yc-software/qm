import assert from "node:assert/strict";
import test from "node:test";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createPostgresCronRows } from "../src/cron/cron-table.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import type { Cron } from "../src/triggers/types.ts";
import { PG_URL, seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";
import { testCronFires } from "./support/typed-stores.ts";

const skip = skipWithoutPg;

function ownerUrl(appUrl: string): string {
  const owner = new URL(appUrl);
  const base = new URL(PG_URL!);
  owner.username = base.username;
  owner.password = base.password;
  return owner.toString();
}
const ALICE = "alice@example.com";
const HOUR = 60 * 60_000;

const input = (overrides: Partial<Parameters<ReturnType<typeof createCronStore>["create"]>[0]> = {}) => ({
  owner: ALICE,
  createdBy: ALICE,
  ownerScopeId: scopeId("personal", ALICE),
  schedule: { everyMs: HOUR },
  action: "summarize the inbox",
  ...overrides,
});

const LEGACY_CRON = {
  id: "legacy-1",
  ownerScopeId: "channel:C1",
  owner: ALICE,
  createdBy: ALICE,
  enabled: true,
  archived: false,
  createdAt: 1_700_000_000_000,
  lastFiredAt: 1_700_000_360_000,
  nextFireAt: 1_700_000_720_000,
  schedule: { cron: "0 9 * * 1", timezone: "America/New_York" },
  runtime: null,
  title: "Weekly digest",
  action: "post the digest",
  destination: { type: "slack", target: "C1", threadTs: "1.2" },
  unattendedGrants: ["admin.audit.read"],
  sessionRef: "web:abc",
  lastFireNote: { text: "posted", at: 1_700_000_360_500, by: ALICE },
  fireLog: [],
};

test("cron rows round-trip through typed columns and the indexed lookups", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresCronRows(url),
    async ({ store: rows, tenant }) => {
      const crons = createCronStore(rows, { fires: testCronFires() });
      await withTenant(tenant, async () => {
        const created = await crons.create(
          input({ destination: { type: "slack", target: "C9" }, unattendedGrants: ["x"], sessionRef: "web:s1" }),
        );
        assert.deepEqual(await crons.get(created.id), created);
        assert.deepEqual(
          await crons.create(
            input({ destination: { type: "slack", target: "C9" }, unattendedGrants: ["x"], sessionRef: "web:s1" }),
          ),
          created,
        );
        const other = await crons.create(input({ ownerScopeId: scopeId("channel", "C2"), action: "other" }));
        assert.deepEqual(
          (await crons.ownedBy(scopeId("channel", "C2"))).map((c) => c.id),
          [other.id],
        );
        assert.deepEqual(
          (await crons.tiedTo(["web:s1"])).map((c) => c.id),
          [created.id],
        );
        assert.deepEqual(
          (await crons.tiedTo(["C9", "web:none"])).map((c) => c.id),
          [created.id],
        );
        const updated = await crons.update(created.id, { title: "  Renamed   cron ", runtime: null, sessionRef: null });
        assert.equal(updated?.title, "Renamed cron");
        assert.equal("sessionRef" in (updated ?? {}), false);
        assert.deepEqual(await crons.get(created.id), updated);
        await crons.update(other.id, { archived: true });

        await crons.defer(created.id, 5_000.6);
        assert.equal((await crons.get(created.id))?.deferUntil, 5_001);
        await crons.delete(other.id);
        assert.equal(await crons.get(other.id), null);
        const upper = scopeId("personal", "OwnerU");
        await crons.create(input({ owner: "OwnerU", createdBy: "OwnerU", ownerScopeId: upper }));
        await crons.create(
          input({ owner: "owneru", createdBy: "owneru", ownerScopeId: scopeId("personal", "owneru") }),
        );
        assert.deepEqual(
          (await crons.ownedBy(upper)).map((c) => c.ownerScopeId),
          [upper],
        );
      });
    },
  );
});

test("due crons are claimed across tenants and each slot is claimed once", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresCronRows(url),
    async ({ store: rows, url, tenant, otherTenant }) => {
      const crons = createCronStore(rows, { fires: testCronFires() });
      const ownerRows = createPostgresCronRows(ownerUrl(url));
      const claims = createCronStore(ownerRows, { fires: testCronFires() });
      const first = Date.now() - HOUR;
      const a = await withTenant(tenant, () =>
        crons.create(input({ schedule: { everyMs: HOUR, firstFireAt: first } })),
      );
      const b = await withTenant(otherTenant, () =>
        crons.create(input({ action: "deferred", schedule: { everyMs: HOUR, firstFireAt: first } })),
      );
      await withTenant(otherTenant, () => crons.defer(b.id, Date.now() + HOUR));
      const later = await withTenant(tenant, () =>
        crons.create(input({ action: "later", schedule: { everyMs: HOUR, firstFireAt: Date.now() + HOUR } })),
      );
      assert.deepEqual(
        new Set((await claims.scheduled()).map((c) => `${c.tenantId}/${c.id}`)),
        new Set([`${tenant}/${a.id}`, `${otherTenant}/${b.id}`, `${tenant}/${later.id}`]),
      );
      const due = await claims.due(Date.now());
      assert.deepEqual(
        due.map((c) => [c.id, c.tenantId]),
        [[a.id, tenant]],
      );
      assert.equal(
        due.some((c) => c.id === later.id),
        false,
      );
      const slot = due[0]!.scheduledAt;
      const now = Date.now();
      assert.equal(await withTenant(tenant, () => crons.claimSlot(a.id, slot, now)), true);
      assert.equal(await withTenant(tenant, () => crons.claimSlot(a.id, slot, now)), false);
      assert.equal(await withTenant(otherTenant, () => crons.claimSlot(a.id, slot, now)), false);
      assert.deepEqual(await claims.due(Date.now()), []);
      await withTenant(tenant, () => crons.unclaimSlot(a.id, slot, now, undefined));
      assert.deepEqual(
        (await claims.due(Date.now())).map((c) => c.id),
        [a.id],
      );
      await assert.rejects(crons.due(Date.now()), /No tenant is bound/);
      await ownerRows.close();
    },
  );
});

test(
  "a tenant cannot read, change or delete another tenant's cron, and unbound access fails closed",
  { skip },
  async () => {
    await withTypedTableDb(
      (url) => createPostgresCronRows(url),
      async ({ store: rows, tenant, otherTenant }) => {
        const crons = createCronStore(rows, { fires: testCronFires() });
        const mine = await withTenant(tenant, () => crons.create(input()));
        await withTenant(otherTenant, async () => {
          assert.equal(await crons.get(mine.id), null);
          assert.deepEqual(await crons.list(), []);
          assert.deepEqual(await crons.ownedBy(mine.ownerScopeId), []);
          assert.equal(await crons.update(mine.id, { title: "stolen" }), null);
          await crons.setEnabled(mine.id, false);
          await crons.delete(mine.id);
          const twin = await crons.create(input());
          assert.notEqual(twin.id, mine.id);
        });
        const kept = await withTenant(tenant, () => crons.get(mine.id));
        assert.equal(kept?.enabled, true);
        assert.equal(kept?.title, undefined);
        await assert.rejects(crons.get(mine.id), /No tenant is bound/);
        await assert.rejects(crons.create(input({ action: "unbound" })), /No tenant is bound/);
      },
    );
  },
);

test(
  "the conversion backfills key-value crons into the instance tenant and drops the old table",
  { skip },
  async () => {
    await withTypedTableDb(
      (url) => createPostgresCronRows(url),
      async ({ store: rows, admin, tenant }) => {
        const { fireLog: _fireLog, ...expected } = LEGACY_CRON;
        assert.deepEqual(await withTenant(tenant, () => rows.get("legacy-1")), expected as Cron);
        const { rows: meta } = await admin.query(
          `SELECT tenant_id::text AS tenant, to_regclass('crons_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'crons') AS versions
           FROM crons`,
        );
        assert.deepEqual(meta, [
          { tenant, dropped: true, versions: 0 },
          { tenant, dropped: true, versions: 0 },
        ]);
        assert.equal((await withTenant(tenant, () => rows.get("legacy-2")))?.enabled, false);
        assert.equal(await withTenant(tenant, () => rows.get("broken")), null);
      },
      (admin) => {
        const { enabled: _enabled, ...unflagged } = LEGACY_CRON;
        const { schedule: _schedule, ...broken } = LEGACY_CRON;
        return seedKeyValueTable(admin, "crons", {
          "legacy-1": LEGACY_CRON,
          "legacy-2": { ...unflagged, id: "legacy-2" },
          broken: { ...broken, id: "broken" },
        });
      },
    );
  },
);
