import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonbSafeStringify } from "../src/util/text.ts";

test("NUL characters are dropped for jsonb", () => {
  const out = jsonbSafeStringify({ name: "a\u0000b" });
  assert.equal(out, '{"name":"ab"}');
});

test("a lone high surrogate (emoji cut in half by slice) becomes U+FFFD", () => {
  const cut = "prefix 😀".slice(0, 8);
  const out = JSON.parse(jsonbSafeStringify({ title: cut })) as { title: string };
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out.title), "no stranded surrogate survives");
  assert.ok(out.title.includes("\uFFFD"));
});

test("well-formed strings, keys, arrays, and nesting pass through untouched", () => {
  const value = { a: "hello 😀", list: ["x", { deep: "ok" }], n: 3, b: true, z: null };
  assert.equal(jsonbSafeStringify(value), JSON.stringify(value));
});

test("keys are sanitized too", () => {
  const out = jsonbSafeStringify({ ["k\u0000ey"]: 1 });
  assert.equal(out, '{"key":1}');
});

test("a key that only differs by a NUL never overwrites the clean key", () => {
  assert.equal(jsonbSafeStringify({ a: 1, ["a\u0000"]: 2 }), '{"a":1}');
  assert.equal(jsonbSafeStringify({ ["a\u0000"]: 2, a: 1 }), '{"a":1}');
});

test("a dirty key whose clean form is an inherited property name is kept", () => {
  assert.equal(jsonbSafeStringify({ ["constructor\u0000"]: 1 }), '{"constructor":1}');
  assert.equal(jsonbSafeStringify({ ["toString\u0000"]: 1, x: 2 }), '{"toString":1,"x":2}');
});
