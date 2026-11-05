import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mintPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { createTenantBranding } from "../server/tenant-branding.ts";

const secret = "tenant-branding-identity-secret-0123456789";
const alpha = "00000000-0000-4000-8000-00000000000a";
const beta = "00000000-0000-4000-8000-00000000000b";
const names: Record<string, string> = { [alpha]: "Alpha Co", [beta]: "Beta Co" };

test("each tenant's browsers get that tenant's branding, never another's", async () => {
  const token = new AsyncLocalStorage<string | undefined>();
  const branding = createTenantBranding(
    async () => ({ orgName: names[branding.tenant() ?? ""] ?? "Install" }),
    () => token.getStore(),
    secret,
  );
  const as = async (tenant: string | undefined) =>
    token.run(
      tenant
        ? await mintPortalIdentity({ p: "person@company.test", t: tenant, exp: Date.now() + 60_000 }, secret)
        : undefined,
      async () => {
        await branding.refreshNow();
        return { tenant: branding.tenant(), branding: await branding.forRender() };
      },
    );
  assert.deepEqual(await as(alpha), { tenant: alpha, branding: { orgName: "Alpha Co" } });
  assert.deepEqual(await as(beta), { tenant: beta, branding: { orgName: "Beta Co" } });
  assert.deepEqual(await as(alpha), { tenant: alpha, branding: { orgName: "Alpha Co" } });
  assert.deepEqual(await as(undefined), { tenant: undefined, branding: { orgName: "Install" } });
});
