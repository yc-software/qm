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

for (const [name, value] of [
  ["dates", new Date("2026-01-01T00:00:00Z")],
  ["URLs", new URL("https://example.com/path")],
  ["custom toJSON", { toJSON: () => ({ text: "a\u0000b\ud800" }) }],
] as const) {
  test(`jsonb preserves JSON serialization for ${name}`, () => {
    const expected = JSON.parse(JSON.stringify(value));
    if (name === "custom toJSON") expected.text = "ab\ufffd";
    assert.deepEqual(JSON.parse(jsonbStringify({ value })).value, expected);
  });
}

test("jsonb retains native cycle rejection for sanitized object keys", () => {
  const value: Record<string, unknown> = { "bad\u0000key": 1 };
  value.self = value;
  assert.throws(() => jsonbStringify(value), TypeError);
});

test(
  "both JSON boundaries round-trip provider values through real Postgres",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const { createPgPool } = await import("../src/persistence/pg-pool.ts");
    const { jsonbSafeStringify } = await import("../src/util/text.ts");
    const pg = createPgPool(process.env.DATABASE_URL!);
    const value = { "bad\u0000key": "half\ud800", when: new Date("2026-01-01T00:00:00Z"), nested: ["😀"] };
    try {
      for (const stringify of [jsonbStringify, jsonbSafeStringify]) {
        const [row] = await pg.q("SELECT $1::jsonb AS value", [stringify(value)]);
        assert.deepEqual(row!.value, { badkey: "half�", when: "2026-01-01T00:00:00.000Z", nested: ["😀"] });
      }
    } finally {
      await pg.close();
    }
  },
);
