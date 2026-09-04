import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresAdminGrantStore } from "../src/admin/postgres-admin-grant-store.ts";
import { createAdminGrantStore, type AdminGrant } from "../src/admin/admin-grant-store.ts";
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
  "pg-backed AdminGrantStore: seed applies once, then a redeploy never clobbers runtime grants",
  { skip },
  async () => {
    const seed = [grant({ principalId: "seed-admin" })];
    const s1 = createAdminGrantStore(createPostgresAdminGrantStore(URL!), { seed });
    assert.equal(
      (await s1.list()).some((g) => g.principalId === "seed-admin"),
      true,
      "seed applied to the empty store",
    );
    await s1.add(grant({ principalId: "promoted-at-runtime" }));

    const s2 = createAdminGrantStore(createPostgresAdminGrantStore(URL!), { seed });
    const ids = (await s2.list()).map((g) => g.principalId).sort();
    assert.deepEqual(ids, ["promoted-at-runtime", "seed-admin"], "redeploy preserves both seed + runtime grants");
  },
);
