import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFileRef, parseFileRef } from "../../src/surfaces/refs.ts";

test("file refs round-trip any index the formatter emits", () => {
  for (const index of [1, 9, 42, 1000, 12_345]) {
    const ref = { channel: "C0FILES", ts: "1700000000.000100", index, threadTs: "1699999999.000001" };
    assert.deepEqual(parseFileRef(formatFileRef(ref)), ref);
  }
  assert.deepEqual(parseFileRef("C0FILES:1700000000.000100#3"), {
    channel: "C0FILES",
    ts: "1700000000.000100",
    index: 3,
  });
  assert.equal(parseFileRef("C0FILES:1700000000.000100#0"), undefined);
  assert.equal(parseFileRef("C0FILES:1700000000.000100#1x"), undefined);
});
