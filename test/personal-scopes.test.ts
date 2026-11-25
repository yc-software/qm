import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { PERSONAL_SCOPE_MIGRATIONS } from "../src/identity/personal-scopes.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { personalScope, scopeLabel } from "../src/types.ts";
import { testAdvisoryLock, testMigratedDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

const url = testMigratedDatabaseUrl();
const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@example.com`;

test("a person keeps their personal scope when their primary sign-in changes; what a sign-in owned joins the person it is linked to; unlinking the sign-in a scope is named after renames the scope", async (t) => {
  const [roster, db, sessions] = [createPostgresUserStore(url), createPgPool(url), createPostgresSessionStore(url)];
  const links = createPrincipalLinkService(roster, testAdvisoryLock());
  installPrincipalLinks(links);
  t.after(() => installPrincipalLinks(null));
  const [work, home] = [unique("work"), unique("home")];
  const scope = `personal:${work}`;
  await roster.record({ id: work, source: "turn", at: 1 });
  const dm = await sessions.getOrCreateByThread(`dm:${randomUUID()}`, "dm", personalScope(home));
  const dmScope = async () => (await sessions.get(dm.id))?.scopeId;
  await links.link({ principalId: home, canonicalId: work, evidence: "qa", linkedBy: "admin-alice" });
  assert.equal(await dmScope(), scope, "what the sign-in owned before the link is the person's");
  await db.query("UPDATE users SET primary_alias = $1 WHERE primary_alias = $2", [home, work]);
  await links.refresh(true);
  assert.deepEqual([personalScope(work), personalScope(home), scopeLabel(scope)], [scope, scope, `personal:${home}`]);
  await links.unlink(work);
  assert.equal(personalScope(home), `personal:${home}`);
  assert.equal(await dmScope(), `personal:${home}`, "the scope's contents follow its new name");
});

test("a database whose personal scopes were already re-keyed by user id gets them back under each person's sign-in", async () => {
  const client = new pg.Client({ connectionString: ownerUrl(url).toString() });
  await client.connect();
  const [pat, user, session] = [unique("pat"), randomUUID(), `s-${randomUUID()}`];
  try {
    await client.query(`SELECT set_config('qm.tenant_id', $1, false)`, [TEST_TENANT]);
    await client.query("BEGIN");
    await client.query(`INSERT INTO users(id, primary_alias) VALUES ($1, $2)`, [user, pat]);
    await client.query(
      `INSERT INTO user_links(alias_id, user_id, evidence, created_at) VALUES ($1, $2, 'primary', now())`,
      [pat, user],
    );
    await client.query(
      `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ($1, 'dm', $2, $1, 0)`,
      [session, `personal:${user}`],
    );
    await client.query(
      `INSERT INTO qm_schema_migrations(id, checksum) VALUES ('users/v2/0007-personal-scopes-by-user-id', 'applied')`,
    );
    await client.query(PERSONAL_SCOPE_MIGRATIONS[0]!.statements[2]!);
    const moved = await client.query(`SELECT scope_id FROM sessions WHERE id = $1`, [session]);
    assert.equal(moved.rows[0].scope_id, `personal:${pat}`);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
