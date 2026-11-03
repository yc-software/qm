import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createSandboxResources, type SandboxDefault, type SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { rewriteSurfaceOrigins } from "../src/surfaces/origin-migration.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { forEachTenant, listTenants } from "../src/tenants/claim.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { createTenantSlackRuntimes } from "../src/surfaces/slack-runtime.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { ownerPgPool } from "../src/tenants/owner-pool.ts";
import { TENANT_A, TENANT_B, twoTenantDatabase, twoTenantTestSkip } from "./support/two-tenants.ts";

const skip = twoTenantTestSkip();

test("boot steps run once under each tenant as the restricted login with two tenants", { skip }, async () => {
  const db = await twoTenantDatabase((url) => {
    const maps = createPostgresMapFactory(url);
    maps.map<SandboxResource>("sandbox_resources");
    maps.map<SandboxDefault>("sandbox_defaults");
    createPostgresRunStore(url);
    createPostgresSessionStore(url);
  });
  try {
    const maps = createPostgresMapFactory(db.appUrl);
    const upgradedIn: Array<string | undefined> = [];
    const sandboxes = createSandboxResources({
      upgrade: async () => {
        upgradedIn.push(boundTenant());
      },
      records: maps.map<SandboxResource>("sandbox_resources"),
      defaults: maps.map<SandboxDefault>("sandbox_defaults"),
      backends: {},
      defaultBackend: "e2b",
      lock: createNoopAdvisoryLock(),
      canUseScope: async () => true,
    });
    await assert.rejects(maps.pool.q("SELECT count(*) FROM sandbox_resources"), /No tenant is bound/);
    await forEachTenant(maps.pool, () => sandboxes.initialize());
    await withTenant(TENANT_B, () => sandboxes.initialize());
    const tenants = (await db.owner.query("SELECT id::text AS id FROM tenants ORDER BY id")).rows.map((row) => row.id);
    assert.ok(tenants.includes(TENANT_A) && tenants.includes(TENANT_B));
    assert.deepEqual(upgradedIn, tenants);
    await rewriteSurfaceOrigins(ownerPgPool(maps.pool));
  } finally {
    await db.close();
  }
});

test("Slack reconcile at background start runs each tenant's installation under that tenant", { skip }, async () => {
  const db = await twoTenantDatabase((url) => {
    createPostgresSessionStore(url);
    createPostgresMapFactory(url).map("slack_installation");
  });
  try {
    const maps = createPostgresMapFactory(db.appUrl);
    const installs = createSlackInstallationStore("org", maps.map("slack_installation"), "k");
    await withTenant(TENANT_A, () =>
      installs.setManaged({ botToken: "xoxb-a", appId: "A1", installId: "i-a", installedAt: 1, teamId: "T1" }),
    );
    await assert.rejects(installs.get(), /No tenant is bound/);
    const started: Array<[string | undefined, string]> = [];
    const errors: unknown[] = [];
    const runtime = createTenantSlackRuntimes({
      tenants: () => listTenants(maps.pool),
      load: async (tenant) => {
        const stored = await installs.get();
        if (stored) return { version: stored.version, config: stored.botToken };
        return tenant.install ? { version: "environment", config: "environment" } : null;
      },
      startPlugin: async (config) => {
        started.push([boundTenant(), config]);
        return { stop: async () => {} };
      },
      intervalMs: 60_000,
      startPaused: true,
      onError: (error) => errors.push(error),
    });
    runtime.start();
    await runtime.reconcile();
    await runtime.stop();
    const install = (await db.owner.query("SELECT id::text AS id FROM qm_tenant")).rows[0]?.id;
    assert.deepEqual(errors, []);
    assert.deepEqual(
      started.sort(),
      [
        [TENANT_A, "xoxb-a"],
        [install, "environment"],
      ].sort(),
    );
  } finally {
    await db.close();
  }
});
