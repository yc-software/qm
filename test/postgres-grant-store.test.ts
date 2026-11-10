import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { entitledScopes } from "../src/resolution/context-filter.ts";
import { scopeId, type Grant, type Principal } from "../src/types.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres grant-store tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query("DROP TABLE IF EXISTS acl_grants CASCADE");
  await p.query("DROP TABLE IF EXISTS acl_grants_version CASCADE");
  await p.end();
});

const owner = scopeId("personal", "U1");
const carol = scopeId("personal", "U2");
const org = scopeId("org", "default-org");
const person = (id: string, teamIds?: string[]): Principal => ({
  id,
  type: "internal",
  ...(teamIds ? { teamIds } : {}),
});
const grant = (over: Partial<Grant> = {}): Grant => ({
  ownerScopeId: owner,
  ref: "redline.md",
  granteeScopeId: carol,
  permission: "read",
  grantedBy: "U1",
  ...over,
});

const onResource = (store: ReturnType<typeof createPostgresGrantStore>, ref: string) =>
  store.find(tenant, { ownerScopeId: owner, ref });

test("pg grant persistence: put is an idempotent upsert; remove is permission-keyed", { skip }, async () => {
  const store = createPostgresGrantStore(URL!);

  await store.put(tenant, grant());
  await store.put(tenant, grant());
  assert.equal((await onResource(store, "redline.md")).length, 1, "put dedups on owner+path+grantee+permission");
  assert.deepEqual((await onResource(store, "redline.md"))[0], grant());

  await store.put(tenant, grant({ permission: "write" }));
  assert.equal((await onResource(store, "redline.md")).length, 2);

  await store.put(tenant, grant({ grantedBy: "U1-again" }));
  assert.equal((await onResource(store, "redline.md")).length, 2);
  assert.equal((await onResource(store, "redline.md")).find((g) => g.permission === "read")!.grantedBy, "U1-again");

  await store.remove(tenant, grant({ permission: "write" }));
  assert.deepEqual(
    (await onResource(store, "redline.md")).map((g) => g.permission),
    ["read"],
    "remove drops only the matched permission",
  );
});

test("pg grant persistence: reads see writes that bypass the store entirely", { skip }, async () => {
  const reader = createPostgresGrantStore(URL!);
  assert.deepEqual(await onResource(reader, "out-of-band.md"), []);

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by) VALUES ($1, $2, $3, $4, $5)",
    [owner, "out-of-band.md", carol, "read", "U1"],
  );
  await p.end();

  assert.deepEqual(await onResource(reader, "out-of-band.md"), [grant({ ref: "out-of-band.md" })]);
});

test("pg grant persistence: queries select by grantee and resource kind", { skip }, async () => {
  const store = createPostgresGrantStore(URL!);
  const dave = scopeId("personal", "U4");
  const skill = grant({ ref: "skill:S1", granteeScopeId: dave });
  const deploy = grant({ ref: "deployment:D1", granteeScopeId: dave });
  const file = grant({ ref: "kinds.md", granteeScopeId: dave });
  for (const g of [skill, deploy, file]) await store.put(tenant, g);
  await store.put(tenant, grant({ ref: "skill:S1" }));

  assert.deepEqual(await store.find(tenant, { granteeScopeIds: [dave] }), [deploy, file, skill]);
  assert.deepEqual(await store.find(tenant, { granteeScopeIds: [dave], kind: "skill" }), [skill]);
  assert.deepEqual(await store.find(tenant, { granteeScopeIds: [] }), []);
});

test("pg grant persistence serializes competing empty-set conditional replacements", { skip }, async () => {
  const left = createPostgresGrantStore(URL!);
  const right = createPostgresGrantStore(URL!);
  const a = grant({ ref: "empty-cas.md", granteeScopeId: scopeId("personal", "A") });
  const b = grant({ ref: "empty-cas.md", granteeScopeId: scopeId("personal", "B") });
  const results = await Promise.all([
    left.replaceForResourceIfCurrent(tenant, owner, "empty-cas.md", [], [a]),
    right.replaceForResourceIfCurrent(tenant, owner, "empty-cas.md", [], [b]),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal((await onResource(left, "empty-cas.md")).length, 1);
});

test(
  "pg-backed AclStore: owner-only grant, dedup, permission-agnostic revoke, handle surfacing",
  { skip },
  async () => {
    const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
    for (const [id, name] of [
      ["owner-only", "owner-only.md"],
      ["poster", "poster.png"],
    ]) {
      await files.put({
        id: id!,
        ownerScopeId: owner,
        createdBy: "U1",
        name: name!,
        path: name!,
        mimetype: "application/octet-stream",
        data: Buffer.from("file"),
        direction: "out",
      });
    }
    const acl = createAclStore(createPostgresGrantStore(URL!), { resolveFiles: (refs) => files.resolveByIds(refs) });

    await assert.rejects(acl.grant(tenant, grant({ ref: "owner-only", grantedBy: "U2" })), /only a manager/);

    await acl.grant(tenant, grant({ ref: "owner-only" }));
    await acl.grant(tenant, grant({ ref: "owner-only" }));
    assert.equal((await acl.grantsFor(tenant, owner, "owner-only")).length, 1);

    const handles = await acl.handlesFor(tenant, [carol]);
    assert.equal(
      handles.some((h) => h.handlePath === "shared/owner-only.md" && h.ownerScopeId === owner),
      true,
    );

    await acl.grant(tenant, grant({ ref: "poster", granteeScopeId: org }));
    const surfaced = await acl.handlesForAudience(
      tenant,
      [person("U1"), person("U2")],
      scopeId("channel", "C1"),
      org,
      entitledScopes,
    );
    assert.equal(
      surfaced.some((h) => h.handlePath === "shared/poster.png"),
      true,
    );

    await acl.grant(tenant, grant({ ref: "owner-only", permission: "write" }));
    assert.equal((await acl.grantsFor(tenant, owner, "owner-only")).length, 2);
    await acl.revoke(tenant, owner, "owner-only", carol, "U1");
    assert.equal(
      (await acl.grantsFor(tenant, owner, "owner-only")).length,
      0,
      "revoke drops every permission for the triple",
    );
  },
);
