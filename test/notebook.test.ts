import { test } from "node:test";
import assert from "node:assert/strict";
import { capTail } from "../src/memory/notebook.ts";

test("capTail at exactly the text's length is the identity", () => {
  const s = "- (2026-05-01) fact one\n- fact two";
  assert.equal(capTail(s, s.length), s);
});

test("capTail truncates from the head, keeping the tail where the newest facts live", () => {
  assert.equal(capTail("abcdef", 3), "def");
});
