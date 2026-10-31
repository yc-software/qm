import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { assertRuntimeLogin } from "../src/persistence/runtime-login.ts";

const URL_ = process.env.DATABASE_URL;
const skip = URL_ ? false : "set DATABASE_URL (a Postgres) to run the runtime login check";

function loginUrl(user: string, password: string): string {
  const url = new URL(URL_!);
  url.username = user;
  url.password = password;
  return url.toString();
}

test(
  "core refuses a runtime login that is a superuser, bypasses row-level security or owns the tables",
  { skip },
  async () => {
    const admin = new pg.Client({ connectionString: URL_ });
    await admin.connect();
    const suffix = randomBytes(4).toString("hex");
    const password = randomBytes(12).toString("hex");
    const role = (kind: string): string => `qmt_${kind}_${suffix}`;
    const [app, bypass, owner, member] = [role("app"), role("bypass"), role("owner"), role("member")];
    const table = `qmt_owned_${suffix}`;
    try {
      await admin.query(`CREATE ROLE ${app} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
      await admin.query(`CREATE ROLE ${bypass} LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS`);
      await admin.query(`CREATE ROLE ${owner} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
      await admin.query(`CREATE ROLE ${member} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE ${owner}`);
      await admin.query(`CREATE TABLE public.${table}(id int)`);
      await admin.query(`ALTER TABLE public.${table} OWNER TO ${owner}`);
      await assertRuntimeLogin(loginUrl(app, password));
      await assert.rejects(assertRuntimeLogin(URL_!), /is a superuser/);
      await assert.rejects(assertRuntimeLogin(loginUrl(bypass, password)), /bypass row-level security/);
      await assert.rejects(assertRuntimeLogin(loginUrl(owner, password)), /an owner of the tables/);
      await assert.rejects(assertRuntimeLogin(loginUrl(member, password)), /an owner of the tables/);
    } finally {
      await admin.query(`DROP TABLE IF EXISTS public.${table}`);
      for (const role of [member, owner, bypass, app]) await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  },
);
