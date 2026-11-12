import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { after, before, describe, it } from "./support/unbound-test.ts";
import { EMPTY_TENANT, inboundKey, withInboundTenant } from "../src/api/inbound-tenant.ts";
import { boundTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { tenantLookup, type TenantKey, type TenantLookup } from "../src/tenants/lookup.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

type RowKey = Exclude<TenantKey, "slack_team" | "slack_bridge" | "partner_chat" | "deployment" | "app_host">;
const TABLES: Record<RowKey, string> = {
  webhook: "webhooks",
  loop_ingress: "loop_ingress",
  oauth_flow: "oauth_flows",
  consent_link: "consent_links",
  share: "session_shares",
  secret_drop: "secret_drops",
};

const request = (host = "core.test") => ({ headers: { host }, resume() {} }) as unknown as IncomingMessage;

describe("inbound tenant lookups", () => {
  let db: TwoTenants;
  let lookup: TenantLookup;
  const row = async (table: string, id: string): Promise<unknown> =>
    (await db.app.q(`SELECT json->>'tenant' AS tenant FROM ${table} WHERE id = $1`, [id]))[0]?.tenant ?? null;

  before(async () => {
    db = await twoTenants();
    lookup = tenantLookup(db.app);
    const put = (tenant: string, table: string, id: string, json: object) =>
      db.owner.q(`INSERT INTO ${table}(tenant_id, id, json) VALUES ($1, $2, $3)`, [
        tenant,
        id,
        JSON.stringify({ tenant, ...json }),
      ]);
    const gmail = { kind: "gmail", enabled: true, gmail: { email: "box@x.test" } };
    for (const [i, tenant] of db.tenants.entries()) {
      for (const table of Object.values(TABLES)) {
        await put(tenant, table, `${table}-${i}`, gmail);
        await put(tenant, table, `${table}-shared`, {});
      }
      await put(tenant, "slack_installation", "org", { teamId: `T${i}` });
      await put(tenant, "deployments", `dep-${i}`, { name: `app-${i}` });
    }
  });

  after(() => db?.close());

  it("resolves each key to its own tenant through the definer functions as the app login", async () => {
    for (const [i, tenant] of db.tenants.entries()) {
      for (const [key, table] of Object.entries(TABLES))
        assert.equal(await lookup.tenantFor(key as TenantKey, `${table}-${i}`), tenant, key);
      assert.equal(await lookup.tenantFor("slack_team", `T${i}`), tenant);
      assert.equal(await lookup.tenantFor("deployment", `dep-${i}`), tenant);
      assert.equal(await lookup.tenantFor("deployment", `app-${i}`), tenant);
    }
  });

  it("refuses unknown, empty and cross-tenant ambiguous keys", async () => {
    for (const [key, table] of Object.entries(TABLES)) {
      assert.equal(await lookup.tenantFor(key as TenantKey, `${table}-missing`), undefined);
      assert.equal(await lookup.tenantFor(key as TenantKey, `${table}-shared`), undefined);
      assert.equal(await lookup.tenantFor(key as TenantKey, ""), undefined);
    }
    assert.equal(await lookup.tenantFor("slack_team", "T9"), undefined);
    assert.equal(await lookup.tenantFor("deployment", "app-9"), undefined);
  });

  it("binds a key's tenant so the other tenant's rows stay invisible", async () => {
    const [a, b] = db.tenants;
    for (const [key, table] of Object.entries(TABLES)) {
      const tenant = await lookup.tenantFor(key as TenantKey, `${table}-0`);
      assert.equal(tenant, a);
      await withTenant(tenant!, async () => {
        assert.equal(await row(table, `${table}-0`), a);
        assert.equal(await row(table, `${table}-1`), null);
        assert.equal(await row(table, `${table}-shared`), a);
      });
    }
    await withTenant((await lookup.tenantFor("deployment", "app-1"))!, async () => {
      assert.equal(await row("deployments", "dep-1"), b);
      assert.equal(await row("deployments", "dep-0"), null);
    });
    await withoutTenant(() => assert.rejects(row("webhooks", "webhooks-1"), /No tenant is bound/));
  });

  it("finds every tenant watching a Gmail mailbox", async () => {
    assert.deepEqual((await lookup.gmailTenants("Box@X.test")).sort(), [...db.tenants].sort());
    assert.deepEqual(await lookup.gmailTenants("nobody@x.test"), []);
  });

  it("knows which tenants exist", async () => {
    for (const tenant of db.tenants) assert.equal(await lookup.exists(tenant), true);
    assert.equal(await lookup.exists("7d1f0c52-3b8e-4f6a-9c2d-5e4b3a2f1c0d"), false);
  });

  it("binds keyed routes and app hosts at ingress, and gives unknown keys a tenant that owns no rows", async () => {
    const route = { tenant: { by: "webhook" as const, key: (params: Record<string, string>) => params.id } };
    const url = new URL("http://core.test/v1/webhooks/incoming/x");
    const seen = async (id: string) => {
      const inbound = inboundKey(request(), {}, { route, params: { id } }, url)!;
      let bound: { tenant?: string; rows?: unknown[] } = {};
      await withInboundTenant(lookup, inbound, async () => {
        bound = { tenant: boundTenant(), rows: await db.app.q("SELECT id FROM webhooks") };
      });
      return bound;
    };
    const known = await seen("webhooks-1");
    assert.equal(known.tenant, db.tenants[1]);
    assert.deepEqual(known.rows?.map((r) => (r as { id: string }).id).sort(), ["webhooks-1", "webhooks-shared"]);
    assert.deepEqual(await seen("webhooks-gone"), { tenant: EMPTY_TENANT, rows: [] });
    assert.deepEqual(await seen("webhooks-shared"), { tenant: EMPTY_TENANT, rows: [] });

    const gate = { deployAppsDomain: "apps.test", deployGateSecret: "s" };
    assert.deepEqual(inboundKey(request("dep-1.apps.test:443"), gate, null, url), { by: "app_host", key: "dep-1" });
    assert.equal(inboundKey(request("dep-1.apps.test"), { deployAppsDomain: "apps.test" }, null, url), undefined);
    assert.equal(inboundKey(request(), gate, { route: { tenant: "none" }, params: {} }, url), undefined);
  });
});
