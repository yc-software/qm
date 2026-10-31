import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresLinkTables } from "../src/connectors/link-tables.ts";
import { createOAuthFlowStore } from "../src/connectors/oauth-flow-store.ts";
import { createConsentLinkStore } from "../src/connectors/consent-link.ts";
import { createSecretDropStore, type SecretDropRecord } from "../src/credentials/secret-drop.ts";
import { createBrowserSessionStore } from "../src/connectors/browser-session-store.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const AT = 1_700_000_000_000;
const DROP: Omit<SecretDropRecord, "createdAt"> = {
  ownerId: "U1",
  service: "stripe",
  purpose: "billing",
  requestedBy: "U1",
  audienceScopeId: "channel:C1",
  threadRef: "slack:C1:1.0",
};
const SERVER: McpServer = {
  id: "linear",
  name: "Linear",
  url: "https://mcp.linear.app/sse",
  auth: "oauth-user",
  credentialScope: "per-user",
  oauthScopes: ["read"],
  tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
  readOnly: true,
  enabled: true,
  updatedAt: AT,
  updatedBy: "admin",
};

test("one-time links are redeemed once and only by their own tenant", { skip }, async () => {
  await withTypedTableDb(createPostgresLinkTables, async ({ store, tenant, otherTenant }) => {
    const flows = createOAuthFlowStore(store.oauthFlows, { now: () => AT });
    const links = createConsentLinkStore(store.consentLinks, { now: () => AT });
    const drops = createSecretDropStore(store.secretDrops, { now: () => AT });
    const { flowId, linkId, dropId } = await withTenant(tenant, async () => ({
      flowId: await flows.start({ provider: "github", principalId: "U1", redirectUri: "https://qm.example/cb" }),
      linkId: (await links.mint({ principalId: "U1", provider: "github", accountType: "default", redirectUri: "r" }))
        .linkId,
      dropId: (await drops.mint(DROP)).dropId,
    }));
    assert.match(flowId, /^[A-Za-z0-9_-]{43}$/);
    assert.match(linkId, /^[0-9a-f-]{68}$/);
    await withTenant(otherTenant, async () => {
      assert.equal(await flows.finish(flowId), null);
      assert.deepEqual(await links.redeem(linkId), { ok: false, reason: "not_found" });
      assert.deepEqual(await drops.redeem(dropId), { ok: false, reason: "not_found" });
    });
    await withTenant(tenant, async () => {
      assert.deepEqual(await flows.finish(flowId), {
        provider: "github",
        principalId: "U1",
        redirectUri: "https://qm.example/cb",
        issuedAt: AT,
        nonce: flowId,
      });
      assert.equal(await flows.finish(flowId), null);
      assert.equal((await links.peek(linkId)).ok, true);
      assert.equal((await links.redeem(linkId)).ok, true);
      assert.deepEqual(await links.redeem(linkId), { ok: false, reason: "not_found" });
      assert.deepEqual(await drops.peek(dropId), { ok: true, rec: { ...DROP, createdAt: AT } });
    });
  });
});

test("secret drop siblings share the thread, skip the same service and expire", { skip }, async () => {
  await withTypedTableDb(createPostgresLinkTables, async ({ store, admin, tenant, otherTenant }) => {
    let now = AT;
    const drops = createSecretDropStore(store.secretDrops, { now: () => now, ttlMs: 1_000 });
    await withTenant(tenant, async () => {
      await drops.mint(DROP);
      await drops.mint({ ...DROP, service: "github" });
      await drops.mint({ ...DROP, service: "aws", threadRef: "slack:C1:2.0" });
    });
    await withTenant(otherTenant, () => drops.mint({ ...DROP, service: "gitlab" }));
    const siblings = await withTenant(tenant, () => drops.siblings({ ...DROP, createdAt: AT }));
    assert.deepEqual(
      siblings.map((d) => d.service),
      ["github"],
    );
    now = AT + 5_000;
    assert.deepEqual(await withTenant(tenant, () => drops.siblings({ ...DROP, createdAt: now })), []);
    for (let i = 0; i < 50; i++) {
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM secret_drops WHERE tenant_id = $1", [tenant]);
      if (rows[0].n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const { rows } = await admin.query("SELECT tenant_id::text AS tenant FROM secret_drops");
    assert.deepEqual(rows, [{ tenant: otherTenant }]);
  });
});

test("browser sessions, composio returns and MCP servers stay inside their tenant", { skip }, async () => {
  await withTypedTableDb(createPostgresLinkTables, async ({ store, tenant, otherTenant }) => {
    const sessions = createBrowserSessionStore({ sessions: store.browserSessions, key: deriveConnectorKey("bs") });
    const servers = createMcpServerStore(store.mcpServers);
    await withTenant(tenant, async () => {
      await sessions.put("U1", '{"cookies":[]}');
      await store.composioReturns.put("u:ca_1", { url: null, toolkit: "gmail", expiresAt: AT + 1 });
      await store.composioReturns.put("u:ca_2", { url: "https://qm.example/x", toolkit: "gmail", expiresAt: AT - 1 });
      await servers.put(SERVER);
    });
    await withTenant(otherTenant, async () => {
      assert.equal(await sessions.get("U1"), null);
      assert.equal(await store.composioReturns.take("u:ca_1"), null);
      assert.deepEqual(await servers.list(), []);
      assert.equal(await servers.get("linear"), null);
    });
    await withTenant(tenant, async () => {
      assert.equal(await sessions.get("U1"), '{"cookies":[]}');
      await store.composioReturns.deleteExpired(AT);
      assert.equal(await store.composioReturns.take("u:ca_2"), null);
      assert.deepEqual(await store.composioReturns.take("u:ca_1"), { url: null, toolkit: "gmail", expiresAt: AT + 1 });
      assert.deepEqual(await servers.list(), [SERVER]);
      await servers.delete("linear");
      assert.equal(await servers.get("linear"), null);
    });
  });
});

test("the conversion backfills link tables into the instance tenant and drops the old tables", { skip }, async () => {
  await withTypedTableDb(
    createPostgresLinkTables,
    async ({ store, admin, tenant }) => {
      await withTenant(tenant, async () => {
        assert.deepEqual(await store.oauthFlows.take("flow-1"), {
          provider: "github",
          principalId: "U1",
          redirectUri: "r",
          issuedAt: AT,
          codeVerifier: "v",
          nonce: "flow-1",
        });
        assert.deepEqual(await store.consentLinks.get("link-1"), {
          principalId: "U1",
          provider: "github",
          accountType: "company",
          redirectUri: "r",
          createdAt: AT,
        });
        assert.deepEqual(await store.secretDrops.get("drop-1"), {
          ...DROP,
          fields: [{ key: "STRIPE_KEY", secret: true }],
          createdAt: AT,
        });
        assert.deepEqual(await store.composioReturns.take("u:ca"), { url: null, toolkit: "gmail", expiresAt: AT });
        assert.deepEqual(await store.browserSessions.get("U1"), { principalId: "U1", stateEnc: "enc", updatedAt: AT });
        assert.deepEqual(await store.mcpServers.get("linear"), SERVER);
      });
      const { rows } = await admin.query(
        `SELECT count(*)::int AS old FROM pg_class
          WHERE relname IN ('oauth_flows_kv', 'consent_links_kv', 'secret_drops_kv', 'composio_returns_kv',
                            'browser_sessions_kv', 'mcp_servers_kv')`,
      );
      assert.deepEqual(rows, [{ old: 0 }]);
      assert.deepEqual((await admin.query("SELECT count(*)::int AS n FROM durable_map_versions")).rows, [{ n: 0 }]);
    },
    async (admin) => {
      await seedKeyValueTable(admin, "oauth_flows", {
        "flow-1": {
          provider: "github",
          principalId: "U1",
          redirectUri: "r",
          issuedAt: AT,
          nonce: "flow-1",
          orgId: "default-org",
          codeVerifier: "v",
        },
      });
      await seedKeyValueTable(admin, "consent_links", {
        "link-1": {
          principalId: "U1",
          orgId: "o",
          provider: "github",
          accountType: "company",
          redirectUri: "r",
          createdAt: AT,
        },
      });
      await seedKeyValueTable(admin, "secret_drops", {
        "drop-1": { ...DROP, orgId: "o", fields: [{ key: "STRIPE_KEY", secret: true }], createdAt: AT },
      });
      await seedKeyValueTable(admin, "composio_returns", { "u:ca": { url: null, toolkit: "gmail", expiresAt: AT } });
      await seedKeyValueTable(admin, "browser_sessions", { U1: { principalId: "U1", stateEnc: "enc", updatedAt: AT } });
      await seedKeyValueTable(admin, "mcp_servers", { linear: SERVER, junk: { id: "junk" } });
    },
  );
});
