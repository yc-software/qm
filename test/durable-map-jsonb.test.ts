import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonbStringify } from "../src/persistence/durable-map.ts";

test("NUL characters are dropped for jsonb", () => {
  const out = jsonbStringify({ name: "a\u0000b" });
  assert.equal(out, '{"name":"ab"}');
});

test("a lone high surrogate (emoji cut in half by slice) becomes U+FFFD", () => {
  const cut = "prefix 😀".slice(0, 8); // strands the high surrogate
  const out = JSON.parse(jsonbStringify({ title: cut })) as { title: string };
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out.title), "no stranded surrogate survives");
  assert.ok(out.title.includes("\uFFFD"));
});

test("well-formed strings, keys, arrays, and nesting pass through untouched", () => {
  const value = {
    a: "hello 😀",
    list: ["x", { deep: "ok", ["__proto__"]: { retained: true } }],
    n: 3,
    b: true,
    z: null,
  };
  assert.equal(jsonbStringify(value), JSON.stringify(value));
});

test("keys are sanitized too", () => {
  const out = jsonbStringify({ ["k\u0000ey"]: 1 });
  assert.equal(out, '{"key":1}');
});

test("jsonbStringify serializes values with toJSON (Date, URL) the way JSON.stringify does, not as {}", () => {
  const value = { at: new Date(0), link: new URL("https://example.com/a"), nested: [new Date(1000)], name: "a\u0000b" };
  assert.deepEqual(JSON.parse(jsonbStringify(value)), {
    at: "1970-01-01T00:00:00.000Z",
    link: "https://example.com/a",
    nested: ["1970-01-01T00:00:01.000Z"],
    name: "ab",
  });
});
