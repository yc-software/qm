import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresModelTables } from "../src/model/model-tables.ts";
import { createModelCredentialStore } from "../src/model/model-credential-store.ts";
import { createCustomProviderStore } from "../src/model/custom-provider-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const UPDATED_AT = 1_700_000_000_000;
const SPEC = {
  id: "acme",
  name: "Acme",
  protocol: "openai" as const,
  baseUrl: "https://acme.example/v1",
  models: [{ id: "acme-large" }],
};

test("model credentials and custom providers round-trip and stay inside their tenant", { skip }, async () => {
  await withTypedTableDb(createPostgresModelTables, async ({ store, tenant, otherTenant }) => {
    const credentials = createModelCredentialStore({ backing: store.credentials, keyMaterial: "model-key" });
    const providers = createCustomProviderStore({ backing: store.customProviders, keyMaterial: "model-key" });
    await withTenant(tenant, async () => {
      await credentials.set("openai", "sk-tenant", "admin");
      await providers.upsert(SPEC, "acme-key", "admin");
      await providers.upsert({ ...SPEC, id: "gone", name: "Gone" }, undefined, "admin");
      assert.equal(await providers.delete("gone", "admin"), true);
    });
    await withTenant(otherTenant, async () => {
      assert.equal(await credentials.resolve("openai"), null);
      assert.deepEqual(await providers.statuses(), []);
      assert.equal(await providers.resolveKey("acme"), null);
    });
    await withTenant(tenant, async () => {
      assert.equal(await credentials.resolve("openai"), "sk-tenant");
      assert.deepEqual(
        (await providers.enabled()).map((p) => p.id),
        ["acme"],
      );
      assert.deepEqual(
        (await providers.statuses()).map((p) => [p.id, p.disabled, p.hasKey]),
        [
          ["acme", false, true],
          ["gone", true, false],
        ],
      );
      assert.equal(await providers.resolveKey("acme"), "acme-key");
      await credentials.delete("openai", "admin");
      assert.equal(await credentials.resolve("openai"), null);
    });
  });
});

test("model registry rows keep their spec and verification per tenant", { skip }, async () => {
  await withTypedTableDb(createPostgresModelTables, async ({ store, tenant, otherTenant }) => {
    const row = {
      spec: { id: "m1", name: "M1", provider: "openai", template: "gpt-5.5" },
      disabled: false,
      updatedAt: UPDATED_AT,
      updatedBy: "admin",
      verification: { fingerprint: "fp", verifiedAt: UPDATED_AT, revision: "r1" },
    } as Parameters<typeof store.registry.put>[1];
    await withTenant(tenant, () => store.registry.put("m1", row));
    assert.deepEqual(await withTenant(tenant, () => store.registry.get("m1")), row);
    assert.deepEqual(await withTenant(tenant, () => store.registry.all()), [{ id: "m1", row }]);
    assert.equal(await withTenant(otherTenant, () => store.registry.get("m1")), null);
    assert.deepEqual(await withTenant(otherTenant, () => store.registry.all()), []);
  });
});

test("the conversion backfills model tables into the instance tenant and drops the old tables", { skip }, async () => {
  await withTypedTableDb(
    createPostgresModelTables,
    async ({ store, admin, tenant }) => {
      await withTenant(tenant, async () => {
        assert.deepEqual(await store.credentials.get("anthropic"), {
          provider: "anthropic",
          secretEnc: "enc",
          disabled: false,
          updatedAt: UPDATED_AT,
          updatedBy: "admin",
        });
        assert.deepEqual(await store.customProviders.get("acme"), {
          ...SPEC,
          apiKeyEnc: "key-enc",
          disabled: true,
          updatedAt: UPDATED_AT,
          updatedBy: "admin",
        });
        assert.deepEqual(await store.registry.get("m1"), {
          spec: { id: "m1", name: "M1" },
          disabled: false,
          updatedAt: UPDATED_AT,
          updatedBy: "admin",
          verification: { fingerprint: "fp", verifiedAt: UPDATED_AT, revision: "r1" },
        });
      });
      const { rows } = await admin.query(
        `SELECT to_regclass('model_credentials_kv') IS NULL AND to_regclass('custom_model_providers_kv') IS NULL
                  AND to_regclass('model_registry_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions) AS versions,
                (SELECT count(*)::int FROM model_registry) AS registry`,
      );
      assert.deepEqual(rows, [{ dropped: true, versions: 0, registry: 1 }]);
    },
    async (admin) => {
      await seedKeyValueTable(admin, "model_credentials", {
        anthropic: { provider: "anthropic", secretEnc: "enc", updatedAt: UPDATED_AT, updatedBy: "admin" },
      });
      await seedKeyValueTable(admin, "custom_model_providers", {
        acme: { ...SPEC, apiKeyEnc: "key-enc", disabled: true, updatedAt: UPDATED_AT, updatedBy: "admin" },
      });
      await seedKeyValueTable(admin, "model_registry", {
        m1: {
          spec: { id: "m1", name: "M1" },
          disabled: false,
          updatedAt: UPDATED_AT,
          updatedBy: "admin",
          verification: { fingerprint: "fp", verifiedAt: UPDATED_AT, revision: "r1" },
        },
        broken: { disabled: false },
      });
    },
  );
});
