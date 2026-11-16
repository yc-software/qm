import assert from "node:assert/strict";
import { after, before, describe, it } from "./support/unbound-test.ts";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { claimThenBind, claimThenLoad } from "../src/tenants/claim.ts";
import { currentTenant, withTenant, withoutTenant } from "../src/tenants/context.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

withoutTenant(() =>
  describe("claim then bind", () => {
    let db: TwoTenants;

    before(async () => {
      db = await twoTenants();
      await createPostgresMap<{ n: number }>(db.owner, "claim_probe").claimIds();
    });

    after(() => db?.close());

    it("claims due ids across tenants and runs each row's work under its own tenant as the app login", async () => {
      const map = createPostgresMap<{ tenant: string }>(db.app, "claim_probe");
      const [a, b] = db.tenants;
      await withTenant(a, () => map.put("x", { tenant: a }));
      await withTenant(b, () => map.put("x", { tenant: b }));
      const seen = await claimThenBind(
        () => map.claimIds(),
        async (id) => ({ id, bound: currentTenant(), row: await map.get(id) }),
      );
      const mine = seen.filter((s) => s.bound === a || s.bound === b).sort((l, r) => l.bound.localeCompare(r.bound));
      assert.deepEqual(
        mine,
        [a, b].sort().map((t) => ({ id: "x", bound: t, row: { tenant: t } })),
      );
    });

    it("claims each tenant once and prunes old rows under that tenant", async () => {
      const map = createPostgresMap<{ at: number }>(db.app, "claim_probe_at");
      await createPostgresMap(db.owner, "claim_probe_at").claimIds();
      const [a, b] = db.tenants;
      for (const tenant of [a, b])
        await withTenant(tenant, async () => {
          await map.put("old", { at: 1 });
          await map.put("new", { at: 3 });
        });
      const tenants = await map.claimTenants();
      assert.deepEqual(tenants.map((t) => t.tenantId).sort(), [a, b].sort());
      await claimThenBind(map.claimTenants, () => map.deleteBefore("at", 2));
      for (const tenant of [a, b]) assert.deepEqual(await withTenant(tenant, () => map.all()), [{ at: 3 }]);
    });

    it("loads claimed rows with one read per tenant in claim order", async () => {
      const map = createPostgresMap<{ tenant: string }>(db.app, "claim_probe");
      const [a, b] = db.tenants;
      for (const tenant of [a, b]) await withTenant(tenant, () => map.put("y", { tenant }));
      const reads: string[][] = [];
      const claimed = [b, a, b].map((tenantId, i) => ({ tenantId, id: ["y", "y", "missing"][i]! }));
      const rows = await claimThenLoad(
        async () => claimed,
        async (ids) => {
          reads.push(ids);
          return (await Promise.all(ids.map(async (id) => ({ id, row: await map.get(id) })))).filter((r) => r.row);
        },
      );
      assert.deepEqual(reads, [["y", "missing"], ["y"]]);
      assert.deepEqual(
        rows.map((r) => [r.tenantId, r.row?.tenant]),
        [
          [b, b],
          [a, a],
        ],
      );
    });

    it("refuses to read rows when no tenant is bound", async () => {
      const map = createPostgresMap<{ tenant: string }>(db.app, "claim_probe");
      await assert.rejects(map.get("x"), /No tenant is bound/);
    });
  }),
);
