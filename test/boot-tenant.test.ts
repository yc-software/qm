import { after, before, test } from "./support/unbound-test.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, createPgPool, definePgMigration } from "../src/persistence/pg-pool.ts";
import { BOOT_TENANT_TTL_MS, bootTenantReader } from "../src/tenants/boot.ts";
import { boundTenant, withoutTenant } from "../src/tenants/context.ts";
import { TENANCY } from "../src/tenants/migrations.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl } from "./support/test-tenant.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the boot tenant tests";
const role = `boot_probe_${randomUUID().slice(0, 8)}`;
let url = "";
let owner: pg.Pool;

function asRole(databaseUrl: string): string {
  const roleUrl = new URL(databaseUrl);
  roleUrl.searchParams.set("options", `-c role=${role}`);
  return roleUrl.toString();
}

before(async () => {
  if (skip) return;
  url = ownerUrl(testDatabaseUrl()).toString();
  owner = new pg.Pool({ connectionString: url, max: 1 });
  await applyPgMigrations(owner, TENANCY.map(definePgMigration));
  await owner.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT SELECT ON tenants TO ${role}`);
  await owner.query("DELETE FROM tenants");
});

after(async () => {
  await owner?.query(`DROP OWNED BY ${role}`);
  await owner?.query(`DROP ROLE IF EXISTS ${role}`);
  await owner?.end();
});

test("an unbound non-owner reads the boot tenant only when exactly one tenant exists", { skip }, (t) =>
  withoutTenant(async () => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const app = createPgPool(asRole(url));
    try {
      assert.equal(boundTenant(), undefined);
      const [me] = await app.q("SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
      assert.equal(me?.bypass, false);
      await assert.rejects(app.q("SELECT id FROM tenants"), { code: "42501", message: /No tenant is bound/ });
      const read = bootTenantReader(app);
      assert.equal(await read(), undefined);
      const only = randomUUID();
      await owner.query("INSERT INTO tenants(id) VALUES ($1)", [only]);
      assert.equal(await read(), undefined);
      t.mock.timers.tick(BOOT_TENANT_TTL_MS);
      assert.equal(await read(), only);
      assert.equal(await bootTenantReader(app)(), only);
      await owner.query("INSERT INTO tenants(id) VALUES ($1)", [randomUUID()]);
      assert.equal(await bootTenantReader(app)(), undefined);
    } finally {
      await app.close();
    }
  }),
);
