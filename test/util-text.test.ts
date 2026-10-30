import { test } from "node:test";
import assert from "node:assert/strict";
import { headSlice, tailSlice, jsonbStringify } from "../src/util/text.ts";

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
    assert.ok(headSlice(s, n).isWellFormed(), `headSlice at ${n}`);
    assert.ok(tailSlice(s, n).isWellFormed(), `tailSlice at ${n}`);
  }
});

test("jsonbStringify drops NUL characters", () => {
  assert.equal(jsonbStringify({ name: "a\u0000b" }), '{"name":"ab"}');
});

test("jsonbStringify replaces a lone surrogate from a cut emoji with U+FFFD", () => {
  const out = JSON.parse(jsonbStringify({ title: "prefix 😀".slice(0, 8) })) as { title: string };
  assert.equal(out.title.isWellFormed(), true);
  assert.equal(out.title, "prefix \uFFFD");
});

test("jsonbStringify passes well-formed strings, keys, arrays, and nesting through untouched", () => {
  const value = {
    a: "hello 😀",
    list: ["x", { deep: "ok", ["__proto__"]: { retained: true } }],
    n: 3,
    b: true,
    z: null,
  };
  assert.equal(jsonbStringify(value), JSON.stringify(value));
});

test("jsonbStringify sanitizes keys", () => {
  assert.equal(jsonbStringify({ ["k\u0000ey"]: 1, nested: { ["\uD800x"]: 2 } }), '{"key":1,"nested":{"\uFFFDx":2}}');
});

test("jsonbStringify serializes toJSON values as JSON.stringify does", () => {
  const at = new Date(0);
  assert.equal(jsonbStringify({ at }), JSON.stringify({ at }));
});
