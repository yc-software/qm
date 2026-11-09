import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import type { ModalClient, ModalSession } from "../src/sandbox/modal-client.ts";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import {
  TenantKeyedMap,
  tenantModalClient,
  tenantModalNamePrefix,
  tenantNamePrefix,
  tenantSpritesShape,
  type ModalShape,
} from "../src/sandbox/tenant-sandbox-shape.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { withTenant } from "../src/tenants/context.ts";
import { loadTenantSettings } from "../src/tenants/settings.ts";
import { scopeId } from "../src/types.ts";
import { installFakeSprites, FAKE_SPRITES_TOKEN } from "./support/fake-sprites.ts";
import { testAdvisoryLock } from "./support/test-database.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

const scope = scopeId("personal", "shared@example.com");
const moved = {
  spritesToken: "moved-company-sprites-token",
  spritesNamePrefix: "qm-moved-sandbox",
  modalAppName: "qm-moved",
  modalEnvironment: "qm-moved",
  modalNamePrefix: "qm-moved",
};

before(() => bindBootTenant(async () => undefined));

describeTwoTenants("per-tenant sandbox shape", (db) => {
  before(async () => {
    const [a, b] = db.tenants;
    await db.owner.q("UPDATE tenants SET settings = $2::jsonb WHERE id = $1", [a, JSON.stringify(moved)]);
    await withTenant(a, () => loadTenantSettings(db.app));
    await withTenant(b, () => loadTenantSettings(db.app));
  });

  test("sandbox work without a bound tenant is refused once tenancy has booted", async () => {
    await assert.rejects(tenantSpritesShape({ token: "t", namePrefix: "qm" }), /needs a bound tenant/);
    await assert.rejects(tenantModalNamePrefix("qm"), /needs a bound tenant/);
  });

  test("a tenant whose settings were never loaded is refused instead of using the deployment shape", async () => {
    await assert.rejects(
      withTenant(randomUUID(), () => tenantSpritesShape({ token: "t", namePrefix: "qm" })),
      /tenant settings are not loaded/,
    );
  });

  test("the same scope reaches a different sprite per tenant, each with its own credential", async () => {
    const [a, b] = db.tenants;
    const fake = installFakeSprites();
    try {
      const sandbox = createSpritesSandbox({
        initializationStore: createPostgresMapFactory(db.ownerDatabaseUrl).map<{ pending: boolean }>(
          "sprites_shape_init",
        ),
        advisoryLock: testAdvisoryLock(),
        token: FAKE_SPRITES_TOKEN,
        namePrefix: "qmt",
        baseUrl: fake.baseUrl,
      });
      const ha = await withTenant(a, () => sandbox.provision(scope));
      const hb = await withTenant(b, () => sandbox.provision(scope));
      assert.equal(ha.id, sandboxScopeName("qm-moved-sandbox", scope));
      assert.equal(hb.id, sandboxScopeName(tenantNamePrefix("qmt", b), scope));
      assert.notEqual(ha.id, hb.id);
      assert.equal((await withTenant(a, () => sandbox.run(ha, "echo a"))).stdout.trim(), "a");
      assert.equal((await withTenant(b, () => sandbox.run(hb, "echo b"))).stdout.trim(), "b");
      const tokensFor = (name: string) =>
        new Set(fake.calls.filter((c) => c.path.includes(`/sprites/${name}`) && c.token).map((c) => c.token));
      assert.deepEqual(tokensFor(ha.id), new Set([moved.spritesToken]));
      assert.deepEqual(tokensFor(hb.id), new Set([FAKE_SPRITES_TOKEN]));
    } finally {
      fake.cleanup();
    }
  });

  test("Modal lookups use the tenant's own app, environment and name prefix", async () => {
    const [a, b] = db.tenants;
    const made: ModalShape[] = [];
    const looked: Array<{ shape: ModalShape; name: string }> = [];
    const client = tenantModalClient({ appName: "qm-shared", environment: "shared" }, (shape): ModalClient => {
      made.push(shape);
      return {
        create: async () => ({}) as ModalSession,
        fromId: async () => ({}) as ModalSession,
        fromName: async (name) => (looked.push({ shape, name }), null),
        terminate: async () => {},
      };
    });
    await withTenant(a, () => client.fromName("x"));
    await withTenant(b, () => client.fromName("y"));
    assert.deepEqual(looked, [
      { shape: { appName: "qm-moved", environment: "qm-moved" }, name: "x" },
      { shape: { appName: "qm-shared", environment: "shared" }, name: "y" },
    ]);
    assert.equal(made.length, 2);
    assert.equal(await withTenant(a, () => tenantModalNamePrefix("qm-shared")), "qm-moved");
    assert.equal(await withTenant(b, () => tenantModalNamePrefix("qm-shared")), tenantNamePrefix("qm-shared", b));
  });

  test("in-process Modal sessions stay per tenant even when two tenants keep the same old sandbox name", async () => {
    const [a, b] = db.tenants;
    const sessions = new TenantKeyedMap<string>();
    withTenant(a, () => sessions.set("qm-personal-shared-abc123", "session-a"));
    assert.equal(
      withTenant(b, () => sessions.get("qm-personal-shared-abc123")),
      undefined,
    );
    withTenant(b, () => sessions.set("qm-personal-shared-abc123", "session-b"));
    assert.equal(
      withTenant(a, () => sessions.get("qm-personal-shared-abc123")),
      "session-a",
    );
    assert.deepEqual([...sessions.values()].sort(), ["session-a", "session-b"]);
  });

  test("a Modal name prefix without the tenant's own app or environment still gets the tenant hash", async () => {
    const [, b] = db.tenants;
    await db.owner.q("UPDATE tenants SET settings = $2::jsonb WHERE id = $1", [
      b,
      JSON.stringify({ modalNamePrefix: "qm-moved" }),
    ]);
    await withTenant(b, () => loadTenantSettings(db.app));
    assert.equal(await withTenant(b, () => tenantModalNamePrefix("qm-shared")), tenantNamePrefix("qm-shared", b));
  });
});
