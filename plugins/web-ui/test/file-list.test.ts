import { test } from "node:test";
import assert from "node:assert/strict";
import { fileListNeedsAllPages } from "../src/file-list.ts";

test("filters and global sorts exhaust file cursor pages", () => {
  assert.equal(fileListNeedsAllPages({ query: "report", type: "all", ownership: "all", sort: "newest" }), true);
  assert.equal(fileListNeedsAllPages({ query: "", type: "image", ownership: "all", sort: "newest" }), true);
  assert.equal(fileListNeedsAllPages({ query: "", type: "all", ownership: "owned", sort: "newest" }), true);
  assert.equal(fileListNeedsAllPages({ query: "", type: "all", ownership: "all", sort: "oldest" }), true);
  assert.equal(fileListNeedsAllPages({ query: "", type: "all", ownership: "all", sort: "name" }), true);
  assert.equal(fileListNeedsAllPages({ query: "", type: "all", ownership: "all", sort: "newest" }), false);
  assert.equal(fileListNeedsAllPages({ query: "", type: "all", ownership: "shared", sort: "newest" }), false);
});
