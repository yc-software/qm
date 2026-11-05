import assert from "node:assert/strict";
import { after, before, describe, it } from "./support/unbound-test.ts";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { claimThenBind } from "../src/tenants/claim.ts";
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

    it("refuses to read rows when no tenant is bound", async () => {
      const map = createPostgresMap<{ tenant: string }>(db.app, "claim_probe");
      await assert.rejects(map.get("x"), /No tenant is bound/);
    });
  }),
);
