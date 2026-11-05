import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPostgresAdminGrantStore } from "../src/admin/postgres-admin-grant-store.ts";
import { orgId } from "../src/config.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { gatewayKey } from "../src/model/provider-endpoints.ts";
import { resolveBranding } from "../src/resolution/branding.ts";
import { loadTenant, onTenantLoad } from "../src/tenants/cache.ts";
import { withTenant } from "../src/tenants/context.ts";
import { runTenantCommand, TenantCommandError } from "../src/tenants/operator.ts";
import { loadTenantSettings, tenantAllowsEmail, tenantSettingsSchema } from "../src/tenants/settings.ts";
import { scopeId } from "../src/types.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

const ORG = scopeId("org", "test-org");

describe("tenant settings schema", () => {
  it("accepts the four keys and normalizes allowed emails", () => {
    assert.deepEqual(
      tenantSettingsSchema.parse({
        oidcClient: { clientId: "client" },
        allowedEmails: [" Ada@Example.com ", "@example.org"],
        brandName: "Acme",
        modelGatewayKey: "sk-tenant",
      }),
      {
        oidcClient: { clientId: "client" },
        allowedEmails: ["ada@example.com", "@example.org"],
        brandName: "Acme",
        modelGatewayKey: "sk-tenant",
      },
    );
    assert.deepEqual(tenantSettingsSchema.parse({}), {});
  });

  it("rejects unknown keys, malformed values and stray fields", () => {
    for (const bad of [
      { env: { SPRITES_TOKEN: "x" } },
      { allowedEmails: ["not an email"] },
      { allowedEmails: "ada@example.com" },
      { brandName: "" },
      { modelGatewayKey: 42 },
      { oidcClient: { clientId: "c", issuer: "https://idp.example.com" } },
      { oidcClient: { clientSecret: "s" } },
    ])
      assert.equal(tenantSettingsSchema.safeParse(bad).success, false, JSON.stringify(bad));
  });
});

describe("tenant settings and operator commands", () => {
  let db: TwoTenants;
  let stopLoad: () => void;
  const lines: string[] = [];
  const run = (...args: string[]) => runTenantCommand(db.owner, args, (line) => lines.push(line));

  before(async () => {
    db = await twoTenants();
    stopLoad = onTenantLoad(() => loadTenantSettings(db.app));
    await withTenant(db.tenants[0], async () => {
      await createPostgresDirectoryStore(db.ownerDatabaseUrl).list();
      await createPostgresAdminGrantStore(db.ownerDatabaseUrl).all();
    });
  });

  after(async () => {
    stopLoad?.();
    await db?.close();
  });

  it("reads each bound tenant's own brand name and gateway key under the app login", async () => {
    const [a, b] = db.tenants;
    await run("settings", "set", a, "brandName", '"Acme"');
    await run("settings", "set", b, "brandName", '"Beta"');
    await run("settings", "set", a, "modelGatewayKey", '"sk-a"');
    const read = (tenant: string) =>
      withTenant(tenant, async () => {
        await loadTenant();
        return {
          name: (await resolveBranding(undefined, ORG, { orgName: "Env Org" })).orgName,
          key: gatewayKey({ apiKey: "sk-deployment" }),
        };
      });
    assert.deepEqual(await read(a), { name: "Acme", key: "sk-a" });
    assert.deepEqual(await read(b), { name: "Beta", key: "sk-deployment" });
  });

  it("checks allowed emails per tenant and leaves tenants without a list to the deployment", async () => {
    lines.length = 0;
    await run("create");
    const fresh = lines[0]!;
    await run("settings", "set", fresh, "allowedEmails", '["ada@example.com", "@example.org"]');
    await withTenant(fresh, async () => {
      assert.equal(await tenantAllowsEmail("Ada@Example.com"), true);
      assert.equal(await tenantAllowsEmail("bob@example.org"), true);
      assert.equal(await tenantAllowsEmail("bob@example.com"), false);
    });
    await withTenant(db.tenants[1], async () => assert.equal(await tenantAllowsEmail("ada@example.com"), undefined));
  });

  it("refuses invalid settings and removes a key set to null", async () => {
    const [a] = db.tenants;
    await assert.rejects(run("settings", "set", a, "env", "{}"), TenantCommandError);
    await assert.rejects(run("settings", "set", a, "allowedEmails", '["nope"]'), TenantCommandError);
    await assert.rejects(run("settings", "set", a, "brandName", "Acme"), TenantCommandError);
    await assert.rejects(run("settings", "set", "not-a-tenant", "brandName", '"x"'), TenantCommandError);
    await run("settings", "set", a, "modelGatewayKey", "null");
    const [row] = await db.owner.q("SELECT settings FROM tenants WHERE id = $1", [a]);
    assert.deepEqual(row!.settings, { brandName: "Acme" });
  });

  it("creates a tenant with a member and an admin that only that tenant can see", async () => {
    lines.length = 0;
    await run("create", "--brand-name", "Gamma");
    const tenant = lines[0]!;
    await run("members", "add", tenant, "Grace@Example.com", "--admin");
    await run("list");
    assert.ok(lines.some((line) => line.startsWith(`${tenant}\t`) && line.endsWith("\tGamma")));
    const members = (t: string) =>
      withTenant(t, async () => ({
        directory: (await db.app.q("SELECT principal_id, type FROM directory_members")).map((r) => ({ ...r })),
        admins: (await db.app.q("SELECT principal_id, scope_id, role FROM admin_grants")).map((r) => ({ ...r })),
      }));
    assert.deepEqual(await members(tenant), {
      directory: [{ principal_id: "grace@example.com", type: "internal" }],
      admins: [{ principal_id: "grace@example.com", scope_id: scopeId("org", orgId()), role: "org_admin" }],
    });
    assert.deepEqual(await members(db.tenants[0]), { directory: [], admins: [] });
    const [lookup] = await db.owner.q("SELECT to_regprocedure('qm_tenants_for_email(text)') IS NOT NULL AS present");
    if (lookup!.present) {
      const found = await db.app.q("SELECT tenant_id::text AS id FROM qm_tenants_for_email($1)", ["grace@example.com"]);
      assert.deepEqual(
        found.map((r) => r.id),
        [tenant],
      );
    }
  });

  it("prints usage for unknown commands and flags", async () => {
    await assert.rejects(run("delete", "x"), /usage:/);
    await assert.rejects(run("create", "--bogus"), /usage:/);
    await assert.rejects(run("members", "add", db.tenants[0], "not-an-email"), /expected an email address/);
  });
});
