import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PRINCIPAL_LINKS_RESTORE } from "../src/identity/principal-links.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("links kept only in user_links are copied back into principal_links", async () => {
  const schema = `restore_${randomUUID().slice(0, 8)}`;
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path = ${schema}`);
    await client.query(PRINCIPAL_LINKS_RESTORE.statements[0]!);
    assert.equal(
      (await client.query("SELECT to_regclass('principal_links') AS t")).rows[0].t,
      null,
      "no-op without user_links",
    );
    await client.query(`CREATE TABLE user_links (alias_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, evidence TEXT NOT NULL,
                          linked_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`);
    await client.query(`INSERT INTO user_links VALUES
      ('u1', 'pat@example.com', 'same person', 'admin-alice', to_timestamp(1)),
      ('u7', 'seven@example.com', 'directory', 'migration', to_timestamp(2))`);
    await client.query(`CREATE TABLE principal_links (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await client.query(
      `INSERT INTO principal_links VALUES ('u1', '{"principalId":"U1","canonicalId":"pat@example.com"}')`,
    );
    await client.query(
      `INSERT INTO user_links VALUES ('u2', 'kim@example.com', 'verified', 'admin-bob', to_timestamp(3))`,
    );
    await client.query(PRINCIPAL_LINKS_RESTORE.statements[0]!);
    const rows = (await client.query("SELECT id, json FROM principal_links ORDER BY id")).rows;
    assert.deepEqual(
      rows.map((r) => [r.id, r.json.principalId, r.json.canonicalId, r.json.linkedBy, r.json.createdAt]),
      [
        ["u1", "U1", "pat@example.com", undefined, undefined],
        ["u2", "u2", "kim@example.com", "admin-bob", 3000],
      ],
      "existing rows are kept, admin links come back, directory-derived links do not",
    );
  } finally {
    await client.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
