import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseLoginEnv, derivedLoginPassword } from "../src/database-logins.ts";
import { dockerOwnerBootstrapSql, managedDockerOwnerUrl } from "../src/backends/docker-postgres.ts";
import { mpgClusterOfUrl } from "../src/backends/fly-postgres.ts";

test("the app and reader logins are derived from the owner login and keep its host, database and options", () => {
  const owner = "postgres://owner:s3cret@db.internal:5432/qm?sslmode=require";
  const env = databaseLoginEnv(owner);
  assert.equal(env.DATABASE_OWNER_URL, owner);
  const app = new URL(env.DATABASE_URL);
  const reader = new URL(env.DATABASE_READER_URL);
  assert.equal(app.username, "qm_app");
  assert.equal(reader.username, "qm_reader");
  assert.equal(app.password, derivedLoginPassword("s3cret", "qm_app"));
  assert.notEqual(app.password, reader.password);
  assert.notEqual(app.password, "s3cret");
  for (const url of [app, reader]) {
    assert.equal(url.host, "db.internal:5432");
    assert.equal(url.pathname, "/qm");
    assert.equal(url.searchParams.get("sslmode"), "require");
  }
  assert.deepEqual(databaseLoginEnv(owner), env, "derivation is stable across runs");
  assert.notEqual(databaseLoginEnv(owner.replace("s3cret", "rotated")).DATABASE_URL, env.DATABASE_URL);
});

test("provider-issued login passwords are used as given", () => {
  const env = databaseLoginEnv("postgresql://u:p@direct.pg-1.flympg.net/db", { app: "a-pw", reader: "r-pw" });
  assert.equal(env.DATABASE_URL, "postgresql://qm_app:a-pw@direct.pg-1.flympg.net/db");
  assert.equal(env.DATABASE_READER_URL, "postgresql://qm_reader:r-pw@direct.pg-1.flympg.net/db");
  assert.equal(mpgClusterOfUrl(env.DATABASE_OWNER_URL), "pg-1");
  assert.equal(mpgClusterOfUrl("postgres://u:p@db.example.com/qm"), undefined);
});

test("an owner URL that is not an owner login is refused", () => {
  assert.throws(() => databaseLoginEnv("postgres://qm_app:x@db/qm"), /must name the login that owns the tables/);
  assert.throws(() => databaseLoginEnv("postgres://db/qm"), /must carry a login name and password/);
  assert.throws(() => databaseLoginEnv("mysql://u:p@db/qm"), /postgres:\/\/ or postgresql:\/\//);
});

test("the Docker owner bootstrap makes a non-superuser owner and never embeds its password", () => {
  const password = derivedLoginPassword("superuser-pw", "qm_owner");
  const sql = dockerOwnerBootstrapSql(password);
  assert.match(sql, /ALTER ROLE qm_owner WITH LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS PASSWORD 'SCRAM-SHA-256\$4096:/);
  assert.match(sql, /ALTER DATABASE qm OWNER TO qm_owner;/);
  assert.ok(!sql.includes(password));
  assert.equal(new URL(managedDockerOwnerUrl("superuser-pw")).password, password);
  assert.equal(new URL(managedDockerOwnerUrl("superuser-pw")).username, "qm_owner");
});
