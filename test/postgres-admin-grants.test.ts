import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresAdminGrantStore } from "../src/admin/postgres-admin-grant-store.ts";
import { createAdminGrantStore, isBootstrapAdminGrant, type AdminGrant } from "../src/admin/admin-grant-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres admin-grant tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS admin_grants CASCADE");
  await p.end();
});

const org = scopeId("org", "default-org");
const grant = (over: Partial<AdminGrant> = {}): AdminGrant => ({
  principalId: "U1",
  scopeId: org,
  role: "org_admin",
  grantedBy: "alice",
  createdAt: 1,
  ...over,
});

test("pg admin-grant persistence: put is an idempotent upsert; remove is key-scoped", { skip }, async () => {
  const store = createPostgresAdminGrantStore(URL!);

  await store.put(grant());
  await store.put(grant());
  assert.equal((await store.all()).length, 1, "put dedups on (principal, scope, role)");

  await store.put(grant({ grantedBy: "bob" }));
  assert.equal((await store.all()).length, 1);
  assert.equal((await store.all())[0]!.grantedBy, "bob");

  await store.put(grant({ principalId: "U2" }));
  assert.equal((await store.all()).length, 2);

  await store.remove("U1", org, "org_admin");
  assert.deepEqual(
    (await store.all()).map((g) => g.principalId),
    ["U2"],
    "remove drops only the matched grant",
  );
});

test("pg admin grants survive a restart: a promotion is read back through a SEPARATE store", { skip }, async () => {
  const boot1 = createPostgresAdminGrantStore(URL!);
  await boot1.put(grant({ principalId: "U-durable" }));

  const boot2 = createPostgresAdminGrantStore(URL!);
  assert.equal(
    (await boot2.all()).some((g) => g.principalId === "U-durable"),
    true,
    "promotion survived the restart",
  );
});

test(
  "pg-backed AdminGrantStore reconciles changed and removed bootstrap config without clobbering grants",
  { skip },
  async () => {
    const persist = createPostgresAdminGrantStore(URL!);
    const firstBoot = createAdminGrantStore(persist, { bootstrap: [grant({ principalId: "old-bootstrap" })] });
    await firstBoot.list();
    await firstBoot.add(grant({ principalId: "operator-admin", grantedBy: "owner", createdAt: 10 }));
    await persist.put(grant({ principalId: "legacy-admin", grantedBy: undefined, createdAt: undefined }));

    const changedBoot = createAdminGrantStore(createPostgresAdminGrantStore(URL!), {
      bootstrap: [grant({ principalId: "new-bootstrap" })],
    });
    assert.deepEqual((await changedBoot.list()).map((g) => g.principalId).sort(), [
      "legacy-admin",
      "new-bootstrap",
      "operator-admin",
    ]);

    const unchangedBoot = createAdminGrantStore(createPostgresAdminGrantStore(URL!), {
      bootstrap: [grant({ principalId: "new-bootstrap" })],
    });
    assert.deepEqual(await unchangedBoot.list(), await changedBoot.list());

    const removedConfigBoot = createAdminGrantStore(createPostgresAdminGrantStore(URL!), { bootstrap: [] });
    assert.deepEqual((await removedConfigBoot.list()).map((g) => g.principalId).sort(), [
      "legacy-admin",
      "operator-admin",
    ]);
  },
);

test("concurrent Postgres boots leave one complete bootstrap configuration", { skip }, async () => {
  const persist = createPostgresAdminGrantStore(URL!);
  const initial = createAdminGrantStore(persist, { bootstrap: [grant({ principalId: "old-bootstrap" })] });
  await initial.list();
  await initial.add(grant({ principalId: "operator-admin", grantedBy: "owner", createdAt: 10 }));

  const leftIds = ["left-a", "left-b"];
  const rightIds = ["right-a", "right-b"];
  const left = createAdminGrantStore(createPostgresAdminGrantStore(URL!), {
    bootstrap: leftIds.map((principalId) => grant({ principalId })),
  });
  const right = createAdminGrantStore(createPostgresAdminGrantStore(URL!), {
    bootstrap: rightIds.map((principalId) => grant({ principalId })),
  });
  await Promise.all([left.list(), right.list()]);

  const rows = await persist.all();
  const bootstrapIds = rows
    .filter(isBootstrapAdminGrant)
    .map((row) => row.principalId)
    .sort();
  assert.ok(
    [leftIds, rightIds].some(
      (desired) => desired.length === bootstrapIds.length && desired.every((id, index) => id === bootstrapIds[index]),
    ),
    `expected one complete configuration, got ${bootstrapIds.join(",")}`,
  );
  assert.equal(
    rows.some((row) => row.principalId === "operator-admin" && row.grantedBy === "owner"),
    true,
  );
});

test("Postgres readers observe the bootstrap swap atomically", { skip }, async () => {
  const initial = createAdminGrantStore(createPostgresAdminGrantStore(URL!), {
    bootstrap: [grant({ principalId: "old-bootstrap" })],
  });
  await initial.ready();

  const pg = (await import("pg")).default;
  const observer = new pg.Pool({ connectionString: URL! });
  await observer.query(`
    CREATE OR REPLACE FUNCTION delay_admin_grant_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM pg_sleep(0.5);
      RETURN NULL;
    END
    $fn$;
    CREATE TRIGGER delay_admin_grant_delete
    BEFORE DELETE ON admin_grants
    FOR EACH STATEMENT EXECUTE FUNCTION delay_admin_grant_delete()
  `);

  const changed = createAdminGrantStore(createPostgresAdminGrantStore(URL!), {
    bootstrap: [grant({ principalId: "new-bootstrap" })],
  });
  const reconciling = changed.ready();
  try {
    const deadline = Date.now() + 2_000;
    let deleting = false;
    while (!deleting && Date.now() < deadline) {
      const active = await observer.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND query LIKE '%DELETE FROM admin_grants AS stored%'",
      );
      deleting = (active.rowCount ?? 0) > 0;
      if (!deleting) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(deleting, true);
    const during = await observer.query("SELECT principal_id FROM admin_grants ORDER BY principal_id");
    assert.deepEqual(
      during.rows.map((row) => row.principal_id),
      ["old-bootstrap"],
    );
    await reconciling;
    const after = await observer.query("SELECT principal_id FROM admin_grants ORDER BY principal_id");
    assert.deepEqual(
      after.rows.map((row) => row.principal_id),
      ["new-bootstrap"],
    );
  } finally {
    await reconciling.catch(() => undefined);
    await observer.query("DROP TRIGGER IF EXISTS delay_admin_grant_delete ON admin_grants");
    await observer.query("DROP FUNCTION IF EXISTS delay_admin_grant_delete() ");
    await observer.end();
  }
});

test("failed Postgres reconciliation rolls back and can be retried", { skip }, async () => {
  const initial = createAdminGrantStore(createPostgresAdminGrantStore(URL!), {
    bootstrap: [grant({ principalId: "old-bootstrap" })],
  });
  await initial.ready();

  const pg = (await import("pg")).default;
  const observer = new pg.Pool({ connectionString: URL! });
  await observer.query(`
    CREATE OR REPLACE FUNCTION reject_admin_grant_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'bootstrap delete failed';
    END
    $fn$;
    CREATE TRIGGER reject_admin_grant_delete
    BEFORE DELETE ON admin_grants
    FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_grant_delete()
  `);

  const changed = createAdminGrantStore(createPostgresAdminGrantStore(URL!), {
    bootstrap: [grant({ principalId: "new-bootstrap" })],
  });
  try {
    await assert.rejects(changed.ready(), /bootstrap delete failed/);
    const afterFailure = await observer.query("SELECT principal_id FROM admin_grants ORDER BY principal_id");
    assert.deepEqual(
      afterFailure.rows.map((row) => row.principal_id),
      ["old-bootstrap"],
    );
    await observer.query("DROP TRIGGER reject_admin_grant_delete ON admin_grants");
    await changed.ready();
    const afterRetry = await observer.query("SELECT principal_id FROM admin_grants ORDER BY principal_id");
    assert.deepEqual(
      afterRetry.rows.map((row) => row.principal_id),
      ["new-bootstrap"],
    );
  } finally {
    await observer.query("DROP TRIGGER IF EXISTS reject_admin_grant_delete ON admin_grants");
    await observer.query("DROP FUNCTION IF EXISTS reject_admin_grant_delete()");
    await observer.end();
  }
});
