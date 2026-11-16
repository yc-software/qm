import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { legacySandboxBackendForScope } from "../src/sandbox/sandbox-resource-upgrade.ts";
import { createSandboxResources, type SandboxDefault, type SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter, type SandboxBackendName } from "../src/sandbox/sandbox-routing.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import {
  tenantNamePrefix,
  tenantSandboxChoice,
  tenantSuperserveSandbox,
  type SuperserveShape,
} from "../src/sandbox/tenant-sandbox-shape.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { withTenant } from "../src/tenants/context.ts";
import { loadTenantSettings, tenantSettingsSchema } from "../src/tenants/settings.ts";
import { scopeId } from "../src/types.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createSuperserveSandbox, type StoredSuperserveSandbox } from "../src/sandbox/superserve-sandbox.ts";
import { installFakeSuperserve } from "./support/fake-superserve.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testAdvisoryLock } from "./support/test-database.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

const scope = scopeId("personal", "shared@example.com");
const deployment = { backend: "sprites" as const, scopeBackends: { personal: "modal" as const } };

before(() => bindBootTenant(async () => undefined));

function fakeBackend(name: string, provisioned: string[]): Sandbox {
  const handle = (): SandboxHandle => ({ id: `${name}-box`, rootDir: "/w" });
  return {
    profile: { backend: name, writablePersistence: "resident_disk", processSessions: false },
    provision: async () => (provisioned.push(name), handle()),
    run: async () => ({ stdout: name, stderr: "", code: 0, timedOut: false }),
    readFile: async () => null,
    writeFile: async () => {},
    writeFileBytes: async () => {},
    readFileBytes: async () => null,
    listDir: async () => [],
    removeDir: async () => {},
    teardown: async () => {},
  };
}

test("tenant sandbox settings accept backend names and scope kinds only", () => {
  const ok = { sandboxBackend: "superserve", sandboxScopeBackends: { personal: "sprites", channel: "modal" } };
  assert.deepEqual(tenantSettingsSchema.parse(ok), ok);
  assert.throws(() => tenantSettingsSchema.parse({ sandboxBackend: "vm" }));
  assert.throws(() => tenantSettingsSchema.parse({ sandboxScopeBackends: { personal: "vm" } }));
  assert.throws(() => tenantSettingsSchema.parse({ sandboxScopeBackends: { desk: "sprites" } }));
});

describeTwoTenants("per-tenant sandbox backend", (db) => {
  const set = async (tenant: string, settings: object) => {
    await db.owner.q("UPDATE tenants SET settings = $2::jsonb WHERE id = $1", [tenant, JSON.stringify(settings)]);
    await withTenant(tenant, () => loadTenantSettings(db.app));
  };

  before(async () => {
    const [a, b] = db.tenants;
    await set(a, { sandboxBackend: "superserve", superserveApiKey: "moved-key", superserveTemplate: "moved-tpl" });
    await set(b, {});
  });

  test("a tenant's backend replaces the deployment's for every scope; others keep the deployment's", async () => {
    const [a, b] = db.tenants;
    const choiceA = await withTenant(a, () => tenantSandboxChoice(deployment));
    assert.deepEqual(choiceA, { backend: "superserve", scopeBackends: {} });
    assert.equal(legacySandboxBackendForScope(scope, choiceA.backend, choiceA.scopeBackends), "superserve");
    assert.deepEqual(await withTenant(b, () => tenantSandboxChoice(deployment)), deployment);
  });

  test("a tenant's scope backends replace the deployment's scope map", async () => {
    const [, b] = db.tenants;
    await set(b, { sandboxScopeBackends: { personal: "sprites", channel: "superserve" } });
    try {
      const choice = await withTenant(b, () => tenantSandboxChoice(deployment));
      assert.deepEqual(choice, { backend: "sprites", scopeBackends: { personal: "sprites", channel: "superserve" } });
      const channel = scopeId("channel", "C1");
      assert.equal(legacySandboxBackendForScope(channel, choice.backend, choice.scopeBackends), "superserve");
      assert.equal(legacySandboxBackendForScope(scopeId("org", "o"), choice.backend, choice.scopeBackends), "sprites");
    } finally {
      await set(b, {});
    }
  });

  test("backend choice fails closed without a bound tenant or with unloaded settings", async () => {
    await assert.rejects(tenantSandboxChoice(deployment), /needs a bound tenant/);
    await assert.rejects(
      withTenant(randomUUID(), () => tenantSandboxChoice(deployment)),
      /settings are not loaded/,
    );
  });

  test("new computers route to the tenant's backend and an unavailable one is refused", async () => {
    const [a, b] = db.tenants;
    const provisioned: string[] = [];
    const backends: Partial<Record<SandboxBackendName, Sandbox>> = {
      sprites: fakeBackend("sprites", provisioned),
      superserve: fakeBackend("superserve", provisioned),
    };
    const resources = createSandboxResources({
      records: db.maps.map<SandboxResource>("sandbox_resources"),
      loads: db.maps.map("sandbox_loads"),
      defaults: db.maps.map<SandboxDefault>("sandbox_defaults"),
      backends,
      defaultBackend: "sprites",
      lock: testAdvisoryLock(),
      canUseScope: async () => true,
    });
    const router = createSandboxRouter({ backends, defaultBackend: "sprites", resources });
    assert.equal(await withTenant(a, () => resources.defaultBackend()), "superserve");
    assert.equal(await withTenant(b, () => resources.defaultBackend()), "sprites");
    await withTenant(a, () => router.provision(scope, { scratch: { key: "k" } }));
    await withTenant(b, () => router.provision(scope, { scratch: { key: "k" } }));
    assert.deepEqual(provisioned, ["superserve", "sprites"]);
    const record = await withTenant(a, () => resources.create("u", scope, "superserve"));
    assert.equal(record.backend, "superserve");
    await set(b, { sandboxBackend: "modal" });
    try {
      await assert.rejects(
        withTenant(b, () => resources.defaultBackend()),
        /sandbox backend unavailable: modal; this deployment does not run it/,
      );
    } finally {
      await set(b, {});
    }
  });

  test("Superserve uses the tenant's own key, template and prefix, else the deployment key with a tenant prefix", async () => {
    const [a, b] = db.tenants;
    const made: SuperserveShape[] = [];
    const ran: string[] = [];
    const sandbox = tenantSuperserveSandbox(
      { apiKey: "deploy-key", namePrefix: "qm", template: "deploy-tpl" },
      (shape) => {
        made.push(shape);
        return {
          ...fakeBackend("superserve", []),
          run: async () => (ran.push(shape.apiKey), { stdout: shape.apiKey, stderr: "", code: 0, timedOut: false }),
        };
      },
    );
    const handle: SandboxHandle = { id: "x", rootDir: "/w" };
    await withTenant(a, () => sandbox.run(handle, "true"));
    await withTenant(b, () => sandbox.run(handle, "true"));
    await withTenant(a, () => sandbox.run(handle, "true"));
    assert.deepEqual(ran, ["moved-key", "deploy-key", "moved-key"]);
    assert.deepEqual(made, [
      { apiKey: "deploy-key", namePrefix: "qm", template: "deploy-tpl" },
      { apiKey: "moved-key", namePrefix: tenantNamePrefix("qm", a), template: "moved-tpl" },
      { apiKey: "deploy-key", namePrefix: tenantNamePrefix("qm", b), template: "deploy-tpl" },
    ]);
    await set(a, { superserveApiKey: "moved-key", superserveNamePrefix: "qm-moved", superserveTemplate: "moved-tpl" });
    try {
      await withTenant(a, () => sandbox.run(handle, "true"));
      assert.deepEqual(made.at(-1), { apiKey: "moved-key", namePrefix: "qm-moved", template: "moved-tpl" });
    } finally {
      await set(a, { sandboxBackend: "superserve", superserveApiKey: "moved-key", superserveTemplate: "moved-tpl" });
    }
  });

  test("Superserve without any key for the tenant is refused, and unbound work fails closed", async () => {
    const [a, b] = db.tenants;
    const sandbox = tenantSuperserveSandbox({ namePrefix: "qm", template: "deploy-tpl" }, () =>
      fakeBackend("superserve", []),
    );
    const handle: SandboxHandle = { id: "x", rootDir: "/w" };
    await assert.rejects(
      withTenant(b, () => sandbox.run(handle, "true")),
      /superserve has no API key for this tenant/,
    );
    assert.equal((await withTenant(a, () => sandbox.run(handle, "true"))).stdout, "superserve");
    await assert.rejects(sandbox.run(handle, "true"), /needs a bound tenant/);
  });

  test("the same scope reaches a differently named Superserve sandbox per tenant", async () => {
    const [a, b] = db.tenants;
    await set(a, { superserveApiKey: "moved-key", superserveNamePrefix: "qm-moved" });
    const fake = installFakeSuperserve();
    try {
      const keys: string[] = [];
      const sandbox = tenantSuperserveSandbox({ apiKey: "deploy-key", namePrefix: "qmt" }, ({ apiKey, namePrefix }) => {
        keys.push(apiKey);
        return createSuperserveSandbox({
          store: db.maps.map<StoredSuperserveSandbox>("superserve_sandbox_bodies"),
          ...singleProcessDeps(),
          client: fake.client,
          namePrefix,
          configEpoch: 1,
        });
      });
      const ha = await withTenant(a, () => sandbox.provision(scope));
      const hb = await withTenant(b, () => sandbox.provision(scope));
      assert.equal(ha.id, sandboxScopeName("qm-moved", scope));
      assert.equal(hb.id, sandboxScopeName(tenantNamePrefix("qmt", b), scope));
      assert.equal((await withTenant(a, () => sandbox.run(ha, "echo a"))).stdout.trim(), "a");
      assert.equal((await withTenant(b, () => sandbox.run(hb, "echo b"))).stdout.trim(), "b");
      assert.deepEqual(keys, ["deploy-key", "moved-key", "deploy-key"]);
    } finally {
      fake.cleanup();
      await set(a, { sandboxBackend: "superserve", superserveApiKey: "moved-key", superserveTemplate: "moved-tpl" });
    }
  });
});
