import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "./support/unbound-test.ts";
import { createPostgresAdminGrantStore } from "../src/admin/postgres-admin-grant-store.ts";
import { createPgPool, type PgPool } from "../src/persistence/pg-pool.ts";
import { ambientTenant, Tenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { appUrl, ownerUrl } from "./support/test-tenant.ts";

const tenantA = randomUUID();
const tenantB = randomUUID();
const tokenA = withTenant(tenantA, (tenant) => tenant);
const tokenB = withTenant(tenantB, (tenant) => tenant);
const BOUND =
  "SELECT current_setting('qm.tenant_id', true) AS bound, (SELECT array_agg(id::text) FROM tenants) AS visible";

describe("tenant tokens", () => {
  let owner: PgPool;
  let app: PgPool;
  let ownerDatabaseUrl = "";

  before(async () => {
    const databaseUrl = testMigratedDatabaseUrl();
    ownerDatabaseUrl = ownerUrl(databaseUrl).toString();
    owner = createPgPool(ownerDatabaseUrl);
    app = createPgPool(appUrl(databaseUrl));
    await owner.q("INSERT INTO tenants(id) VALUES ($1), ($2)", [tenantA, tenantB]);
  });

  after(async () => {
    await app?.close();
    await owner?.close();
  });

  it("withTenant hands its callback the token for the tenant it binds", () => {
    withTenant(tenantA, (tenant) => {
      assert.equal(tenant.id, tenantA);
      assert.equal(ambientTenant(), tenant);
    });
    withoutTenant(() => assert.throws(() => ambientTenant(), /No tenant is bound/));
  });

  it("only withTenant mints tokens", async () => {
    assert.throws(() => Reflect.construct(Tenant, [Symbol("tenant"), tenantA]), /minted only by withTenant/);
    const forged = { id: tenantA } as unknown as Tenant;
    await assert.rejects(() => app.forTenant(forged).q(BOUND), /minted only by withTenant/);
  });

  it("binds the explicit tenant when no tenant is bound to the work", async () => {
    const [row] = await withoutTenant(() => app.forTenant(tokenA).q(BOUND));
    assert.deepEqual(row, { bound: tenantA, visible: [tenantA] });
    const { rows, rowCount } = await app.forTenant(tokenB).query(BOUND, [], { timeoutMs: 5_000 });
    assert.deepEqual([rows, rowCount], [[{ bound: tenantB, visible: [tenantB] }], 1]);
  });

  it("accepts the token of the tenant the work is bound to", async () => {
    const [row] = await withTenant(tenantA, (tenant) => app.forTenant(tenant).q(BOUND));
    assert.deepEqual(row, { bound: tenantA, visible: [tenantA] });
    assert.deepEqual(await withTenant(tenantA, () => app.forTenant(tokenA).q(BOUND)), [row]);
  });

  it("refuses a token for a different tenant than the one bound to the work", async () => {
    await assert.rejects(
      () => withTenant(tenantB, () => app.forTenant(tokenA).q(BOUND)),
      new RegExp(`bound to tenant ${tenantB} used an explicit token for tenant ${tenantA}`),
    );
    await assert.rejects(() => withTenant(tenantB, () => app.forTenant(tokenA).query(BOUND)), /explicit token/);
  });

  it("admin grants stay in their tenant even for a login that bypasses row security", async () => {
    const grants = createPostgresAdminGrantStore(ownerDatabaseUrl);
    const grant = { principalId: "p", scopeId: scopeId("org", "o"), role: "org_admin" as const };
    await grants.put(tokenA, { ...grant, grantedBy: tenantA });
    await grants.put(tokenB, { ...grant, grantedBy: tenantB });
    assert.equal(await grants.insertIfAbsent(tokenB, { ...grant, principalId: "q" }), true);
    assert.deepEqual(
      (await grants.all(tokenA)).map((g) => [g.principalId, g.grantedBy]),
      [["p", tenantA]],
    );
    await grants.remove(tokenA, "q", grant.scopeId, grant.role);
    await grants.remove(tokenB, "p", grant.scopeId, grant.role);
    assert.deepEqual(
      (await grants.all(tokenA)).map((g) => g.principalId),
      ["p"],
    );
    assert.deepEqual(
      (await grants.all(tokenB)).map((g) => g.principalId),
      ["q"],
    );
  });
});
