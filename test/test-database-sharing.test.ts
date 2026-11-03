import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabaseUrl, testMigratedDatabaseUrl, testSeparateDatabaseUrl } from "./support/test-database.ts";

const fileUrls = [testDatabaseUrl(), testMigratedDatabaseUrl()];
let firstTestUrl = "";

test("module-level callers share one database per file", () => {
  assert.equal(fileUrls[0], fileUrls[1]);
});

test("stores in one test share one database, and subtests share it too", async (t) => {
  firstTestUrl = testDatabaseUrl();
  assert.notEqual(firstTestUrl, fileUrls[0]);
  assert.equal(testMigratedDatabaseUrl(), firstTestUrl);
  await t.test("subtest", () => assert.equal(testDatabaseUrl(), firstTestUrl));
  assert.notEqual(testSeparateDatabaseUrl(), firstTestUrl);
});

test("each test gets its own database", () => {
  assert.notEqual(testDatabaseUrl(), firstTestUrl);
});
