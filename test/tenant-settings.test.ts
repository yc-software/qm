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
import {
  loadTenantSettings,
  tenantAllowsEmail,
  tenantAppHandle,
  tenantSettingsSchema,
} from "../src/tenants/settings.ts";
import { appUrlOf } from "../src/deploy/deploy-store.ts";
import { appHostLabel, appLabelLimitError, appNameFromLabel } from "../src/tenants/app-handle.ts";
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

describe("app host labels", () => {
  it("split on the first hyphen, so handles with digits and app names with hyphens both survive", () => {
    assert.equal(appHostLabel("nitroduck7", "sales-board-v2"), "nitroduck7-sales-board-v2");
    assert.equal(appNameFromLabel("nitroduck7-sales-board-v2", "nitroduck7"), "sales-board-v2");
    assert.equal(appNameFromLabel("nitroduck7-", "nitroduck7"), "nitroduck7-");
    assert.equal(appNameFromLabel("other-sales", "nitroduck7"), "other-sales");
    assert.equal(appNameFromLabel("sales-board", undefined), "sales-board");
  });

  it("refuse an app whose <handle>-<app> label would exceed one DNS label", () => {
    assert.equal(appLabelLimitError(undefined, "a".repeat(80)), undefined);
    assert.equal(appLabelLimitError("h".repeat(30), "a".repeat(32)), undefined);
    assert.match(appLabelLimitError("h".repeat(30), "a".repeat(33)) ?? "", /\(64 characters\), over the 63-character/);
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
    await withTenant(db.tenants[0], async (tenant) => {
      await createPostgresDirectoryStore(db.ownerDatabaseUrl).list(tenant);
      await createPostgresAdminGrantStore(db.ownerDatabaseUrl).all(tenant);
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

describe("company app links", () => {
  let db: TwoTenants;
  before(async () => {
    db = await twoTenants();
  });
  after(async () => {
    await db?.close();
  });

  it("links apps of a company with no handle on the shared host or their provider URL", async () => {
    const [a, b] = db.tenants;
    const stop = onTenantLoad(() => loadTenantSettings(db.app));
    try {
      const app = {
        id: "d1",
        name: "demo-app",
        endpoint: { publicUrl: "https://demo-app.apps.example.test/?access=x" },
      } as never;
      const urls = (tenant: string) =>
        withTenant(tenant, async () => {
          await loadTenant();
          return [
            appUrlOf(app, { sharedWebUrl: "https://mt.example.test/", appsDomain: undefined }),
            appUrlOf({ id: "d2" }, { sharedWebUrl: "https://mt.example.test/", appsDomain: undefined }),
          ];
        });
      for (const tenant of [a, b])
        assert.deepEqual(await urls(tenant), ["https://demo-app.apps.example.test/", "https://mt.example.test/d/d2/"]);
    } finally {
      stop();
    }
  });

  it("links a company's apps as <handle>-<app> on the apps domain, with the handle defaulting from its org slug", async () => {
    const [a, b] = db.tenants;
    await db.owner.q(`UPDATE tenants SET settings = '{"orgSlug":"nitro-duck"}' WHERE id = $1`, [a]);
    await db.owner.q(`UPDATE tenants SET settings = '{"handle":"beta7","orgSlug":"beta-co"}' WHERE id = $1`, [b]);
    const stop = onTenantLoad(() => loadTenantSettings(db.app));
    try {
      const link = (tenant: string, appsDomain?: string) =>
        withTenant(tenant, async () => {
          await loadTenant();
          return [
            tenantAppHandle(),
            appUrlOf({ id: "d1", name: "sales-dashboard" }, { sharedWebUrl: "https://mt.example.test", appsDomain }),
          ];
        });
      assert.deepEqual(await link(a, "QM.example.test"), [
        "nitroduck",
        "https://nitroduck-sales-dashboard.qm.example.test/",
      ]);
      assert.deepEqual(await link(b, "qm.example.test"), ["beta7", "https://beta7-sales-dashboard.qm.example.test/"]);
      assert.deepEqual(await link(b), ["beta7", "https://mt.example.test/d/sales-dashboard/"]);
    } finally {
      stop();
      await db.owner.q(`UPDATE tenants SET settings = '{}' WHERE id = ANY($1)`, [[a, b]]);
    }
  });

  it("refuses a handle that is malformed, reserved or already another company's, including its derived default", async () => {
    const [a, b] = db.tenants;
    for (const bad of ["a", "has-hyphen", "UPPER", "x".repeat(62), "admin", "mt", "www"])
      assert.equal(tenantSettingsSchema.safeParse({ handle: bad }).success, false, bad);
    for (const good of ["nitroduck2", "x".repeat(61)])
      assert.equal(tenantSettingsSchema.safeParse({ handle: good }).success, true, good);
    await db.owner.q(`UPDATE tenants SET settings = '{"orgSlug":"nitro-duck"}' WHERE id = $1`, [a]);
    try {
      await assert.rejects(
        db.owner.q(`UPDATE tenants SET settings = '{"handle":"nitroduck"}' WHERE id = $1`, [b]),
        /tenants_app_handle/,
      );
      await assert.rejects(
        withTenant(b, () => db.app.q(`SELECT qm_set_tenant_handle('nitroduck')`)),
        /tenants_app_handle/,
      );
      await assert.rejects(
        withTenant(b, () => db.app.q(`SELECT qm_set_tenant_handle('auth')`)),
        /invalid app handle/,
      );
      await withTenant(b, () => db.app.q(`SELECT qm_set_tenant_handle('beta7')`));
      const rows = await db.owner.q(`SELECT settings->>'handle' AS handle FROM tenants WHERE id = $1`, [b]);
      assert.equal(rows[0]?.handle, "beta7");
      const found = await db.app.q(`SELECT qm_tenant_for_app_host('beta7-sales-dash')::text AS id`);
      assert.equal(found[0]?.id, b);
      const derived = await db.app.q(`SELECT qm_tenant_for_app_host('nitroduck-x')::text AS id`);
      assert.equal(derived[0]?.id, a);
      const longSlug = `nitro-${"duck".repeat(10)}`;
      await db.owner.q(`UPDATE tenants SET settings = jsonb_build_object('orgSlug', $2::text) WHERE id = $1`, [
        a,
        longSlug,
      ]);
      const longDerived = await db.app.q(`SELECT qm_tenant_for_app_host($1)::text AS id`, [
        `${longSlug.replace(/-/g, "")}-x`,
      ]);
      assert.equal(longDerived[0]?.id, a);
    } finally {
      await db.owner.q(`UPDATE tenants SET settings = '{}' WHERE id = ANY($1)`, [[a, b]]);
    }
  });
});
