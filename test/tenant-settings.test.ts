import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withTenant } from "../src/tenants/context.ts";
import {
  createTenantSettingsStore,
  openTenantSecret,
  requireTenantSetting,
  sealTenantSecret,
  tenantSettingsKey,
  TenantSettingMissingError,
} from "../src/tenants/settings.ts";

test("each tenant reads only the settings written under its own binding", async () => {
  const store = createTenantSettingsStore({ harness: "pi" });
  const a = randomUUID();
  const b = randomUUID();
  await withTenant(a, () => store.update({ SPRITES_TOKEN: "token-a", SANDBOX_BACKEND: "sprites" }));
  await withTenant(b, () => store.update({ E2B_API_KEY: "key-b", SANDBOX_BACKEND: "e2b" }));
  const seenByA = await withTenant(a, () => store.get());
  const seenByB = await withTenant(b, () => store.get());
  assert.equal(seenByA.values.SPRITES_TOKEN, "token-a");
  assert.equal(seenByA.values.E2B_API_KEY, undefined);
  assert.equal(seenByA.sandboxBackend, "sprites");
  assert.equal(seenByB.values.SPRITES_TOKEN, undefined);
  assert.equal(seenByB.sandboxBackend, "e2b");
});

test("reading settings with no tenant bound fails closed", async () => {
  const store = createTenantSettingsStore({ harness: "pi" });
  await assert.rejects(async () => store.get(), /No tenant is bound/);
  await assert.rejects(async () => store.update({ PI_MODEL: "x" }), /No tenant is bound/);
});

test("a missing setting fails closed with the setting's name", async () => {
  const store = createTenantSettingsStore({ harness: "pi" });
  const settings = await withTenant(randomUUID(), () => store.get());
  assert.throws(
    () => requireTenantSetting(settings, "SPRITES_TOKEN"),
    (error: unknown) =>
      error instanceof TenantSettingMissingError &&
      error.message === "SPRITES_TOKEN is not set in this tenant's settings",
  );
});

test("updates are validated against the merged settings and empty values clear", async () => {
  const store = createTenantSettingsStore({ harness: "pi" });
  await withTenant(randomUUID(), async () => {
    await assert.rejects(store.update({ SANDBOX_BACKEND: "nope" }), /SANDBOX_BACKEND="nope" is not recognized/);
    await assert.rejects(store.update({ MODEL_GATEWAY_URL: "https://gw.example" }), /MODEL_GATEWAY_API_KEY is required/);
    await assert.rejects(store.update({ NOT_A_SETTING: "x" } as never), /NOT_A_SETTING is not a tenant setting/);
    await store.update({ PI_MODEL: "model-a" });
    assert.equal((await store.get()).piModel, "model-a");
    await store.update({ PI_MODEL: "" });
    assert.equal((await store.get()).piModel, undefined);
  });
});

test("a sealed secret opens only for the tenant and setting it was sealed for", () => {
  const key = tenantSettingsKey("k".repeat(32));
  const tenant = randomUUID();
  const sealed = sealTenantSecret(key, tenant, "SPRITES_TOKEN", "secret");
  assert.equal(openTenantSecret(key, tenant, "SPRITES_TOKEN", sealed), "secret");
  assert.throws(() => openTenantSecret(key, randomUUID(), "SPRITES_TOKEN", sealed));
  assert.throws(() => openTenantSecret(key, tenant, "E2B_API_KEY", sealed));
  assert.throws(() => openTenantSecret(tenantSettingsKey("x".repeat(32)), tenant, "SPRITES_TOKEN", sealed));
});
