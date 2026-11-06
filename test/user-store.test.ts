import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { foldPrincipalId, installPrincipalLinks } from "../src/directory/person.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import { createPostgresUserStore, fold, type UserStore } from "../src/identity/user-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testAdvisoryLock, testDatabaseUrl } from "./support/test-database.ts";
import { appUrl, ownerUrl } from "./support/test-tenant.ts";
import { withTenant } from "../src/tenants/context.ts";

const url = testDatabaseUrl();
const store = (): UserStore => createPostgresUserStore(url);
const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@example.com`;

test("a person joins the roster once, folded to one row, and keeps their first arrival", async () => {
  const pat = unique("pat");
  const roster = store();
  await roster.record({ id: pat.toUpperCase(), source: "turn", at: Date.now() });
  const row = (await roster.get(pat))!;
  assert.deepEqual([row.principalId, row.source], [pat, "turn"]);
  assert.match(row.id, /^[0-9a-f-]{36}$/, "the user's key is a generated id, not the sign-in");
  assert.equal(typeof row.firstSeenAt, "number");
  await roster.record({ id: pat, source: "admin", at: Date.now() });
  assert.deepEqual([(await roster.get(pat))!.source, (await roster.get(pat))!.firstSeenAt], ["turn", row.firstSeenAt]);
  assert.equal((await roster.list()).filter((u) => u.principalId === pat).length, 1);
});

test("a user is a person until marked as an app; marking never creates a row", async () => {
  const bot = `U-${randomUUID().slice(0, 8)}`;
  const absent = `U-${randomUUID().slice(0, 8)}`;
  const roster = store();
  await roster.record({ id: bot, source: "turn", at: Date.now() });
  assert.equal((await roster.get(bot))?.kind, "person");
  assert.equal(await roster.markApps([bot, absent]), 1);
  assert.equal((await roster.get(bot))?.kind, "app");
  assert.equal(await roster.markApps([bot]), 0, "marking again changes nothing");
  assert.equal(await roster.get(absent), null);
});

test("offboarding sets offboarded_at once; reactivation clears it", async () => {
  const leaver = unique("leaver");
  const roster = store();
  const first = await roster.markOffboarded(leaver, "admin-alice");
  assert.equal(first.offboardedBy, "admin-alice");
  assert.equal(typeof first.offboardedAt, "number");
  const retry = await roster.markOffboarded(leaver.toUpperCase(), "admin-bob");
  assert.deepEqual([retry.offboardedAt, retry.offboardedBy], [first.offboardedAt, "admin-alice"]);

  await roster.record({ id: leaver, source: "turn", at: Date.now() });
  const seen = (await roster.get(leaver))!;
  assert.deepEqual([seen.offboardedBy, seen.source], ["admin-alice", "turn"], "a first arrival keeps the offboarding");

  const back = await roster.markReactivated(leaver);
  assert.deepEqual([back?.offboardedAt, back?.source], [undefined, "turn"]);
  const stranger = unique("stranger");
  assert.equal(await roster.markReactivated(stranger), null);
  assert.equal(await roster.get(stranger), null, "reactivating a stranger adds no row");
});

test("linking merges the sign-in's row into its user, and later writes for it land on that user", async () => {
  const sam = unique("sam");
  const slack = unique("sam-alt");
  const backing = store();
  const links = createPrincipalLinkService(backing, testAdvisoryLock());
  const roster = backing;
  const db = createPgPool(url);
  const rowIds = async () =>
    (await db.q("SELECT primary_alias FROM users WHERE primary_alias = ANY($1)", [[sam, slack]]))
      .map((r) => r.primary_alias as string)
      .sort();
  await roster.record({ id: sam, source: "admin", at: 200 });
  await roster.record({ id: slack, source: "turn", at: 150 });
  const { offboardedAt: slackOffboarded } = await backing.markOffboarded(slack, "admin-bob");
  await new Promise((r) => setTimeout(r, 5));
  await backing.markOffboarded(sam, "admin-alice");
  assert.deepEqual(await rowIds(), [sam, slack].sort(), "before the link they are two users");

  installPrincipalLinks(links);
  try {
    await links.link({ principalId: slack, canonicalId: sam, evidence: "qa", linkedBy: "admin-alice" });
    assert.deepEqual(await rowIds(), [sam], "the sign-in's row is merged away");
    const merged = (await roster.get(sam))!;
    assert.deepEqual(
      [merged.firstSeenAt, merged.source, merged.offboardedAt, merged.offboardedBy],
      [150, "turn", slackOffboarded, "admin-bob"],
      "earliest arrival and earliest offboarding win",
    );
    assert.equal((await roster.get(slack))?.principalId, sam, "the sign-in reads as its user");
    assert.equal((await roster.get(slack))?.id, (await roster.get(sam))?.id);

    await backing.record({ id: slack, source: "turn", at: 1 });
    await backing.markOffboarded(slack, "admin-carol");
    assert.deepEqual(await rowIds(), [sam], "writes under the sign-in resolve to the user");
    assert.equal((await roster.markReactivated(slack))?.offboardedAt, undefined);

    const ghost = unique("ghost");
    const other = `U-${randomUUID().slice(0, 8)}`;
    await links.link({ principalId: other, canonicalId: ghost, evidence: "qa", linkedBy: "admin-alice" });
    assert.ok(
      (await db.q("SELECT 1 FROM users WHERE primary_alias = $1", [ghost])).length,
      "linking to someone new creates their user",
    );
    assert.equal(
      (await roster.list()).some((u) => u.principalId === ghost),
      false,
      "but a user nobody has met is not listed",
    );

    await links.unlink(slack);
    assert.deepEqual(await rowIds(), [sam], "unlinking keeps the merged row with the user");
    assert.equal(await links.unlink(ghost), null, "a user's own primary sign-in is not a link to remove");
    await assert.rejects(
      db.query("UPDATE users SET primary_alias = $1 WHERE primary_alias = $2", [unique("nobody"), ghost]),
      /users_primary_alias_link/,
      "a user's primary sign-in must be one of their own links",
    );
  } finally {
    installPrincipalLinks(null);
  }
});

test("the SQL fold matches foldPrincipalId", async () => {
  const db = createPgPool(url);
  for (const id of ["Pat@Example.COM", "  pat@example.com ", "U01ABC", " U01abc ", "oidc:AbC:dEf", "Mixed@Case"]) {
    const [row] = await db.q(`SELECT ${fold("$1::text")} AS folded`, [id]);
    assert.equal(row!.folded, foldPrincipalId(id), id);
  }
});

test("the same sign-in is a separate user in each tenant, and a link stays in its tenant", async () => {
  const owner = createPgPool(ownerUrl(url).toString());
  const [a, b] = [randomUUID(), randomUUID()];
  await owner.q("INSERT INTO tenants(id) VALUES ($1), ($2)", [a, b]);
  const roster = createPostgresUserStore(appUrl(url));
  const pat = unique("pat");
  const alias = `U-${randomUUID().slice(0, 8)}`;
  try {
    await withTenant(a, () => roster.record({ id: pat, source: "turn", at: Date.now() }));
    await withTenant(b, () => roster.record({ id: pat, source: "invite", at: Date.now() }));
    const inA = (await withTenant(a, () => roster.get(pat)))!;
    const inB = (await withTenant(b, () => roster.get(pat)))!;
    assert.notEqual(inA.id, inB.id);
    assert.deepEqual([inA.source, inB.source], ["turn", "invite"]);
    await withTenant(a, () =>
      roster.link({ principalId: alias, canonicalId: pat, evidence: "test", linkedBy: "", createdAt: Date.now() }),
    );
    const linked = async (tenant: string) =>
      (await withTenant(tenant, () => roster.links())).filter((l) => l.principalId === alias).map((l) => l.canonicalId);
    assert.deepEqual(await linked(a), [pat]);
    assert.deepEqual(await linked(b), []);
  } finally {
    await owner.q("DELETE FROM users WHERE tenant_id = ANY($1::uuid[])", [[a, b]]);
    await owner.q("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [[a, b]]);
    await owner.close();
  }
});
