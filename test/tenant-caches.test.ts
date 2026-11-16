import { test as nodeTest, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { boundTenant, currentTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { loadTenant, onTenantLoad, perTenant, tenantListeners } from "../src/tenants/cache.ts";
import { customProvidersVersion, setCustomProviders } from "../src/model/custom-providers.ts";
import { resolveDeploymentModel } from "../src/model/pi-models.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import type { McpServer, McpServerStore } from "../src/mcp/mcp-server-store.ts";
import { createIdentityService, type DeactivationRecord } from "../src/identity/identity-service.ts";
import type { ExternalMember } from "../src/identity/external-members.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import type { UserLink, UserLinkStore } from "../src/identity/user-store.ts";
import { configStoreMaps, createConfigStore } from "../src/resolution/config-store.ts";
import { createSpendLimits } from "../src/ratelimit/spend-limits.ts";
import { createAdminGrantStore, type AdminGrant } from "../src/admin/admin-grant-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createEngagedRegistry } from "../src/wake/engaged-registry.ts";
import { scopeId } from "../src/types.ts";
import { partition, tenantMap } from "./support/tenant-map.ts";
import type { ScopeActivity, SessionStore, SpendRow } from "../src/sessions/session-store.ts";
import { selectableModelCatalog } from "../src/model/model-catalog.ts";
import { scopeActivity } from "../src/api/routes/admin/scope-activity.ts";
import { setMentionIndex, toSlackMrkdwn } from "../src/slack/mrkdwn.ts";
import { botIdentityArgs, setDefaultBotIdentity } from "../src/slack/delivery.ts";

function test(name: string, fn: (t: TestContext) => void | Promise<void>): void {
  void nodeTest(name, (t) => withoutTenant(() => fn(t)));
}

const noLock: AdvisoryLock = {
  withLock: (_key, fn) => fn(),
  withSharedLock: (_key, fn) => fn(),
  tryWithLocks: (_keys, fn) => fn(),
  tryWithLock: (_key, fn) => fn(),
};

const A = randomUUID();
const B = randomUUID();

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
    async unlink(aliasId) {
      const row = own().get(aliasId) ?? null;
      own().delete(aliasId);
      return row;
    },
  };
}

test("two tenants reading the same cache get their own values", () => {
  const slot = perTenant(() => new Map<string, string>());
  withTenant(A, () => slot().set("key", "a"));
  withTenant(B, () => slot().set("key", "b"));
  assert.equal(
    withTenant(A, () => slot().get("key")),
    "a",
  );
  assert.equal(
    withTenant(B, () => slot().get("key")),
    "b",
  );
});

test("a tenant cache read with no tenant bound throws", () => {
  const slot = perTenant(() => ({}));
  assert.throws(() => slot(), /No tenant is bound/);
  assert.throws(() => setCustomProviders([]), /No tenant is bound/);
  assert.throws(() => toSlackMrkdwn("hi @alice"), /No tenant is bound/);
});

test("an emit reaches only listeners registered under the same tenant", () => {
  const listeners = tenantListeners<[string]>("test");
  const heard: Array<[string, string, string | undefined]> = [];
  withTenant(A, () => listeners.add((value) => heard.push(["a", value, boundTenant()])));
  const offB = withTenant(B, () => listeners.add((value) => heard.push(["b", value, boundTenant()])));
  withTenant(A, () => listeners.emit("one"));
  withTenant(B, () => listeners.emit("two"));
  offB();
  withTenant(B, () => listeners.emit("three"));
  assert.deepEqual(heard, [
    ["a", "one", A],
    ["b", "two", B],
  ]);
  assert.throws(() => listeners.emit("unbound"), /No tenant is bound/);
});

test("a listener registered with no tenant bound hears every tenant, bound to the emitting tenant", () => {
  const listeners = tenantListeners<[string]>("test");
  const heard: Array<[string, string | undefined]> = [];
  const off = listeners.add((value) => heard.push([value, boundTenant()]));
  withTenant(A, () => listeners.emit("one"));
  withTenant(B, () => listeners.emit("two"));
  off();
  withTenant(A, () => listeners.emit("three"));
  assert.deepEqual(heard, [
    ["one", A],
    ["two", B],
  ]);
});

test("a failing listener does not stop the others", () => {
  const listeners = tenantListeners<[]>("test");
  let heard = 0;
  withTenant(A, () => {
    listeners.add(() => {
      throw new Error("boom");
    });
    listeners.add(() => (heard += 1));
    listeners.emit();
  });
  assert.equal(heard, 1);
});

test("delivery enqueue listeners hear only their own tenant's deliveries", async () => {
  const store = createDeliveryStore();
  const heard: string[] = [];
  withTenant(A, () => store.onEnqueue((type) => heard.push(`a:${type}`)));
  withTenant(B, () => store.onEnqueue((type) => heard.push(`b:${type}`)));
  await withTenant(A, () =>
    store.enqueue({ idempotencyKey: "k1", destination: { type: "slack", target: "C1" } as never, text: "hi" }),
  );
  assert.deepEqual(heard, ["a:slack"]);
});

test("loadTenant runs each registered load once per tenant and retries a failed one", async () => {
  const loads: string[] = [];
  let failures = 0;
  const stopCounting = onTenantLoad(async () => loads.push(currentTenant()));
  const stopFailing = onTenantLoad(async () => {
    if (currentTenant() === B && failures++ === 0) throw new Error("load failed");
  });
  await withTenant(A, () => loadTenant());
  await withTenant(A, () => loadTenant());
  await assert.rejects(
    withTenant(B, () => loadTenant()),
    /load failed/,
  );
  await withTenant(B, () => loadTenant());
  assert.deepEqual(loads, [A, B]);
  assert.equal(failures, 2);
  assert.throws(() => loadTenant(), /No tenant is bound/);
  stopCounting();
  stopFailing();
});

test("a load registered with a refresh interval re-runs in the background once its answer is that old", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const loads: string[] = [];
  let release: (() => void) | undefined;
  const stop = onTenantLoad(async () => {
    loads.push(currentTenant());
    if (loads.length === 2) await new Promise<void>((resolve) => (release = resolve));
  }, 30_000);
  await withTenant(A, () => loadTenant());
  t.mock.timers.tick(29_000);
  await withTenant(A, () => loadTenant());
  assert.deepEqual(loads, [A]);
  t.mock.timers.tick(1_000);
  await withTenant(A, () => loadTenant());
  await withTenant(A, () => loadTenant());
  assert.deepEqual(loads, [A, A]);
  release!();
  await new Promise((resolve) => setImmediate(resolve));
  await withTenant(A, () => loadTenant());
  assert.deepEqual(loads, [A, A]);
  t.mock.timers.tick(30_000);
  await withTenant(A, () => loadTenant());
  assert.deepEqual(loads, [A, A, A]);
  stop();
});

test("engaged sessions with the same thread are tracked per tenant", () => {
  const registry = createEngagedRegistry();
  registry.engage({ tenantId: A, threadRef: "thread" });
  registry.engage({ tenantId: B, threadRef: "thread" });
  registry.settle({ tenantId: A, threadRef: "thread" });
  assert.deepEqual(registry.list(), [{ tenantId: B, threadRef: "thread" }]);
});

test("admin seed grants go only to the boot tenant, once", async () => {
  const persisted = new Map<string, AdminGrant[]>();
  let puts = 0;
  const grants = createAdminGrantStore(
    {
      async all(tenant) {
        return persisted.get(tenant.id) ?? [];
      },
      async put(tenant, grant) {
        puts += 1;
        persisted.set(tenant.id, [...(persisted.get(tenant.id) ?? []), grant]);
      },
      async insertIfAbsent() {
        return true;
      },
      async remove() {},
    },
    {
      seed: [{ principalId: "admin@example.com", scopeId: scopeId("org", "acme"), role: "org_admin" }],
      seedsTenant: (t) => t.id === A,
    },
  );
  await withTenant(A, (tenant) => grants.list(tenant));
  await withTenant(A, (tenant) => grants.list(tenant));
  await withTenant(B, (tenant) => grants.list(tenant));
  assert.equal(puts, 1);
  assert.deepEqual(persisted.get(B), undefined);
});

function mcpStore(servers: Record<string, McpServer[]>): McpServerStore & { lists: string[] } {
  const lists: string[] = [];
  const listeners = new Set<() => void>();
  return {
    lists,
    async list() {
      const tenant = currentTenant();
      lists.push(tenant);
      return servers[tenant] ?? [];
    },
    async get(id) {
      return (servers[currentTenant()] ?? []).find((server) => server.id === id) ?? null;
    },
    async put() {
      for (const listener of listeners) listener();
    },
    async delete() {},
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async version() {
      return "";
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

test("a tenant's custom providers neither bump another tenant's version nor resolve deployment-wide", () => {
  const before = withTenant(B, customProvidersVersion);
  withTenant(A, () => {
    setCustomProviders([
      { id: "tenant-a", name: "A", protocol: "openai", baseUrl: "https://a.example/v1", models: [{ id: "model-a" }] },
    ]);
  });
  assert.equal(resolveDeploymentModel("model-a"), undefined);
  withTenant(A, () => setCustomProviders([]));
  assert.equal(withTenant(B, customProvidersVersion), before);
});

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

test("MCP tool lists start loading when a tenant loads", async (t) => {
  const store = mcpStore({ [A]: [signInServer("crm-a")] });
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3_600_000 });
  t.after(() => service.close());
  await withTenant(A, () => loadTenant());
  for (let i = 0; i < 100 && !store.lists.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(store.lists, [A]);
  assert.deepEqual(
    [...new Set((await withTenant(A, () => service.toolDefs())).map((tool) => tool.serverId))],
    ["crm-a"],
  );
  assert.deepEqual(store.lists, [A]);
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
      const tenant = currentTenant();
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

test("Slack mention names stay with their tenant; the env bot identity is process-wide", () => {
  withTenant(A, () => setMentionIndex(new Map([["alice", "UA"]])));
  withTenant(B, () => setMentionIndex(new Map([["alice", "UB"]])));
  assert.equal(
    withTenant(A, () => toSlackMrkdwn("hi @alice")),
    "hi <@UA>",
  );
  assert.equal(
    withTenant(B, () => toSlackMrkdwn("hi @alice")),
    "hi <@UB>",
  );
  setDefaultBotIdentity({ username: "Bot" });
  assert.deepEqual(botIdentityArgs(), { username: "Bot" });
  assert.deepEqual(
    withTenant(B, () => botIdentityArgs()),
    { username: "Bot" },
  );
  setDefaultBotIdentity(undefined);
});
