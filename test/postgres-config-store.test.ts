import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryConfigStore, type ScopedConfigStore } from "../src/resolution/config-store.ts";
import { createPostgresConfigTables } from "../src/resolution/config-tables-pg.ts";
import type { ConfigTables } from "../src/resolution/config-tables.ts";
import { defaultOrgPolicy } from "../src/policy/command-policy.ts";
import { withTenant } from "../src/tenants/context.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { bindTestTenant } from "./support/tenant.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb, type TypedTableDb } from "./support/typed-table.ts";

bindTestTenant();

const skip = skipWithoutPg;
const ORG = "default-org";
const org = scopeId("org", ORG);
const channel = scopeId("channel", "C1");
const personal = scopeId("personal", "U1");

interface Fixture {
  tables: ConfigTables;
  close(): Promise<void>;
}

const fixture = (url: string): Fixture => {
  const tables = createPostgresConfigTables(url);
  return { tables, close: () => tables.close!() };
};

async function withConfigDb(
  fn: (
    db: Omit<TypedTableDb<Fixture>, "store"> & { store: (tenant: string) => Promise<ScopedConfigStore> },
  ) => Promise<void>,
  seed?: Parameters<typeof withTypedTableDb>[2],
): Promise<void> {
  await withTypedTableDb(
    fixture,
    async (db) => {
      const opened: Fixture[] = [];
      const store = async (tenant: string) => {
        const next = fixture(db.url);
        opened.push(next);
        const config = createMemoryConfigStore({ tables: next.tables, connectorSecretKey: "test-key" });
        await withTenant(tenant, () => config.hydrate());
        return config;
      };
      try {
        await fn({ ...db, store });
      } finally {
        await Promise.all(opened.map((f) => f.close()));
      }
    },
    seed,
  );
}

test("per-scope settings written on one core survive a restart", { skip }, async () => {
  await withConfigDb(async ({ tenant, store }) => {
    const a = await store(tenant);
    const policy = defaultOrgPolicy();
    await withTenant(tenant, async () => {
      assert.equal(await a.setSoul(channel, "channel soul"), 1);
      await a.setCommandPolicy(channel, policy);
      await a.setSecurityPosture(channel, "strict");
      await a.setSharingPosture(org, "open");
      await a.setSharingPosture(channel, "open");
      await a.setApprovalGrantModes(channel, { session: false, always: true });
      await a.setEgress(channel, { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] });
      await a.setRuntimeSelection(channel, { harnessId: "pi", modelId: "claude-opus-4-8", effortLevel: "low" });
      await a.setBrowseMaxSteps(channel, 120);
      await a.setBrowseModel(channel, "claude-sonnet-4-6");
      await a.setWebuiModels(channel, ["claude-opus-4-8"]);
      await a.setAckEmoji(channel, ["eyes"]);
      await a.setBranding(org, { accent: "#123456", orgName: "Acme" });
      await a.setChannelHeaderPin(channel, true);
      await a.setExternalSlackParticipants(org, true);
      await a.setOrgAmbient(false);
      await a.setInteractiveFastMode(true);
      await a.setPersonalModelAuth("U1", true, "openai");
      await a.setPurposeRuntime("cron", { harnessId: "pi", modelId: "gpt-5.5", fastMode: false });
      await a.setSlackEmojiCatalog(channel, { party: "https://emoji.example/party.png" });
      await a.setConnectorClient(org, "google", { clientId: "cid", clientSecret: "shh", scopes: ["email"] });
    });

    const b = await store(tenant);
    await withTenant(tenant, async () => {
      assert.equal(b.getSoul(channel), "channel soul");
      assert.equal(b.soulVersion(channel), 1);
      assert.deepEqual(b.getCommandPolicy(channel), policy);
      assert.equal(await b.getSecurityPostureDurable(channel), "strict");
      assert.equal(await b.resolveSharingPostureDurable(personal, channel), "open");
      assert.deepEqual(b.getApprovalGrantModes(channel), { session: false, always: true });
      assert.deepEqual(b.getEgress(channel), { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] });
      assert.deepEqual(b.getRuntimeSelection(channel), {
        harnessId: "pi",
        modelId: "claude-opus-4-8",
        effortLevel: "low",
        orgRevision: 0,
      });
      assert.equal(b.getBrowseMaxSteps(channel), 120);
      assert.equal(b.getBrowseModel(channel), "claude-sonnet-4-6");
      assert.deepEqual(b.getWebuiModels(channel), ["claude-opus-4-8"]);
      assert.deepEqual(b.getAckEmoji(channel), ["eyes"]);
      assert.deepEqual(b.getBranding(org), { accent: "#123456", orgName: "Acme" });
      assert.equal(b.getChannelHeaderPin(channel), true);
      assert.equal(b.getExternalSlackParticipants(channel), true);
      assert.equal(b.getOrgAmbient(), false);
      assert.equal(b.getInteractiveFastMode(), true);
      assert.equal(await b.getModelAccountDurable("U1"), "openai");
      assert.equal(await b.getModelAccountDurable("U2"), "company");
      assert.deepEqual(b.getPurposeRuntime("cron"), { harnessId: "pi", modelId: "gpt-5.5", fastMode: false });
      assert.deepEqual((await b.getSlackEmojiCatalogDurable(channel))?.emoji, {
        party: "https://emoji.example/party.png",
      });
      assert.deepEqual(await b.getConnectorClientSecret(org, "google"), {
        clientId: "cid",
        clientSecret: "shh",
        scopes: ["email"],
        enabled: true,
      });
      await b.setBrowseMaxSteps(channel, null);
      await b.setRuntimeSelection(channel, null);
      await b.clearPurposeRuntime("cron");
      await b.deleteConnectorClient(org, "google");
    });

    const c = await store(tenant);
    await withTenant(tenant, async () => {
      assert.equal(c.getBrowseMaxSteps(channel), null);
      assert.equal(c.getRuntimeSelection(channel), null);
      assert.equal(c.getBrowseModel(channel), "claude-sonnet-4-6", "clearing one column keeps the others");
      assert.equal(c.getPurposeRuntime("cron"), undefined);
      assert.deepEqual(await c.listConnectorClients(org), []);
    });
  });
});

test("refreshScope carries a write from one core to another", { skip }, async () => {
  await withConfigDb(async ({ tenant, store }) => {
    const a = await store(tenant);
    const b = await store(tenant);
    await withTenant(tenant, async () => {
      await a.setSoul(channel, "fresh");
      await a.setEgress(channel, { allowedHosts: ["x.example"] });
      await a.setApprovedHarnesses(["pi"]);
      await a.setAutoFlaggerConfig({ harnessId: "pi", modelId: "m", rubric: "r" });
      assert.equal(b.getSoul(channel), null);
      await b.refreshScope(channel);
      await b.refreshScope(org);
      assert.equal(b.getSoul(channel), "fresh");
      assert.deepEqual(b.getEgress(channel), { allowedHosts: ["x.example"] });
      assert.deepEqual(b.getApprovedHarnesses(), ["pi"]);
      assert.deepEqual(b.getAutoFlaggerConfig(), { harnessId: "pi", modelId: "m", rubric: "r" });
    });
  });
});

test("SOUL compare-and-set admits one writer and setSoul ignores a stale cache", { skip }, async () => {
  await withConfigDb(async ({ tenant, store }) => {
    const a = await store(tenant);
    const b = await store(tenant);
    await withTenant(tenant, async () => {
      const results = await Promise.all([
        a.setSoulIfVersion(channel, 0, "left", "U1"),
        b.setSoulIfVersion(channel, 0, "right", "U2"),
      ]);
      assert.deepEqual(
        results.filter((v) => v !== null),
        [1],
      );
      assert.equal(await b.setSoul(channel, "after"), 2, "a stale cache still takes the next durable version");
      assert.equal(await a.setSoulIfVersion(channel, 1, "late"), null);
      assert.equal(a.soulVersion(org), 1, "the org default soul counts as version 1");
      assert.equal(await a.setSoul(org, "org soul"), 2);
      for (let i = 0; i < 30; i++) await a.setSoul(channel, `v${i}`);
      const history = a.soulHistory(channel);
      assert.equal(history.length, 25);
      assert.equal(history[0]?.content, "v29");
      assert.equal(history[0]?.version, 32);
    });
  });
});

test("concurrent runtime writes on two cores keep distinct revisions and both choices", { skip }, async () => {
  await withConfigDb(async ({ tenant, store }) => {
    const a = await store(tenant);
    const b = await store(tenant);
    await withTenant(tenant, async () => {
      await Promise.all([
        a.setRuntimeSelection(org, { harnessId: "pi", modelId: "one" }),
        b.setRuntimeSelection(org, { harnessId: "pi", modelId: "two" }),
        b.setPurposeRuntime("cron", { harnessId: "pi", modelId: "cron" }),
      ]);
      assert.equal((await a.getRuntimeSelectionDurable(org))?.revision, 2);
      assert.deepEqual(await a.getPurposeRuntimeDurable("cron"), { harnessId: "pi", modelId: "cron" });
      await Promise.all([
        a.acknowledgeRuntimeSelection(channel),
        b.setRuntimeSelection(channel, { harnessId: "pi", modelId: "new" }),
      ]);
      const chosen = await a.getRuntimeSelectionDurable(channel);
      assert.equal(chosen?.modelId, "new");
      assert.equal(chosen?.orgRevision, 2);
    });
  });
});

test("a tenant never reads or overwrites another tenant's configuration", { skip }, async () => {
  await withConfigDb(async ({ tenant, otherTenant, store, admin, url }) => {
    const mine = await store(tenant);
    await withTenant(tenant, async () => {
      await mine.setSoul(channel, "tenant soul");
      await mine.setEgress(channel, { allowedHosts: ["mine.example"] });
      await mine.setSharingPosture(org, "open");
      await mine.setPurposeRuntime("cron", { harnessId: "pi", modelId: "mine" });
      await mine.setConnectorClient(org, "google", { clientId: "mine", clientSecret: "s" });
      await mine.setSlackEmojiCatalog(channel, { a: "b" });
    });
    const theirs = await store(otherTenant);
    await withTenant(otherTenant, async () => {
      assert.equal(theirs.getSoul(channel), null);
      assert.equal(theirs.getEgress(channel), null);
      assert.equal(await theirs.getSharingPostureDurable(org), "isolated");
      assert.equal(theirs.getPurposeRuntime("cron"), undefined);
      assert.deepEqual(await theirs.listConnectorClients(org), []);
      assert.equal(await theirs.getSlackEmojiCatalogDurable(channel), null);
      assert.equal(await theirs.setSoul(channel, "their soul"), 1);
      await theirs.setEgress(channel, { allowedHosts: ["theirs.example"] });
    });
    await withTenant(tenant, async () => {
      await mine.refreshScope(channel);
      assert.equal(mine.getSoul(channel), "tenant soul");
      assert.deepEqual(mine.getEgress(channel), { allowedHosts: ["mine.example"] });
    });
    assert.throws(() => mine.getSoul(channel), /No tenant is bound/);
    const app = createPgPool(url);
    try {
      const scopes = (bound: string) =>
        withTenant(bound, () => app.q(`SELECT scope_id FROM scope_settings ORDER BY scope_id`));
      assert.deepEqual(await scopes(tenant), [{ scope_id: channel }, { scope_id: org }]);
      assert.deepEqual(await scopes(otherTenant), [{ scope_id: channel }]);
      await assert.rejects(app.q(`SELECT scope_id FROM scope_settings`), /No tenant is bound/);
      await assert.rejects(
        withTenant(otherTenant, () =>
          app.q(`INSERT INTO soul_revisions(tenant_id, scope_id, version, content) VALUES ($1, 'x', 1, 'x')`, [tenant]),
        ),
        /row-level security/,
      );
    } finally {
      await app.close();
    }
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
        WHERE c.relname IN ('scope_settings', 'soul_revisions', 'purpose_runtimes', 'connector_clients',
                            'slack_emoji_catalog', 'operator_settings')
          AND c.relnamespace = current_schema()::regnamespace
        ORDER BY c.relname`,
    );
    assert.deepEqual(rows, [
      { relname: "connector_clients", relrowsecurity: true, policies: 2 },
      { relname: "operator_settings", relrowsecurity: false, policies: 0 },
      { relname: "purpose_runtimes", relrowsecurity: true, policies: 2 },
      { relname: "scope_settings", relrowsecurity: true, policies: 2 },
      { relname: "slack_emoji_catalog", relrowsecurity: true, policies: 2 },
      { relname: "soul_revisions", relrowsecurity: true, policies: 2 },
    ]);
  });
});

test("an unhydrated tenant fails closed on cached reads", { skip }, async () => {
  await withConfigDb(async ({ tenant, otherTenant, store }) => {
    const config = await store(tenant);
    await withTenant(otherTenant, async () => {
      assert.throws(() => config.getEgress(channel), /has not been loaded/);
      assert.equal(await config.getSecurityPostureDurable(channel), "auto");
    });
  });
});

const seedLegacyConfig = async (admin: Parameters<typeof seedKeyValueTable>[0]) => {
  await seedKeyValueTable(admin, "soul_configs", {
    [channel]: {
      scopeId: channel,
      content: "current",
      version: 3,
      updatedAt: 3000,
      updatedBy: "U1",
      history: [{ scopeId: channel, content: "two", version: 2, updatedAt: 2000 }],
    },
  });
  await seedKeyValueTable(admin, "soul_history", {
    [`${channel}:1`]: { scopeId: channel, content: "one", version: 1, updatedAt: 1000 },
    [`${personal}:1`]: { scopeId: personal, content: "orphan", version: 1, updatedAt: 1000 },
  });
  await seedKeyValueTable(admin, "egress_policies", {
    [channel]: { scopeId: channel, policy: { allowedHosts: ["a.example"], denyPrivateNetworks: true } },
  });
  await seedKeyValueTable(admin, "command_policies", {
    [channel]: { scopeId: channel, policy: { mode: "allowlist", rules: [{ pattern: "ls", decision: "allow" }] } },
  });
  await seedKeyValueTable(admin, "approval_grant_modes", {
    [channel]: { scopeId: channel, modes: { session: false, always: true } },
  });
  await seedKeyValueTable(admin, "org_ambient_flag", { [org]: { scopeId: org, on: false } });
  await seedKeyValueTable(admin, "individual_model_auth_flag", {
    [org]: { scopeId: org, on: true },
    [personal]: { scopeId: personal, on: true, provider: "anthropic" },
  });
  await seedKeyValueTable(admin, "branding_configs", { [org]: { scopeId: org, branding: { accent: "#fff" } } });
  await seedKeyValueTable(admin, "base_model_configs", {
    [org]: {
      scopeId: org,
      harnessId: "pi",
      modelId: "org-model",
      revision: 4,
      orgRevision: 4,
      embeddingModelId: "embed-1",
      cronRuntime: { harnessId: "pi", modelId: "cron-model", fastMode: true },
    },
    [channel]: { scopeId: channel, harnessId: "pi", modelId: "chan-model", orgRevision: 3 },
  });
  await seedKeyValueTable(admin, "approved_harness_configs", { [org]: { scopeId: org, ids: ["pi", "claude"] } });
  await seedKeyValueTable(admin, "auto_flagger_configs", {
    [org]: { scopeId: org, harnessId: "pi", modelId: "flag-model", rubric: "be careful" },
  });
  await seedKeyValueTable(admin, "connector_clients", {
    [`${org}|google`]: {
      scopeId: org,
      provider: "google",
      clientId: "legacy-client",
      secretEnc: "opaque",
      redirectAllowlist: ["https://a.example"],
      enabled: false,
      updatedAt: 5000,
    },
  });
  await seedKeyValueTable(admin, "slack_emoji_catalog", {
    [channel]: { scopeId: channel, emoji: { wave: "https://e.example/w.png" }, updatedAt: 6000 },
  });
};

test(
  "the conversion backfills every config table into the instance tenant and drops the old tables",
  { skip },
  async () => {
    await withConfigDb(async ({ tenant, otherTenant, store, admin, url }) => {
      const config = await store(tenant);
      await withTenant(tenant, async () => {
        assert.equal(config.getSoul(channel), "current");
        assert.deepEqual(
          config.soulHistory(channel).map((r) => [r.version, r.content, r.updatedAt]),
          [
            [3, "current", 3000],
            [2, "two", 2000],
            [1, "one", 1000],
          ],
        );
        assert.equal(config.getSoul(personal), null, "history rows without a current soul are not resurrected");
        assert.deepEqual(config.getEgress(channel), { allowedHosts: ["a.example"], denyPrivateNetworks: true });
        assert.deepEqual(config.getCommandPolicy(channel), {
          mode: "allowlist",
          rules: [{ pattern: "ls", decision: "allow" }],
        });
        assert.deepEqual(config.getApprovalGrantModes(channel), { session: false, always: true });
        assert.equal(config.getOrgAmbient(), false);
        assert.equal(await config.getModelAccountDurable("U1"), "anthropic");
        assert.equal(await config.getModelAccountDurable("U9"), "personal");
        assert.deepEqual(config.getBranding(org), { accent: "#fff" });
        assert.deepEqual(config.getRuntimeSelection(org), {
          harnessId: "pi",
          modelId: "org-model",
          revision: 4,
          orgRevision: 4,
        });
        assert.equal(config.getRuntimeSelection(channel)?.orgRevision, 3);
        assert.deepEqual(config.getPurposeRuntime("cron"), { harnessId: "pi", modelId: "cron-model", fastMode: true });
        assert.equal(await config.getEmbeddingModelDurable(), "embed-1");
        assert.deepEqual(config.getApprovedHarnesses(), ["pi", "claude"]);
        assert.deepEqual(config.getAutoFlaggerConfig(), {
          harnessId: "pi",
          modelId: "flag-model",
          rubric: "be careful",
        });
        assert.deepEqual(await config.getSlackEmojiCatalogDurable(channel), {
          scopeId: channel,
          emoji: { wave: "https://e.example/w.png" },
          updatedAt: 6000,
        });
      });
      const tables = createPostgresConfigTables(url);
      try {
        assert.deepEqual(await withTenant(tenant, () => tables.connectorClient(org, "google")), {
          scopeId: org,
          provider: "google",
          clientId: "legacy-client",
          secretEnc: "opaque",
          redirectAllowlist: ["https://a.example"],
          enabled: false,
          updatedAt: 5000,
        });
        assert.equal(await withTenant(otherTenant, () => tables.connectorClient(org, "google")), null);
      } finally {
        await tables.close!();
      }
      const { rows } = await admin.query(
        `SELECT to_regclass('soul_configs') IS NULL AND to_regclass('soul_history') IS NULL
            AND to_regclass('base_model_configs') IS NULL
            AND to_regclass('connector_clients_kv') IS NULL AND to_regclass('slack_emoji_catalog_kv') IS NULL AS dropped,
              (SELECT count(*)::int FROM durable_map_versions) AS versions`,
      );
      assert.deepEqual(rows, [{ dropped: true, versions: 0 }]);
    }, seedLegacyConfig);
  },
);
