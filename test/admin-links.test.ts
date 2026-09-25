import { test } from "node:test";
import assert from "node:assert/strict";
import { adminCronHistoryUrl, adminSessionUrl } from "../src/util/admin-links.ts";

test("admin session links are scope-free paths", () => {
  assert.equal(adminSessionUrl("https://portal.test/", "abc-1"), "https://portal.test/admin/history/s/abc-1");
});

test("a session id whose encoding the portal's illegal-path guard rejects falls back to the query form", () => {
  assert.equal(adminSessionUrl("https://portal.test", "abc/1"), "https://portal.test/admin/history?session=abc%2F1");
});

test("cron history links address the scope as a path segment with kind=cron selected", () => {
  assert.equal(
    adminCronHistoryUrl("https://portal.test", "personal:alice@example.org", "c1"),
    "https://portal.test/admin/history/scopes/personal%3Aalice%40example.org?kind=cron&cron=c1",
  );
});

test("a scope whose encoding the portal's illegal-path guard rejects falls back to the query form", () => {
  assert.equal(
    adminCronHistoryUrl("https://portal.test", "personal:a/b@example.org", "c1"),
    "https://portal.test/admin/history?scope=personal%3Aa%2Fb%40example.org&kind=cron&cron=c1",
  );
});
