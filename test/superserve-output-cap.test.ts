import { test } from "node:test";
import assert from "node:assert/strict";
import { clampUtf8 } from "../src/sandbox/superserve-client.ts";

test("clampUtf8 cuts on a codepoint boundary and keeps a replacement character the input really had", () => {
  const withReplacement = `${"a".repeat(7)}�b`;
  assert.equal(Buffer.byteLength(withReplacement, "utf8"), 11);
  assert.equal(clampUtf8(withReplacement, 10), `${"a".repeat(7)}�`, "a real U+FFFD survives truncation");
  assert.ok(!clampUtf8("漢".repeat(10), 10).includes("�"), "truncation never invents one");
  assert.ok(!clampUtf8("😀".repeat(4), 6).includes("�"), "surrogate pairs are cut whole");
  assert.equal(clampUtf8("😀😀", 4), "😀");
});
