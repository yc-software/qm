import { absoluteAppLinks } from "../src/util/text.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { headSlice, tailSlice, hasLoneSurrogate } from "../src/util/text.ts";

test("headSlice and tailSlice pass short strings through and cut long ones", () => {
  assert.equal(headSlice("abc", 5), "abc");
  assert.equal(tailSlice("abc", 5), "abc");
  assert.equal(headSlice("abcdef", 3), "abc");
  assert.equal(tailSlice("abcdef", 3), "def");
});

test("headSlice and tailSlice return empty for zero or negative budgets (slice(-0) trap)", () => {
  assert.equal(headSlice("abcdef", 0), "");
  assert.equal(tailSlice("abcdef", 0), "");
  assert.equal(headSlice("abcdef", -2), "");
  assert.equal(tailSlice("abcdef", -2), "");
});

test("headSlice and tailSlice never strand half a surrogate pair", () => {
  const s = "😀".repeat(10);
  for (let n = 1; n < s.length; n++) {
    assert.ok(!hasLoneSurrogate(headSlice(s, n)), `headSlice at ${n}`);
    assert.ok(!hasLoneSurrogate(tailSlice(s, n)), `tailSlice at ${n}`);
  }
});

test("published app links resolve against the portal without rewriting code or external URLs", () => {
  assert.equal(
    absoluteAppLinks("[Pirates](/d/pirates/) [Other](https://example.com) `[/d/x/](/d/x/)`", "https://qm.example.com"),
    "[Pirates](https://qm.example.com/d/pirates/) [Other](https://example.com) `[/d/x/](/d/x/)`",
  );
  assert.equal(absoluteAppLinks("[Pirates](/d/pirates/)", undefined), "[Pirates](/d/pirates/)");
});

test("app links preserve tilde fences and multi-backtick code spans", () => {
  for (const text of ["~~~md\n[x](/d/x/)\n~~~", "``[x](/d/x/)``", "````md\n[x](/d/x/)\n````"]) {
    assert.equal(absoluteAppLinks(text, "https://qm.example.com"), text);
  }
});
