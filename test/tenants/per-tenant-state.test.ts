import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { scopeActivity } from "../../src/api/routes/admin/scope-activity.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { configurePgTenancy, createPgPool } from "../../src/persistence/pg-pool.ts";
import { createConfigStore } from "../../src/resolution/config-store.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import { tenant, tenantFor, withTenant } from "../../src/tenant.ts";
import { scopeId } from "../../src/types.ts";

const URL_ADMIN = process.env.DATABASE_URL!;

async function provision(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = new pg.Client({ connectionString: URL_ADMIN });
  await admin.connect();
  const suffix = randomBytes(4).toString("hex");
  const role = `qm_state_${suffix}`;
  const db = `qm_state_${suffix}`;
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${role}`);
  await admin.end();
  const url = new URL(URL_ADMIN);
  url.username = role;
  url.password = role;
  url.pathname = `/${db}`;
  return {
    url: url.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: URL_ADMIN });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${role}`);
      await c.end();
    },
  };
}

test("grant, config and identity caches never show one tenant another tenant's rows", async () => {
  const { url, drop } = await provision();
  configurePgTenancy(true);
  const a = tenantFor("org-a", randomUUID(), "a");
  const b = tenantFor("org-b", randomUUID(), "b");
  try {
    const schema = createPgPool(url);
    await schema.pool();
    const grants = createPostgresGrantStore(url);
    const grant = (owner: string) => ({
      ownerScopeId: scopeId("personal", owner),
      ref: "notes",
      granteeScopeId: scopeId("personal", "reader"),
      permission: "read" as const,
      grantedBy: owner,
    });
    await withTenant(a, async () => {
      await grants.put(grant("alice"));
      assert.deepEqual(await grants.all(), [grant("alice")]);
    });
    await withTenant(b, async () => {
      await grants.put(grant("bob"));
      assert.deepEqual(await grants.all(), [grant("bob")]);
    });
    await withTenant(a, async () => assert.deepEqual(await grants.all(), [grant("alice")]));

    const config = createConfigStore({ databaseUrl: url });
    await withTenant(a, async () => {
      await config.hydrate!();
      await config.setSetting("interactiveFastMode", true);
      await config.setInstructions(a.orgScope, "Serve org A.");
      assert.equal(config.setting("interactiveFastMode"), true);
    });
    await withTenant(b, async () => {
      await config.hydrate!();
      assert.equal(config.setting("interactiveFastMode"), false);
      assert.equal(config.getInstructions(a.orgScope), null);
      assert.notEqual(config.getInstructions(b.orgScope), "Serve org A.");
    });

    const identity = createIdentityService(url);
    await withTenant(a, async () => {
      await identity.hydrate();
      await identity.deactivate("gone@example.com");
      assert.equal(identity.classify("gone@example.com").type, "guest");
    });
    await withTenant(b, async () => {
      await identity.hydrate();
      assert.equal(identity.classify("gone@example.com").type, "internal");
      assert.equal(identity.deactivationSource("gone@example.com"), undefined);
    });
    await schema.close();
  } finally {
    configurePgTenancy(false);
    await drop();
  }
});

test("scope activity snapshots are kept per tenant", async () => {
  const store = {
    scopeActivity: async () => [
      { scopeId: tenant().orgScope, conversations: 1, crons: 0, background: 0, lastActivity: 1 },
    ],
  } as unknown as SessionStore;
  const a = tenantFor("org-a", randomUUID(), "a");
  const b = tenantFor("org-b", randomUUID(), "b");
  const snapshotFor = async (t: typeof a) =>
    withTenant(t, async () => {
      scopeActivity(store);
      await new Promise((resolve) => setImmediate(resolve));
      return scopeActivity(store);
    });
  assert.deepEqual([...(await snapshotFor(a))!.byScope.keys()], [a.orgScope]);
  assert.deepEqual([...(await snapshotFor(b))!.byScope.keys()], [b.orgScope]);
});
