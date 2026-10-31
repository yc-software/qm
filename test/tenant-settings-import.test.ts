import assert from "node:assert/strict";
import test from "node:test";
import { testFeatureFlagStore } from "./support/typed-stores.ts";
import { createModelCredentialStore } from "../src/model/model-credential-store.ts";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import { importTenantSettings, tenantEnvPresent } from "../src/tenants/settings-import.ts";
import { scopeId } from "../src/types.ts";
import { testConfigStore, testMap } from "./support/test-database.ts";
import { testSettingsStore, THIRD_TENANT } from "./support/tenant-settings.ts";
import { testModelTables } from "./support/typed-stores.ts";

const KEY = "import-test-connector-key-0123456789";
const root = scopeId("org", "acme");

async function deps() {
  return {
    settings: await testSettingsStore(),
    modelCredentials: createModelCredentialStore({ backing: testModelTables().credentials, keyMaterial: KEY }),
    featureFlags: testFeatureFlagStore(),
    config: testConfigStore({ connectorSecretKey: KEY }),
    rootScope: root,
    actor: "import-test",
  };
}

test("the import copies env values into the tenant's settings and the stores that already own them", async () => {
  const d = await deps();
  await withTenant(THIRD_TENANT, async () => {
    const updated = await importTenantSettings(
      {
        SPRITES_TOKEN: "sprites-token",
        SANDBOX_BACKEND: "sprites",
        PI_MODEL: "claude-opus-5-5",
        ANTHROPIC_API_KEY: "anthropic-key",
        HARNESS_SECURITY_POSTURE: "strict",
        HARNESS_SHARING_POSTURE: "open",
        ORG_BRAND_ORG_NAME: "Acme",
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_WORKSPACE_DOMAIN: "acme.test",
      },
      d,
    );
    assert.equal(updated.length, 10);
    const settings = await d.settings.get();
    assert.equal(settings.values.SPRITES_TOKEN, "sprites-token");
    assert.equal(settings.sandboxBackend, "sprites");
    assert.equal(settings.piModel, "claude-opus-5-5");
    assert.equal(await d.modelCredentials.resolve("anthropic"), "anthropic-key");
    assert.equal(await d.config.getSecurityPostureDurable(root), "strict");
    assert.equal(await d.config.getSharingPostureDurable(root), "open");
    assert.deepEqual(await d.config.getBrandingDurable(root), { orgName: "Acme" });
    const client = await d.config.getConnectorClientSecret(root, "google");
    assert.equal(client?.clientId, "client-id");
    assert.equal(client?.clientSecret, "client-secret");
    assert.equal(client?.hostedDomain, "acme.test");
  });
});

test("the import rejects keys that are not tenant settings and leaves nothing half-written", async () => {
  const d = await deps();
  await withTenant(THIRD_TENANT, async () => {
    await assert.rejects(
      importTenantSettings({ SPRITES_TOKEN: "t", DATABASE_URL: "postgres://x", CORE_SIGNING_SECRET: "s" }, d),
      /Not tenant settings: DATABASE_URL, CORE_SIGNING_SECRET/,
    );
    await assert.rejects(importTenantSettings({ HARNESS_SECURITY_POSTURE: "lax" }, d), /is not recognized/);
    assert.equal((await d.settings.get()).values.SPRITES_TOKEN, undefined);
  });
});

test("the import needs a bound tenant", async () => {
  const d = await deps();
  await withoutTenant(() => assert.rejects(importTenantSettings({ PI_MODEL: "x" }, d), /No tenant is bound/));
});

test("boot names the tenant settings still present in the environment", () => {
  assert.deepEqual(tenantEnvPresent({ SPRITES_TOKEN: "t", ANTHROPIC_API_KEY: "k", DATABASE_URL: "x", PI_MODEL: " " }), [
    "SPRITES_TOKEN",
    "ANTHROPIC_API_KEY",
  ]);
});

test("the import never replaces values an admin already stored", async () => {
  const d = await deps();
  await withTenant(THIRD_TENANT, async () => {
    await d.modelCredentials.set("anthropic", "admin-key", "admin");
    await d.config.setSecurityPosture(root, "strict");
    await d.config.setBranding(root, { orgName: "Admin Name" });
    await d.config.setConnectorClient(root, "google", { clientId: "admin-id", clientSecret: "admin-secret" });
    await importTenantSettings(
      {
        ANTHROPIC_API_KEY: "env-key",
        OPENAI_API_KEY: "env-openai",
        HARNESS_SECURITY_POSTURE: "dangerous",
        ORG_BRAND_ORG_NAME: "Env Name",
        ORG_BRAND_ACCENT: "#ff6600",
        GOOGLE_OAUTH_CLIENT_ID: "env-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "env-secret",
      },
      d,
    );
    assert.equal(await d.modelCredentials.resolve("anthropic"), "admin-key");
    assert.equal(await d.modelCredentials.resolve("openai"), "env-openai");
    assert.equal(await d.config.getSecurityPostureDurable(root), "strict");
    assert.deepEqual(await d.config.getBrandingDurable(root), { orgName: "Admin Name", accent: "#ff6600" });
    assert.equal((await d.config.getConnectorClientSecret(root, "google"))?.clientId, "admin-id");
  });
});

test("the import turns the web UI allowlists into access flags once, lowercasing email ids", async () => {
  const d = await deps();
  await withTenant(THIRD_TENANT, async () => {
    await importTenantSettings(
      { WEB_UI_PRINCIPALS: "", LOOPS_USERS: "Ada@Example.com, bo@example.com", WEB_UI_VOICE_USERS: "all" },
      d,
    );
    assert.deepEqual((await d.featureFlags.get("web_ui"))?.enabledScopes, [root]);
    assert.deepEqual((await d.featureFlags.get("loops"))?.enabledScopes, [
      scopeId("personal", "ada@example.com"),
      scopeId("personal", "bo@example.com"),
    ]);
    assert.deepEqual((await d.featureFlags.get("voice"))?.enabledScopes, [root]);
    await d.featureFlags.setEnabled("web_ui", root, false, "admin");
    await importTenantSettings({ WEB_UI_PRINCIPALS: "", LOOPS_USERS: "cy@example.com" }, d);
    assert.deepEqual((await d.featureFlags.get("web_ui"))?.enabledScopes, []);
    assert.equal((await d.featureFlags.get("loops"))?.enabledScopes.length, 2);
  });
});

test("a listed web UI allowlist becomes per-person sign-in, and an absent one changes nothing", async () => {
  const d = await deps();
  await withTenant(THIRD_TENANT, async () => {
    await importTenantSettings({ WEB_UI_PRINCIPALS: "Ada@Example.com,U123" }, d);
    assert.deepEqual((await d.featureFlags.get("web_ui"))?.enabledScopes, [
      scopeId("personal", "ada@example.com"),
      scopeId("personal", "u123"),
    ]);
    assert.equal(await d.featureFlags.get("voice"), null);
    assert.equal(await d.featureFlags.get("loops"), null);
  });
});
