import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/wiring.ts";
import { fakeSprites } from "./support/auto-fake-sprites.ts";

for (const legacyFlag of [undefined, "false"]) {
  test(`production startup activates sandbox resources with legacy flag ${legacyFlag ?? "absent"}`, async () => {
    const built = buildApp(
      loadConfig({
        NODE_ENV: "production",
        CORE_SIGNING_SECRET: "core-signing-secret-0123456789abcdef",
        SKILL_SIGNING_SECRET: "skill-signing-secret-0123456789abcdef",
        CAPABILITY_SECRET: "capabilities",
        PORTAL_IDENTITY_SECRET: "portal",
        CONNECTOR_SECRET_KEY: "connector-secret-0123456789abcdef",
        SANDBOX_BACKEND: "sprites",
        SPRITES_TOKEN: "test-token",
        DATA_DIR: mkdtempSync(join(tmpdir(), "sandbox-startup-")),
        ...(legacyFlag === undefined ? {} : { SANDBOX_RESOURCES_ENABLED: legacyFlag }),
      }),
    );
    try {
      await built.sessions.getOrCreateByThread("existing", "dm", "personal:existing");
      const existingId = await built.sandboxResources.recordLegacy("personal:existing", "sprites", {
        id: "recorded-machine",
        rootDir: "/workspace",
      });
      const before = fakeSprites.calls.length;
      await built.sandboxResources.initialize();
      const existing = await built.sandboxResources.resolve("personal:existing");
      assert.equal(existing?.id, existingId);
      assert.equal(existing?.machineId, "recorded-machine");
      assert.equal(existing?.backingScopeId, "personal:existing");
      assert.equal(await built.sandboxResources.resolve("personal:new"), null);
      const inventory = await built.sandboxResources.list("new", "personal:new");
      assert.equal(inventory.defaultSandboxId, null);
      assert.ok(inventory.providers.some((provider) => provider.name === "sprites"));
      await assert.rejects(
        built.sandbox.provision([{ scopeId: "personal:new", mountPath: "/", mode: "rw" }]),
        /no default sandbox/,
      );
      await built.sandboxResources.setDefault("existing", "personal:existing", null);
      await built.sandboxResources.initialize();
      assert.equal(await built.sandboxResources.resolve("personal:existing"), null);
      assert.equal(fakeSprites.calls.length, before);
    } finally {
      await built.runtime.stop();
    }
  });
}
