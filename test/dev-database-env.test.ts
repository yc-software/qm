import assert from "node:assert/strict";
import test from "node:test";
import { devDatabaseEnv } from "../scripts/dev/supervisor/durability.ts";

test("a dev instance runs core as qm_app and qm_reader and keeps the configured URL as the owner", () => {
  const owner = "postgres://postgres:pw@127.0.0.1:5432/qm_dev";
  const env = devDatabaseEnv(owner);
  assert.equal(env.DATABASE_OWNER_URL, owner);
  const app = new URL(env.DATABASE_URL!);
  const reader = new URL(env.DATABASE_READER_URL!);
  assert.deepEqual([app.username, app.host, app.pathname], ["qm_app", "127.0.0.1:5432", "/qm_dev"]);
  assert.equal(reader.username, "qm_reader");
  assert.notEqual(app.password, reader.password);
  assert.deepEqual(devDatabaseEnv(owner), env);
  assert.ok(new URL(devDatabaseEnv("postgres://postgres@localhost/qm").DATABASE_URL!).password);
});
