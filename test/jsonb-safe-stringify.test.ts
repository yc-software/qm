import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonbSafeStringify, pgSafeValue } from "../src/util/text.ts";

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

test("a dirty key whose clean form is __proto__ is stored as an own key", () => {
  assert.equal(jsonbSafeStringify({ ["__proto__\u0000"]: 1 }), '{"__proto__":1}');
  assert.equal(jsonbSafeStringify(JSON.parse('{"__proto__":{"x":1},"a\\u0000":1}')), '{"__proto__":{"x":1},"a":1}');
});

test("pgSafeValue returns the same object when nothing needs sanitizing", () => {
  const clean = { text: "hello 😀", list: [{ deep: "ok" }] };
  assert.equal(pgSafeValue(clean), clean);
  const dirty = { text: "a\u0000b", nested: { cut: "prefix 😀".slice(0, 8) } };
  assert.deepEqual(pgSafeValue(dirty), { text: "ab", nested: { cut: "prefix \uFFFD" } });
});

test("text that merely quotes an escape sequence takes the fast path", () => {
  const quoted = { text: "replace(payload, '\\u0000', '') and \\ud83d" };
  assert.equal(pgSafeValue(quoted), quoted);
  assert.equal(jsonbSafeStringify(quoted), JSON.stringify(quoted));
});

test("two dirty keys that clean to the same key keep the first value", () => {
  assert.equal(jsonbSafeStringify({ ["a\u0000"]: 1, ["a\u0000\u0000"]: 2 }), '{"a":1}');
});

test("a clean twin key holding undefined does not shadow the dirty key", () => {
  assert.equal(jsonbSafeStringify({ ["a\u0000"]: 1, a: undefined }), '{"a":1}');
});

test("key order does not decide which value survives", () => {
  assert.equal(jsonbSafeStringify({ a: undefined, ["a\u0000"]: 1 }), '{"a":1}');
  assert.equal(jsonbSafeStringify({ ["a\u0000"]: 1, a: 2 }), '{"a":2}');
  assert.equal(jsonbSafeStringify({ a: 2, ["a\u0000"]: 1 }), '{"a":2}');
});
