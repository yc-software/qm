import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createModelCredentialStore } from "../src/model/model-credential-store.ts";
import { memoryModelTables } from "../src/model/model-tables.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { createTenantSettingsStore } from "../src/tenants/settings.ts";
import { importTenantSettings, tenantEnvPresent } from "../src/tenants/settings-import.ts";
import { scopeId } from "../src/types.ts";

const KEY = "import-test-connector-key-0123456789";
const root = scopeId("org", "acme");

function deps() {
  return {
    settings: createTenantSettingsStore({ harness: "pi" }),
    modelCredentials: createModelCredentialStore({ backing: memoryModelTables().credentials, keyMaterial: KEY }),
    config: createMemoryConfigStore({ connectorSecretKey: KEY }),
    rootScope: root,
    actor: "import-test",
  };
}

test("the import copies env values into the tenant's settings and the stores that already own them", async () => {
  const d = deps();
  await withTenant(randomUUID(), async () => {
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
  const d = deps();
  await withTenant(randomUUID(), async () => {
    await assert.rejects(
      importTenantSettings({ SPRITES_TOKEN: "t", DATABASE_URL: "postgres://x", CORE_SIGNING_SECRET: "s" }, d),
      /Not tenant settings: DATABASE_URL, CORE_SIGNING_SECRET/,
    );
    await assert.rejects(importTenantSettings({ HARNESS_SECURITY_POSTURE: "lax" }, d), /is not recognized/);
    assert.equal((await d.settings.get()).values.SPRITES_TOKEN, undefined);
  });
});

test("the import needs a bound tenant", async () => {
  await assert.rejects(importTenantSettings({ PI_MODEL: "x" }, deps()), /No tenant is bound/);
});

test("boot names the tenant settings still present in the environment", () => {
  assert.deepEqual(tenantEnvPresent({ SPRITES_TOKEN: "t", ANTHROPIC_API_KEY: "k", DATABASE_URL: "x", PI_MODEL: " " }), [
    "SPRITES_TOKEN",
    "ANTHROPIC_API_KEY",
  ]);
});

test("the import never replaces values an admin already stored", async () => {
  const d = deps();
  await withTenant(randomUUID(), async () => {
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
