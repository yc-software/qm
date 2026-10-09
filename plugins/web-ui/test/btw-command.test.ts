import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBtw } from "../src/btw-command.ts";

test("/btw extracts the side question", () => {
  assert.equal(parseBtw("/btw what changed?"), "what changed?");
  assert.equal(parseBtw("  /BTW  multi\nline "), "multi\nline");
  assert.equal(parseBtw("/btw"), "");
});

test("other drafts are not side questions", () => {
  for (const draft of ["btw hi", "/btwx hi", "hello /btw hi"]) assert.equal(parseBtw(draft), null);
});
