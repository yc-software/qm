import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { after, before, describe, it } from "./support/unbound-test.ts";
import { EMPTY_TENANT, inboundKey, withInboundTenant } from "../src/api/inbound-tenant.ts";
import { identityTenant } from "../src/api/request-tenant.ts";
import { appRawRoutes } from "../src/api/routes/apps.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../src/auth/portal-identity.ts";
import { boundTenant } from "../src/tenants/context.ts";
import { tenantLookup, type TenantLookup } from "../src/tenants/lookup.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

const SECRET = "portal-identity-secret";

describe("app paths on a host shared by several tenants", () => {
  let db: TwoTenants;
  let lookup: TenantLookup;

  before(async () => {
    db = await twoTenants();
    lookup = tenantLookup(db.app);
    for (const [i, tenant] of db.tenants.entries()) {
      for (const [id, name] of [
        [`dep-${i}`, "dash"],
        [`solo-${i}`, `solo-${i}`],
      ])
        await db.owner.q(`INSERT INTO deployments(tenant_id, id, json) VALUES ($1, $2, $3)`, [
          tenant,
          id,
          JSON.stringify({ name }),
        ]);
    }
  });

  after(() => db?.close());

  const request = async (path: string, tenant?: string, secret = SECRET): Promise<IncomingMessage> => {
    const headers: Record<string, string> = { host: "shared.test" };
    if (tenant !== undefined)
      headers[PORTAL_IDENTITY_HEADER] = await mintPortalIdentity(
        { p: "user:1", t: tenant, exp: Date.now() + 60_000 },
        secret,
      );
    return { headers, url: path, method: "GET", resume() {} } as unknown as IncomingMessage;
  };

  const visit = async (req: IncomingMessage): Promise<{ tenant?: string; ids: string[] }> => {
    const url = new URL(`http://shared.test${req.url}`);
    const route = appRawRoutes.find((r) => "match" in r && r.match("GET", url.pathname));
    assert.ok(route);
    const inbound = inboundKey(req, {}, { route, params: {} }, url);
    assert.ok(inbound);
    let seen: { tenant?: string; ids: string[] } = { ids: [] };
    await withInboundTenant(
      lookup,
      inbound,
      async () => {
        const key = url.pathname.split("/")[2];
        const rows = await db.app.q(`SELECT id FROM deployments WHERE id = $1 OR json->>'name' = $1`, [key]);
        seen = { tenant: boundTenant(), ids: rows.map((r) => String(r.id)) };
      },
      () => identityTenant(req, SECRET),
    );
    return seen;
  };

  it("serves a name both tenants use from the signed-in tenant only", async () => {
    const [a, b] = db.tenants;
    assert.deepEqual(await visit(await request("/d/dash/", a)), { tenant: a, ids: ["dep-0"] });
    assert.deepEqual(await visit(await request("/d/dash/", b)), { tenant: b, ids: ["dep-1"] });
  });

  it("never serves another tenant's app to a signed-in user, by id or by name", async () => {
    const [a, b] = db.tenants;
    assert.deepEqual(await visit(await request("/d/dep-1/", a)), { tenant: a, ids: [] });
    assert.deepEqual(await visit(await request("/d/solo-1/", a)), { tenant: a, ids: [] });
    assert.deepEqual(await visit(await request("/d/solo-0/", b)), { tenant: b, ids: [] });
  });

  it("ignores identities signed with another secret and falls back to the app's own tenant", async () => {
    const [a, b] = db.tenants;
    assert.deepEqual(await visit(await request("/d/solo-1/", a, "forged")), { tenant: b, ids: ["solo-1"] });
    assert.deepEqual(await visit(await request("/d/dash/", a, "forged")), { tenant: EMPTY_TENANT, ids: [] });
  });
});
