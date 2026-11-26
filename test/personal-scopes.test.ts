import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PERSONAL_SCOPE_MIGRATIONS } from "../src/identity/personal-scopes.ts";
import { foundingUserId } from "../src/directory/person-refs.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

test("stored personal scopes move from aliases to user ids; an alias with no user takes the id its first sign-in will get and is reported", async () => {
  const client = new pg.Client({ connectionString: ownerUrl(testMigratedDatabaseUrl()).toString() });
  await client.connect();
  const tag = randomUUID().slice(0, 8);
  const [pat, alt, stray, user] = [`pat-${tag}@example.com`, `pat-${tag}@alt.example`, `stray-${tag}`, randomUUID()];
  try {
    await client.query(`SELECT set_config('qm.tenant_id', $1, false)`, [TEST_TENANT]);
    await client.query("BEGIN");
    await client.query(`INSERT INTO users(id, primary_alias) VALUES ($1, $2)`, [user, pat]);
    await client.query(
      `INSERT INTO user_links(alias_id, user_id, evidence, created_at) VALUES ($1, $3, 'primary', now()), ($2, $3, 'admin', now())`,
      [pat, alt, user],
    );
    await client.query("COMMIT");
    await client.query(
      `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at)
       VALUES ($1, 'dm', $2, $1, 0), ($3, 'dm', $4, $3, 0), ($5, 'dm', $6, $5, 0)`,
      [`a-${tag}`, `personal:${pat.toUpperCase()}`, `b-${tag}`, `personal:${alt}`, `c-${tag}`, `personal:${stray}`],
    );
    await client.query(
      `CREATE TABLE things_${tag}(id text PRIMARY KEY, json jsonb, tenant_id uuid DEFAULT qm_bound_tenant())`,
    );
    await client.query(`INSERT INTO things_${tag}(id, json) VALUES ('t', $1)`, [
      { owner: `personal:${alt}`, grants: [`personal:${pat}`, "channel:C1"] },
    ]);
    await client.query(PERSONAL_SCOPE_MIGRATIONS[0]!.statements.at(-1)!);
    const scopes = await client.query(`SELECT id, scope_id FROM sessions WHERE id LIKE $1 ORDER BY id`, [`%-${tag}`]);
    assert.deepEqual(
      scopes.rows.map((r) => r.scope_id),
      [`personal:${user}`, `personal:${user}`, `personal:${foundingUserId(stray)}`],
    );
    const thing = await client.query(`SELECT json FROM things_${tag}`);
    assert.deepEqual(thing.rows[0].json, { owner: `personal:${user}`, grants: [`personal:${user}`, "channel:C1"] });
    const report = await client.query(
      `SELECT detail FROM audit_log WHERE action = 'personal_scopes_by_user_id' ORDER BY at DESC, id DESC LIMIT 1`,
    );
    const detail = JSON.parse(report.rows[0].detail);
    assert.ok(detail.moved.sessions >= 2 && detail.moved[`things_${tag}.json`] === 1);
    assert.ok(detail.unmatched.some((u: { scope: string }) => u.scope === `personal:${stray}`));
  } finally {
    await client.end();
  }
});
