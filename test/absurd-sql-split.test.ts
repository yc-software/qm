import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertOneStatement, definePgMigration } from "../src/persistence/pg-pool.ts";
import { ABSURD_MIGRATION, ABSURD_SQL_URL, TURN_QUEUES, splitSqlStatements } from "../src/turns/absurd-schema.ts";

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

test("vendored Absurd SQL splits into single statements that reassemble the file", () => {
  const sql = readFileSync(ABSURD_SQL_URL, "utf8");
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, sql.match(/^create /gm)?.length);
  for (const statement of statements) assertOneStatement(statement);
  assert.equal(normalize(statements.join("")), normalize(sql));
  assert.match(statements[0]!, /create schema if not exists absurd;$/);
  assert.match(statements.at(-1)!, /create function absurd\.disable_cron[\s\S]*\$\$;\s*$/);
});

test("Absurd migration matches its pinned checksum and creates the turn queues", () => {
  const migration = definePgMigration(
    ABSURD_MIGRATION.id,
    ABSURD_MIGRATION.statements,
    ABSURD_MIGRATION.expectedChecksum,
  );
  assert.equal(migration.id, "absurd/0.5.1");
  assert.deepEqual(
    migration.statements.filter((statement) => statement.startsWith("SELECT absurd.create_queue")),
    TURN_QUEUES.map((queue) => `SELECT absurd.create_queue('${queue}', 'unpartitioned')`),
  );
  assert.throws(
    () =>
      definePgMigration(
        ABSURD_MIGRATION.id,
        [...ABSURD_MIGRATION.statements, "SELECT 1"],
        ABSURD_MIGRATION.expectedChecksum,
      ),
    /checksum mismatch/,
  );
});

test("splitter keeps semicolons inside dollar bodies, strings, identifiers and comments", () => {
  const sql = [
    "-- leading; comment\ncreate function a() returns int language sql as $$ select 1; $$;",
    "\ncreate function b() returns text language plpgsql as $body$ begin return 'x$$;'; end; $body$;",
    "\nselect 'it''s; fine' from t$1$x;",
    "\nselect $q$ $$ ; $q$;",
    "\n-- trailing; note\n",
  ].join("");
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 4);
  for (const statement of statements) assertOneStatement(statement);
  assert.equal(statements.join(""), sql);
  assert.match(statements[3]!, /-- trailing; note\n$/);
});

test("splitter keeps semicolons inside quoted identifiers and block comments", () => {
  assert.deepEqual(splitSqlStatements('select "odd;name"; select 1;'), ['select "odd;name";', " select 1;"]);
  assert.deepEqual(splitSqlStatements("select /* a; b */ 1; select 2;"), ["select /* a; b */ 1;", " select 2;"]);
});

test("splitter keeps trailing SQL without a semicolon as its own statement", () => {
  assert.deepEqual(splitSqlStatements("select 1; select 2"), ["select 1;", " select 2"]);
});

test("splitter rejects unterminated bodies and strings", () => {
  assert.throws(() => splitSqlStatements("select $$ open;"), /unterminated \$\$ body/);
  assert.throws(() => splitSqlStatements("select 'open;"), /unterminated ' quote/);
  assert.throws(() => splitSqlStatements("select /* open;"), /unterminated block comment/);
});
