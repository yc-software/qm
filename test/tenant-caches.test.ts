import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import type { AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import {
  boundTenant,
  cacheTenant,
  createTenantLoader,
  isInstallTenant,
  perTenant,
  registerTenants,
  unboundTenantAllowed,
  withTenant,
} from "../src/tenants/context.ts";
import { orgId } from "../src/config.ts";
import { configureTenantSettings, tenantSettings } from "../src/tenants/settings.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { customModelCatalog, customProvidersVersion, setCustomProviders } from "../src/model/custom-providers.ts";
import { overlayUnavailableReason, overlaysVersion, publishModelOverlays } from "../src/model/model-overlay.ts";
import { gatewayModelCatalog, gatewayModelsVersion, setGatewayModels } from "../src/model/gateway-models.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import type { McpServer, McpServerStore } from "../src/mcp/mcp-server-store.ts";
import { createIdentityService, type DeactivationRecord } from "../src/identity/identity-service.ts";
import type { ExternalMember } from "../src/identity/external-members.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import type { UserLink, UserLinkStore } from "../src/identity/user-store.ts";
import { configStoreMaps, createConfigStore } from "../src/resolution/config-store.ts";
import { createSpendLimits } from "../src/ratelimit/spend-limits.ts";
import { createBrandingCache } from "../plugins/chassis/src/branding.ts";
import { createAdminGrantStore, type AdminGrant } from "../src/admin/admin-grant-store.ts";
import { scopeId } from "../src/types.ts";
import type { ScopeActivity, SessionStore, SpendRow } from "../src/sessions/session-store.ts";
import { selectableModelCatalog } from "../src/model/model-catalog.ts";
import { scopeActivity } from "../src/api/routes/admin/scope-activity.ts";
import { setMentionIndex, toSlackMrkdwn } from "../src/slack/mrkdwn.ts";
import { botIdentityArgs, setDefaultBotIdentity } from "../src/slack/delivery.ts";

const noLock: AdvisoryLock = {
  withLock: (_key, fn) => fn(),
  withSharedLock: (_key, fn) => fn(),
  tryWithLocks: (_keys, fn) => fn(),
  tryWithLock: (_key, fn) => fn(),
};

const A = randomUUID();
const B = randomUUID();

function partition<T>(rows: Map<string, Map<string, T>>): Map<string, T> {
  const key = boundTenant() ?? "";
  const existing = rows.get(key);
  if (existing) return existing;
  const fresh = new Map<string, T>();
  rows.set(key, fresh);
  return fresh;
}

function tenantLinks(): UserLinkStore {
  const rows = new Map<string, Map<string, UserLink>>();
  const own = () => partition(rows);
  return {
    async links() {
      return [...own().values()];
    },
    async link(link) {
      own().set(link.principalId, link);
      return link;
    },
    async unlink(id) {
      const row = own().get(id) ?? null;
      own().delete(id);
      return row;
    },
  };
}

function tenantMap<T>(): DurableMap<T> & { reads: string[] } {
  const rows = new Map<string, Map<string, T>>();
  const reads: string[] = [];
  const own = () => partition(rows);
  const unsupported = (): never => {
    throw new Error("not used by these tests");
  };
  return {
    reads,
    async all() {
      reads.push(boundTenant() ?? "");
      return [...own().values()];
    },
    async entries() {
      return [...own().entries()];
    },
    acrossTenants: unsupported,
    select: unsupported,
    selectEntries: unsupported,
    async get(id) {
      return own().get(id) ?? null;
    },
    async put(id, value) {
      own().set(id, value);
    },
    async putIfAbsent(id, value) {
      const existing = own().get(id);
      if (existing !== undefined) return existing;
      own().set(id, value);
      return value;
    },
    async insertIfAbsent(id, value) {
      if (own().has(id)) return false;
      own().set(id, value);
      return true;
    },
    merge: unsupported,
    async update(id, fn) {
      const existing = own().get(id);
      if (existing === undefined) return null;
      const next = fn(existing);
      own().set(id, next);
      return next;
    },
    mutateMany: unsupported,
    async deleteIf(id, predicate) {
      const existing = own().get(id);
      if (existing === undefined || !predicate(existing)) return false;
      own().delete(id);
      return true;
    },
    async delete(id) {
      own().delete(id);
    },
    async take(id) {
      const existing = own().get(id) ?? null;
      own().delete(id);
      return existing;
    },
  };
}

test("with no registered tenants, unbound work shares one process slot and bound work gets its own", () => {
  const slot = perTenant<{ seen: string[] }>(() => ({ seen: [] }));
  slot().seen.push("unbound");
  withTenant(A, () => slot().seen.push("a"));
  assert.deepEqual(slot().seen, ["unbound"]);
  assert.deepEqual(
    withTenant(A, () => slot().seen),
    ["a"],
  );
  assert.equal(orgId(), process.env.ORG_ID ?? "default-org");
});

test("each tenant gets its own custom providers, model overlays and gateway models", () => {
  withTenant(A, () => {
    setCustomProviders([
      { id: "tenant-a", name: "A", protocol: "openai", baseUrl: "https://a.example/v1", models: [{ id: "model-a" }] },
    ]);
    publishModelOverlays(new Map(), new Map([["overlay-a", "missing key"]]), []);
    setGatewayModels([]);
  });
  const versions = () => ({
    custom: customProvidersVersion(),
    overlays: overlaysVersion(),
    gateway: gatewayModelsVersion(),
  });
  const before = withTenant(B, versions);
  withTenant(A, () => {
    assert.equal(customModelCatalog().length, 1);
    assert.equal(overlayUnavailableReason("overlay-a"), "missing key");
  });
  withTenant(B, () => {
    assert.deepEqual(customModelCatalog(), []);
    assert.equal(overlayUnavailableReason("overlay-a"), undefined);
    assert.deepEqual(gatewayModelCatalog(true), []);
  });
  withTenant(A, () => {
    setCustomProviders([]);
    publishModelOverlays(new Map(), new Map(), []);
  });
  assert.deepEqual(withTenant(B, versions), before);
});

function mcpStore(servers: Record<string, McpServer[]>): McpServerStore & { lists: string[] } {
  const lists: string[] = [];
  const listeners = new Set<() => void>();
  return {
    lists,
    async list() {
      const tenant = boundTenant() ?? "";
      lists.push(tenant);
      return servers[tenant] ?? [];
    },
    async get(id) {
      return (servers[boundTenant() ?? ""] ?? []).find((server) => server.id === id) ?? null;
    },
    async put() {
      for (const listener of listeners) listener();
    },
    async delete() {},
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function signInServer(id: string): McpServer {
  return {
    id,
    name: id,
    url: `https://${id}.example/mcp`,
    auth: "oauth-user",
    tools: [{ name: "lookup", description: "Look something up", inputSchema: { type: "object" } }],
    readOnly: true,
    enabled: true,
    updatedAt: 1,
    updatedBy: "admin",
  };
}

test("MCP tool lists are loaded and refreshed per tenant", async (t) => {
  const store = mcpStore({ [A]: [signInServer("crm-a")], [B]: [signInServer("crm-b")] });
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3_600_000 });
  t.after(() => service.close());
  const servers = (tenant: string) =>
    withTenant(tenant, async () => [...new Set((await service.toolDefs()).map((tool) => tool.serverId))]);
  assert.deepEqual(await servers(A), ["crm-a"]);
  assert.deepEqual(await servers(B), ["crm-b"]);
  assert.deepEqual(store.lists, [A, B]);
  await withTenant(A, () => service.refresh());
  assert.deepEqual(store.lists, [A, B, A]);
  assert.deepEqual(await servers(B), ["crm-b"]);
  assert.deepEqual(store.lists, [A, B, A]);
});

test("identity rosters and principal links are kept and refreshed per tenant", async () => {
  const deactivations = tenantMap<DeactivationRecord>();
  const externals = tenantMap<ExternalMember>();
  const links = createPrincipalLinkService(tenantLinks(), noLock);
  const identity = createIdentityService(deactivations, { externalMembers: externals, principalLinks: links });
  await withTenant(A, async () => {
    await identity.refresh(true);
    await identity.deactivate("pat@example.com");
    await links.link({ principalId: "U123", canonicalId: "pat@example.com", evidence: "test", linkedBy: "admin" });
  });
  await withTenant(B, () => identity.refresh(true));
  withTenant(A, () => {
    assert.equal(identity.classify("pat@example.com").type, "guest");
    assert.ok(links.aliases("pat@example.com").length > 0);
  });
  withTenant(B, () => {
    assert.equal(identity.classify("pat@example.com").type, "internal");
    assert.deepEqual(links.aliases("pat@example.com"), []);
  });
  const readsOfB = () => deactivations.reads.filter((tenant) => tenant === B).length;
  const before = readsOfB();
  await withTenant(A, () => identity.refresh(true));
  assert.equal(readsOfB(), before);
});

test("configuration, souls and branding are cached per tenant", async () => {
  const store = createConfigStore(
    "acme",
    configStoreMaps(() => tenantMap<never>()),
  );
  const org = scopeId("org", "acme");
  await withTenant(A, async () => {
    await store.hydrate?.();
    await store.setSoul(org, "Tenant A instructions");
    await store.setBranding(org, { orgName: "Tenant A" });
  });
  await withTenant(B, () => store.hydrate?.());
  withTenant(A, () => {
    assert.equal(store.getSoul(org), "Tenant A instructions");
    assert.equal(store.getBranding(org)?.orgName, "Tenant A");
  });
  withTenant(B, () => {
    assert.notEqual(store.getSoul(org), "Tenant A instructions");
    assert.equal(store.getBranding(org), null);
  });
});

test("spend totals are cached per tenant", async () => {
  const spent: SpendRow = {
    day: Math.floor(Date.now() / 86_400_000),
    model: null,
    scopeId: scopeId("org", "acme"),
    origin: "conversation",
    cronId: null,
    calls: 1,
    costUsd: 9,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const reports: string[] = [];
  const limits = createSpendLimits({
    orgId: () => "acme",
    getSpendLimit: async () => ({ dailyUsd: 5 }),
    spendReport: async () => {
      const tenant = boundTenant() ?? "";
      reports.push(tenant);
      return { rows: tenant === A ? [spent] : [] };
    },
  });
  const org = scopeId("org", "acme");
  assert.equal((await withTenant(A, () => limits.status(org)))?.over, "daily");
  assert.equal((await withTenant(B, () => limits.status(org)))?.over, null);
  assert.deepEqual(reports, [A, B]);
});

test("each tenant's model catalog lists only its own custom models", async () => {
  const tenants = [randomUUID(), randomUUID()];
  for (const tenant of tenants)
    withTenant(tenant, () =>
      setCustomProviders([
        {
          id: `p${tenant.slice(0, 8)}`,
          name: tenant,
          protocol: "openai",
          baseUrl: "https://custom.example/v1",
          models: [{ id: `model-${tenant}` }],
        },
      ]),
    );
  const fetcher = (async () => Response.json({ data: [] })) as unknown as typeof fetch;
  const customIds = (models: Array<{ id: string }>) => models.map((m) => m.id).filter((id) => id.startsWith("custom/"));
  const catalogs = () =>
    Promise.all(tenants.map((tenant) => withTenant(tenant, () => selectableModelCatalog(fetcher))));
  for (const run of [await catalogs(), await catalogs()])
    assert.deepEqual(
      run.map(customIds),
      tenants.map((tenant) => [`custom/p${tenant.slice(0, 8)}/model-${tenant}`]),
    );
  for (const tenant of tenants) withTenant(tenant, () => setCustomProviders([]));
});

test("admin scope activity counts are kept per tenant", async () => {
  const activity = (scope: string): ScopeActivity => ({
    scopeId: scopeId("org", scope),
    conversations: 1,
    crons: 0,
    background: 0,
    lastActivity: 0,
  });
  const store = {
    scopeActivity: async () => [activity(boundTenant() === A ? "a" : "b")],
  } as unknown as SessionStore;
  const scopes = (tenant: string) => withTenant(tenant, () => [...(scopeActivity(store)?.byScope.keys() ?? [])]);
  scopes(A);
  scopes(B);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scopes(A), [scopeId("org", "a")]);
  assert.deepEqual(scopes(B), [scopeId("org", "b")]);
});

test("Slack mention names and bot identity stay with their tenant", () => {
  withTenant(A, () => {
    setMentionIndex(new Map([["alice", "UA"]]));
    setDefaultBotIdentity({ username: "Bot A" });
  });
  withTenant(B, () => {
    setMentionIndex(new Map([["alice", "UB"]]));
    setDefaultBotIdentity({ username: "Bot B" });
  });
  assert.equal(
    withTenant(A, () => toSlackMrkdwn("hi @alice")),
    "hi <@UA>",
  );
  assert.equal(
    withTenant(B, () => toSlackMrkdwn("hi @alice")),
    "hi <@UB>",
  );
  assert.deepEqual(
    withTenant(A, () => botIdentityArgs()),
    { username: "Bot A" },
  );
  assert.deepEqual(
    withTenant(B, () => botIdentityArgs()),
    { username: "Bot B" },
  );
});

test("surface branding is fetched and cached per tenant", async () => {
  const branding = createBrandingCache(async () => ({ orgName: `Org ${boundTenant() ?? "none"}` }));
  assert.equal((await withTenant(A, () => branding.forRender())).orgName, `Org ${A}`);
  assert.equal((await withTenant(B, () => branding.forRender())).orgName, `Org ${B}`);
  assert.equal(withTenant(A, () => branding.current()).orgName, `Org ${A}`);
});

test("a tenant loader loads each tenant once and retries a tenant whose load failed", async () => {
  const loads: string[] = [];
  const loader = createTenantLoader([async () => loads.push(cacheTenant())]);
  await withTenant(A, () => loader.load());
  await withTenant(A, () => loader.load());
  await withTenant(B, () => loader.load());
  assert.deepEqual(loads, [A, B]);
  let attempts = 0;
  const failing = createTenantLoader([
    async () => {
      attempts += 1;
      throw new Error("load failed");
    },
  ]);
  await assert.rejects(
    withTenant(A, () => failing.load()),
    /load failed/,
  );
  await assert.rejects(
    withTenant(A, () => failing.load()),
    /load failed/,
  );
  assert.equal(attempts, 2);
});

test("each tenant's org label comes from its settings, so it sees its own org-scoped rows and not the other's", async () => {
  configureTenantSettings(async (tenant) => (tenant === A ? { orgId: "acme" } : { orgId: "globex" }));
  try {
    await withTenant(A, () => tenantSettings());
    await withTenant(B, () => tenantSettings());
    assert.equal(
      withTenant(A, () => orgId()),
      "acme",
    );
    assert.equal(
      withTenant(B, () => orgId()),
      "globex",
    );
    const identity = tenantMap<{ orgId: string }>();
    const store = createConfigStore("default-org", {
      ...configStoreMaps(() => tenantMap<never>()),
      deploymentIdentity: identity,
    });
    await withTenant(B, () => identity.put("singleton", { orgId: "globex" }));
    await withTenant(A, async () => {
      await store.hydrate?.();
      await store.setSoul(scopeId("org", "acme"), "Acme instructions");
    });
    await withTenant(B, () => store.hydrate?.());
    withTenant(A, () => assert.equal(store.getSoul(scopeId("org", "acme")), "Acme instructions"));
    withTenant(B, () => {
      assert.equal(store.getSoul(scopeId("org", "acme")), null);
      assert.notEqual(store.getSoul(scopeId("org", "globex")), "Acme instructions");
    });
    const installs = createSlackInstallationStore("default-org", tenantMap(), "k".repeat(32));
    await withTenant(A, () => installs.set({ botToken: "xoxb-acme", updatedBy: "admin" }));
    assert.equal((await withTenant(A, () => installs.status())).configured, true);
    assert.equal((await withTenant(B, () => installs.status())).configured, false);
  } finally {
    configureTenantSettings(undefined);
  }
});

test("with several tenants, unbound cache reads fail closed, org identities differ, and seeds stay with the install", async () => {
  registerTenants(A, undefined);
  const slot = perTenant(() => ({}));
  assert.throws(() => slot(), /No tenant is bound/);
  assert.equal(unboundTenantAllowed(), false);
  assert.equal(
    withTenant(A, () => orgId()),
    process.env.ORG_ID ?? "default-org",
  );
  assert.equal(
    withTenant(B, () => orgId()),
    B,
  );
  configureTenantSettings(async () => ({}));
  try {
    assert.throws(() => withTenant(B, () => orgId()), /settings are not loaded/);
  } finally {
    configureTenantSettings(undefined);
  }
  assert.equal(
    withTenant(B, () => isInstallTenant()),
    false,
  );
  const persisted = new Map<string, AdminGrant[]>();
  const grants = createAdminGrantStore(
    {
      async all() {
        return persisted.get(boundTenant() ?? "") ?? [];
      },
      async put(grant) {
        const tenant = boundTenant() ?? "";
        persisted.set(tenant, [...(persisted.get(tenant) ?? []), grant]);
      },
      async insertIfAbsent() {
        return true;
      },
      async remove() {},
    },
    { seed: [{ principalId: "admin@example.com", scopeId: scopeId("org", "acme"), role: "org_admin" }] },
  );
  assert.deepEqual(
    (await withTenant(A, () => grants.list())).map((grant) => grant.principalId),
    ["admin@example.com"],
  );
  assert.deepEqual(await withTenant(B, () => grants.list()), []);
});

test("with exactly one tenant, unbound work resolves to it", () => {
  registerTenants(A, A);
  const slot = perTenant(() => ({ id: randomUUID() }));
  assert.equal(
    slot().id,
    withTenant(A, () => slot().id),
  );
  assert.equal(unboundTenantAllowed(), true);
});

test("a failed configuration load is retried on the next call", async () => {
  const maps = configStoreMaps(() => tenantMap<never>());
  const souls = maps.souls;
  let failures = 1;
  const flaky: typeof souls = {
    ...souls,
    all: () => (failures-- > 0 ? Promise.reject(new Error("connection reset")) : souls.all()),
  };
  const store = createConfigStore("acme", { ...maps, souls: flaky });
  await withTenant(A, async () => {
    await assert.rejects(store.hydrate?.() ?? Promise.resolve(), /connection reset/);
    await store.hydrate?.();
  });
});
