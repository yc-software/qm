import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";

const core = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/runs/worker-main.ts", import.meta.url), "utf8");

test("core applies every registered migration before listening", () => {
  const migrate = core.indexOf("await migrateRegisteredPgSchemas");
  const listen = core.indexOf("server.listen");
  assert.ok(migrate > -1 && listen > migrate);
});

test("workers apply every registered migration before claiming runs", () => {
  const migrate = worker.indexOf("await migrateRegisteredPgSchemas");
  const start = worker.indexOf("runtime.start");
  assert.ok(migrate > -1 && start > migrate);
});

test("released session migrations still match their pinned source checksums", () => {
  assert.doesNotThrow(() => createPostgresSessionStore("postgres://migration-pin.invalid"));
});

test("released directory migrations still match their pinned source checksums", () => {
  assert.doesNotThrow(() => createPostgresDirectoryStore("postgres://migration-pin.invalid"));
});

test("released run migrations still match their pinned source checksums", () => {
  assert.doesNotThrow(() => createPostgresRunStore("postgres://migration-pin.invalid"));
});
