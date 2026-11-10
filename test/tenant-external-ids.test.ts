import assert from "node:assert/strict";
import { after, before, describe, it } from "./support/unbound-test.ts";
import { composioUserId, composioUserIds } from "../src/api/routes/composio.ts";
import { orgId } from "../src/config.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { withTenant } from "../src/tenants/context.ts";
import { externalOrgId } from "../src/tenants/external-org.ts";
import { loadTenantSettings } from "../src/tenants/settings.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

const PERSON = "U123";

describe("external ids for tenants on a shared host", () => {
  let db: TwoTenants;
  const inTenant = <T>(tenant: string, fn: () => T | Promise<T>): Promise<T> =>
    withTenant(tenant, async () => {
      await loadTenantSettings(db.app);
      return fn();
    });

  before(async () => {
    db = await twoTenants();
    await bindBootTenant(async () => undefined);
    await db.owner.q(`UPDATE tenants SET settings = '{"orgSlug":"moved-co"}' WHERE id = $1`, [db.tenants[0]]);
  });

  after(() => db?.close());

  it("refuses to name a tenant's external identity before its settings load", async () => {
    const [, b] = db.tenants;
    await withTenant(b, () => assert.throws(() => externalOrgId(), /not loaded/));
    assert.throws(() => externalOrgId(), /no tenant is bound/);
  });

  it("keeps a moved company's Composio identity from before the move", async () => {
    const [a] = db.tenants;
    assert.equal(await inTenant(a, externalOrgId), "moved-co");
    assert.ok((await inTenant(a, () => composioUserIds(PERSON))).includes(composioUserId("moved-co", PERSON)));
  });

  it("gives each tenant its own Composio identity for the same person, never the host's", async () => {
    const [a, b] = db.tenants;
    assert.equal(await inTenant(b, externalOrgId), b);
    const idsA = await inTenant(a, () => composioUserIds(PERSON));
    const idsB = await inTenant(b, () => composioUserIds(PERSON));
    assert.equal(
      idsA.some((id) => idsB.includes(id)),
      false,
    );
    assert.equal(idsB.includes(composioUserId(orgId(), PERSON)), false);
  });
});
