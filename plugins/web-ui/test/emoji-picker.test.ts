import assert from "node:assert/strict";
import { test } from "node:test";
import { filterEmoji, groupEmoji, matchesQuery } from "../src/emoji-picker.ts";
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

test("search filters by short-name substring and tolerates surrounding colons", () => {
  const smile = filterEmoji(EMOJI_ROWS, "smile");
  assert.ok(smile.length > 0);
  assert.ok(smile.every((r) => matchesQuery(r, "smile")));
  assert.deepEqual(
    filterEmoji(EMOJI_ROWS, ":smile:").map((r) => r.n),
    smile.map((r) => r.n),
  );
  assert.equal(filterEmoji(EMOJI_ROWS, "   ").length, EMOJI_ROWS.length, "a blank query keeps everything");
  assert.equal(filterEmoji(EMOJI_ROWS, "zzzznotanemoji").length, 0);
});

test("aliases are searchable", () => {
  const withAlias = EMOJI_ROWS.find((r) => (r.a?.length ?? 0) > 0);
  assert.ok(withAlias, "the dataset carries aliases");
  const alias = withAlias!.a![0]!;
  assert.ok(filterEmoji(EMOJI_ROWS, alias).some((r) => r.n === withAlias!.n));
});

test("grouping keeps the configured group order and drops empty groups", () => {
  const grouped = groupEmoji(filterEmoji(EMOJI_ROWS, "smile"), EMOJI_GROUPS);
  const order = grouped.map((g) => g.group);
  const expected = EMOJI_GROUPS.filter((g) => order.includes(g));
  assert.deepEqual(order, expected);
  for (const g of grouped) assert.ok(g.rows.length > 0);
});
