import { test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { foldPrincipalId, installPrincipalLinks } from "../src/directory/person.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import { createPostgresUserStore, fold, type UserStore } from "../src/identity/user-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testAdvisoryLock, testDatabaseUrl } from "./support/test-database.ts";

const url = testDatabaseUrl();
const store = (): UserStore => createPostgresUserStore(url);
const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@example.com`;

test("a person joins the roster once, folded to one row, and keeps their first arrival", async () => {
  const pat = unique("pat");
  const roster = store();
  await roster.record({ id: pat.toUpperCase(), source: "turn", at: Date.now() });
  const row = (await roster.get(pat))!;
  assert.deepEqual([row.id, row.source], [pat, "turn"]);
  assert.equal(typeof row.firstSeenAt, "number");
  await roster.record({ id: pat, source: "admin", at: Date.now() });
  assert.deepEqual([(await roster.get(pat))!.source, (await roster.get(pat))!.firstSeenAt], ["turn", row.firstSeenAt]);
  assert.equal((await roster.list()).filter((u) => u.id === pat).length, 1);
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
    (await db.q("SELECT id FROM users WHERE id = ANY($1)", [[sam, slack]])).map((r) => r.id as string).sort();
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
    assert.equal((await roster.get(slack))?.id, sam, "the sign-in reads as its user");

    await backing.record({ id: slack, source: "turn", at: 1 });
    await backing.markOffboarded(slack, "admin-carol");
    assert.deepEqual(await rowIds(), [sam], "writes under the sign-in resolve to the user");
    assert.equal((await roster.markReactivated(slack))?.offboardedAt, undefined);

    const ghost = unique("ghost");
    const other = `U-${randomUUID().slice(0, 8)}`;
    await links.link({ principalId: other, canonicalId: ghost, evidence: "qa", linkedBy: "admin-alice" });
    assert.ok(
      (await db.q("SELECT 1 FROM users WHERE id = $1", [ghost])).length,
      "linking to someone new creates their user",
    );
    assert.equal(
      (await roster.list()).some((u) => u.id === ghost),
      false,
      "but a user nobody has met is not listed",
    );

    await links.unlink(slack);
    assert.deepEqual(await rowIds(), [sam], "unlinking keeps the merged row with the user");
    await assert.rejects(
      db.query("DELETE FROM users WHERE id = $1", [ghost]),
      /foreign key/,
      "a user with links cannot be deleted out from under them",
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
