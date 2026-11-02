import assert from "node:assert/strict";
import { settingsDatabase, testSettingsStore, TEST_SETTINGS_KEY, THIRD_TENANT } from "./support/tenant-settings.ts";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import { createTenantSettingsStore, requireTenantSetting, TenantSettingMissingError } from "../src/tenants/settings.ts";

test("reading settings with no tenant bound fails closed", async () => {
  const store = await testSettingsStore();
  await withoutTenant(async () => {
    await assert.rejects(async () => store.get(), /No tenant is bound/);
    await assert.rejects(async () => store.update({ PI_MODEL: "x" }), /No tenant is bound/);
  });
});

test("a missing setting fails closed with the setting's name", async () => {
  const store = await testSettingsStore();
  const settings = await withTenant(THIRD_TENANT, () => store.get());
  assert.throws(
    () => requireTenantSetting(settings, "SPRITES_TOKEN"),
    (error: unknown) =>
      error instanceof TenantSettingMissingError &&
      error.message === "SPRITES_TOKEN is not set in this tenant's settings",
  );
});

test("updates are validated against the merged settings and empty values clear", async () => {
  const store = await testSettingsStore();
  await withTenant(THIRD_TENANT, async () => {
    await assert.rejects(store.update({ SANDBOX_BACKEND: "nope" }), /SANDBOX_BACKEND="nope" is not recognized/);
    await assert.rejects(
      store.update({ MODEL_GATEWAY_URL: "https://gw.example" }),
      /MODEL_GATEWAY_API_KEY is required/,
    );
    await assert.rejects(store.update({ NOT_A_SETTING: "x" } as never), /NOT_A_SETTING is not a tenant setting/);
    await store.update({ PI_MODEL: "model-a" });
    assert.equal((await store.get()).piModel, "model-a");
    await store.update({ PI_MODEL: "" });
    assert.equal((await store.get()).piModel, undefined);
  });
});

test("a change saved by one process reaches another process's cached settings", async () => {
  const { url, ready } = settingsDatabase();
  await ready;
  const writer = createTenantSettingsStore({ databaseUrl: url, keyMaterial: TEST_SETTINGS_KEY });
  const reader = createTenantSettingsStore({ databaseUrl: url, keyMaterial: TEST_SETTINGS_KEY });
  await withTenant(THIRD_TENANT, () => writer.update({ PI_MODEL: "model-a" }));
  reader.start();
  try {
    await withTenant(THIRD_TENANT, async () => {
      assert.equal((await reader.get()).piModel, "model-a");
      await writer.update({ PI_MODEL: "model-b" });
      for (let i = 0; i < 100 && (await reader.get()).piModel !== "model-b"; i++) await sleep(50);
      assert.equal((await reader.get()).piModel, "model-b");
    });
  } finally {
    await reader.stop();
  }
});
