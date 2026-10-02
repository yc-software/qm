import assert from "node:assert/strict";
import { test } from "node:test";
import { EMOJI_GROUPS, EMOJI_ROWS } from "../src/emoji-data.ts";

test("the curated emoji map is built with short names, unicode chars, and known groups", () => {
  assert.ok(EMOJI_ROWS.length > 500, "the curated set is substantial");
  const groups = new Set(EMOJI_GROUPS);
  for (const row of EMOJI_ROWS.slice(0, 200)) {
    assert.equal(typeof row.n, "string");
    assert.ok(row.n.length > 0);
    assert.equal(typeof row.c, "string");
    assert.ok(row.c.length > 0);
    assert.ok(groups.has(row.g), `every row belongs to a known group (${row.g})`);
  }
  const eyes = EMOJI_ROWS.find((r) => r.n === "eyes");
  assert.ok(eyes, "a common emoji resolves by short name");
  assert.equal(eyes!.c, "👀");
});
