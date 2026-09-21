import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";

test("released session migrations still match their pinned source checksums", () => {
  assert.doesNotThrow(() => createPostgresSessionStore("postgres://migration-pin.invalid"));
});

test("released directory migrations still match their pinned source checksums", () => {
  assert.doesNotThrow(() => createPostgresDirectoryStore("postgres://migration-pin.invalid"));
});

test("released run migrations still match their pinned source checksums", () => {
  assert.doesNotThrow(() => createPostgresRunStore("postgres://migration-pin.invalid"));
});
