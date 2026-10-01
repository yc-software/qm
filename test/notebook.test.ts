import { test } from "node:test";
import assert from "node:assert/strict";
import { capTail, normalize } from "../src/memory/notebook.ts";

test("capTail truncates from the head, keeping the tail where the newest facts live", () => {
  assert.equal(capTail("abcdef", 3), "def");
});

test("normalize treats bullet style, capture date, and case as non-identity", () => {
  assert.equal(normalize("- (2026-05-01) Fact"), normalize("* fact"));
});
