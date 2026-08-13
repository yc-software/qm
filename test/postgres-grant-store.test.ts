import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { principalEntitledToScope } from "../src/resolution/context-filter.ts";
import { scopeId, type Grant, type Principal } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres grant-store tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
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

test("pg grant persistence: put is an idempotent upsert; remove is permission-keyed", { skip }, async () => {
  const store = createPostgresGrantStore(URL!);

  await store.put(grant());
  await store.put(grant());
  assert.equal((await store.all()).length, 1, "put dedups on owner+path+grantee+permission");
  assert.deepEqual((await store.all())[0], grant());

  await store.put(grant({ permission: "write" }));
  assert.equal((await store.all()).length, 2);

  await store.put(grant({ grantedBy: "U1-again" }));
  assert.equal((await store.all()).length, 2);
  assert.equal((await store.all()).find((g) => g.permission === "read")!.grantedBy, "U1-again");

  await store.remove(grant({ permission: "write" }));
  assert.deepEqual(
    (await store.all()).map((g) => g.permission),
    ["read"],
    "remove drops only the matched permission",
  );
});

test("pg grant persistence survives across store instances (no per-process cache to diverge)", { skip }, async () => {
  const writer = createPostgresGrantStore(URL!);
  await writer.put(grant({ ref: "shared-across.md" }));

  const reader = createPostgresGrantStore(URL!);
  assert.equal(
    (await reader.all()).some((g) => g.ref === "shared-across.md"),
    true,
  );
});

test("pg grant persistence: a warm cache sees another instance's writes and revocations", { skip }, async () => {
  const reader = createPostgresGrantStore(URL!);
  const writer = createPostgresGrantStore(URL!);
  await reader.all();

  await writer.put(grant({ ref: "warm-cache.md" }));
  assert.equal(
    (await reader.all()).some((g) => g.ref === "warm-cache.md"),
    true,
    "a grant written elsewhere is visible on the very next read",
  );

  await reader.all();
  await writer.remove(grant({ ref: "warm-cache.md" }));
  assert.equal(
    (await reader.all()).some((g) => g.ref === "warm-cache.md"),
    false,
    "a revocation elsewhere is visible on the very next read",
  );
});

test("pg grant persistence: a warm cache sees writes that bypass the store entirely", { skip }, async () => {
  const reader = createPostgresGrantStore(URL!);
  await reader.all();

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by) VALUES ($1, $2, $3, $4, $5)",
    [owner, "out-of-band.md", carol, "read", "U1"],
  );
  await p.end();

  assert.equal(
    (await reader.all()).some((g) => g.ref === "out-of-band.md"),
    true,
    "raw SQL against acl_grants must invalidate warm caches (old instances during blue-green, scripts, manual psql)",
  );
});

test("pg grant persistence: the snapshot is served from cache until the version moves", { skip }, async () => {
  const reader = createPostgresGrantStore(URL!);
  await reader.put(grant({ ref: "cached.md" }));
  await reader.all();

  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    await p.query("ALTER TABLE acl_grants DISABLE TRIGGER acl_grants_bump");
    await p.query("DELETE FROM acl_grants WHERE path = $1", ["cached.md"]);
    assert.equal(
      (await reader.all()).some((g) => g.ref === "cached.md"),
      true,
      "an unbumped delete is invisible — proof reads are served from the snapshot",
    );
  } finally {
    await p.query("ALTER TABLE acl_grants ENABLE TRIGGER acl_grants_bump");
  }
  await p.query("UPDATE acl_grants_version SET v = v + 1");
  assert.equal(
    (await reader.all()).some((g) => g.ref === "cached.md"),
    false,
    "the next version bump refreshes the snapshot",
  );
  await p.end();
});

test("pg grant persistence: a conditional replacement invalidates warm caches", { skip }, async () => {
  const reader = createPostgresGrantStore(URL!);
  const writer = createPostgresGrantStore(URL!);
  const before = grant({ ref: "cas-invalidate.md" });
  await writer.put(before);
  await reader.all();

  const after = grant({ ref: "cas-invalidate.md", granteeScopeId: scopeId("personal", "U3") });
  assert.equal(await writer.replaceForResourceIfCurrent(owner, "cas-invalidate.md", [before], [after]), true);
  assert.equal(
    (await reader.all()).some((g) => g.ref === "cas-invalidate.md" && g.granteeScopeId === after.granteeScopeId),
    true,
    "the replacement is visible on the very next read",
  );
});

test("pg grant persistence: cached reads return independent arrays", { skip }, async () => {
  const store = createPostgresGrantStore(URL!);
  await store.put(grant({ ref: "aliasing.md" }));
  const first = await store.all();
  first.length = 0;
  assert.equal(
    (await store.all()).some((g) => g.ref === "aliasing.md"),
    true,
    "mutating one caller's result must not corrupt the cache",
  );
});

test("pg grant persistence serializes competing empty-set conditional replacements", { skip }, async () => {
  const left = createPostgresGrantStore(URL!);
  const right = createPostgresGrantStore(URL!);
  const a = grant({ ref: "empty-cas.md", granteeScopeId: scopeId("personal", "A") });
  const b = grant({ ref: "empty-cas.md", granteeScopeId: scopeId("personal", "B") });
  const results = await Promise.all([
    left.replaceForResourceIfCurrent(owner, "empty-cas.md", [], [a]),
    right.replaceForResourceIfCurrent(owner, "empty-cas.md", [], [b]),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  const saved = (await left.all()).filter((candidate) => candidate.ref === "empty-cas.md");
  assert.equal(saved.length, 1);
});

test(
  "pg-backed AclStore: owner-only grant, dedup, permission-agnostic revoke, handle surfacing",
  { skip },
  async () => {
    const acl = createAclStore(createPostgresGrantStore(URL!));

    await assert.rejects(acl.grant(grant({ ref: "owner-only.md", grantedBy: "U2" })), /only a manager/);

    await acl.grant(grant({ ref: "owner-only.md" }));
    await acl.grant(grant({ ref: "owner-only.md" }));
    assert.equal((await acl.grantsFor(owner, "owner-only.md")).length, 1);

    const handles = await acl.handlesFor([carol]);
    assert.equal(
      handles.some((h) => h.handlePath === "shared/owner-only.md" && h.ownerScopeId === owner),
      true,
    );

    await acl.grant(grant({ ref: "poster.png", granteeScopeId: org }));
    const surfaced = await acl.handlesForAudience(
      [person("U1"), person("U2")],
      scopeId("channel", "C1"),
      org,
      principalEntitledToScope,
    );
    assert.equal(
      surfaced.some((h) => h.handlePath === "shared/poster.png"),
      true,
    );

    await acl.grant(grant({ ref: "owner-only.md", permission: "write" }));
    assert.equal((await acl.grantsFor(owner, "owner-only.md")).length, 2);
    await acl.revoke(owner, "owner-only.md", carol, "U1");
    assert.equal(
      (await acl.grantsFor(owner, "owner-only.md")).length,
      0,
      "revoke drops every permission for the triple",
    );
  },
);
