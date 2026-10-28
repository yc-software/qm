import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { tenant, tenantFor, withTenant } from "../src/tenant.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { testDatabaseUrl, testAdminGrantStore } from "./support/test-database.ts";
import { isCustomModelId, setCustomProviders } from "../src/model/custom-providers.ts";
import { setMentionIndex, toSlackMrkdwn } from "../src/slack/mrkdwn.ts";
import { oauthProvider, setPublicOAuthClients } from "../src/connectors/oauth.ts";
import { mintPortalIdentity, verifyPortalIdentity } from "../src/auth/portal-identity.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { useTenantDirectory } from "../src/tenants/directory.ts";

test("outside any tenant context the process tenant comes from ORG_ID", () => {
  const before = process.env.ORG_ID;
  try {
    process.env.ORG_ID = "acme";
    assert.deepEqual(tenant(), { orgId: "acme", orgScope: "org:acme" });
    delete process.env.ORG_ID;
    assert.deepEqual(tenant(), { orgId: "default-org", orgScope: "org:default-org" });
  } finally {
    if (before === undefined) delete process.env.ORG_ID;
    else process.env.ORG_ID = before;
  }
});

test("a tenant context follows async work and does not leak into concurrent work", async () => {
  const seen: string[] = [];
  const work = (orgId: string, wait: number) =>
    withTenant(tenantFor(orgId), async () => {
      await delay(wait);
      seen.push(`${orgId}:${tenant().orgId}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      seen.push(`${orgId}:${tenant().orgScope}`);
    });
  await Promise.all([work("alpha", 5), work("beta", 1)]);
  assert.deepEqual(seen.sort(), ["alpha:alpha", "alpha:org:alpha", "beta:beta", "beta:org:beta"]);
  assert.equal(tenant().orgId, process.env.ORG_ID ?? "default-org");
});

test("one feature flag store serves each tenant its own org-wide switch", async () => {
  const store = createFeatureFlagStore(testDatabaseUrl());
  await withTenant(tenantFor("alpha"), () => store.setEnabled("inbox_loops", "org:alpha", true, "admin"));
  assert.equal(await withTenant(tenantFor("alpha"), () => store.enabled("inbox_loops", "channel:C1")), true);
  assert.equal(await withTenant(tenantFor("beta"), () => store.enabled("inbox_loops", "channel:C1")), false);
});

test("one admin service resolves internal actors only for the tenant in context", () => {
  const admin = createAdminService(testAdminGrantStore());
  assert.deepEqual(
    withTenant(tenantFor("alpha"), () => admin.resolveActor("ops@alpha")),
    { id: "ops", type: "internal" },
  );
  assert.equal(
    withTenant(tenantFor("beta"), () => admin.resolveActor("ops@alpha")),
    null,
  );
});

const alpha = tenantFor("tenant-alpha");
const beta = tenantFor("tenant-beta");

test("custom providers, Slack mention names and MCP sign-in clients do not cross tenants", () => {
  withTenant(alpha, () => {
    setCustomProviders([
      { id: "alpha", name: "Alpha", protocol: "openai", baseUrl: "https://alpha.example/v1", models: [{ id: "m" }] },
    ]);
    setMentionIndex(new Map([["ankit", "U111"]]));
    setPublicOAuthClients([
      {
        name: "orders",
        host: "api.orders.example",
        authUrl: "https://id.orders.example/authorize",
        tokenUrl: "https://id.orders.example/token",
        scopes: ["orders:write"],
        clientId: "public-client",
        label: "Orders",
      },
    ]);
  });
  assert.equal(
    withTenant(alpha, () => isCustomModelId("custom/alpha/m")),
    true,
  );
  assert.equal(
    withTenant(beta, () => isCustomModelId("custom/alpha/m")),
    false,
  );
  assert.equal(
    withTenant(alpha, () => toSlackMrkdwn("thanks @ankit!")),
    "thanks <@U111>!",
  );
  assert.equal(
    withTenant(beta, () => toSlackMrkdwn("thanks @ankit!")),
    "thanks @ankit!",
  );
  assert.ok(withTenant(alpha, () => oauthProvider("orders")));
  assert.equal(
    withTenant(beta, () => oauthProvider("orders")),
    undefined,
  );
});

async function servingMany(fn: () => Promise<void>): Promise<void> {
  useTenantDirectory({
    byHost: async () => undefined,
    homeHosts: () => ({ hosts: [] }),
    active: async () => [tenant()],
    owner: async (id) => (id === undefined ? tenant() : undefined),
    watch() {},
    close: async () => {},
  });
  try {
    await fn();
  } finally {
    useTenantDirectory(undefined);
  }
}

test("a portal identity naming another tenant is refused when serving many tenants, and only reported otherwise", async () => {
  const secret = "portal-identity-tenant-secret";
  const now = 1_000_000;
  const forAlpha = await mintPortalIdentity({ p: "alice@example.com", t: "tenant-alpha", exp: now + 60_000 }, secret);
  assert.equal((await withTenant(alpha, () => verifyPortalIdentity(forAlpha, secret, now)))?.p, "alice@example.com");
  assert.equal((await withTenant(beta, () => verifyPortalIdentity(forAlpha, secret, now)))?.p, "alice@example.com");
  await servingMany(async () => {
    assert.equal(await withTenant(beta, () => verifyPortalIdentity(forAlpha, secret, now)), null);
  });
});

test("when serving many tenants the API refuses a capability token minted for another tenant", async () => {
  const secret = "tenant-capability-secret".repeat(2);
  const built = buildApp(testConfig({ signingSecret: secret }));
  const server = createServer(built.app, {
    admin: built.admin,
    memory: built.memory,
    signingSecret: secret,
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const mint = () =>
    mintCapabilityToken(
      { actorId: "U1", scopeId: scopeId("personal", "U1"), exp: Date.now() + CAPABILITY_TTL_MS },
      secret,
    );
  const status = async (cap: string) =>
    (await fetch(`${base}/v1/apis`, { headers: { "x-agent-capability": cap } })).status;
  try {
    assert.equal(await status(await mint()), 200);
    assert.equal(await status(await withTenant(alpha, mint)), 200);
    await servingMany(async () => assert.equal(await status(await withTenant(alpha, mint)), 401));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
