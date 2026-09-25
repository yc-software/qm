import { test } from "node:test";
import assert from "node:assert/strict";
import { groupDmLabel, groupDmText } from "../src/group-dm-label.ts";

test("groupDmLabel parses Slack's raw mpdm channel names into people lists", () => {
  assert.deepEqual(groupDmLabel("mpdm-alice--gm--katie--carol-1"), {
    names: ["alice", "gm", "katie", "carol"],
    text: "alice, gm, katie, carol",
    count: 4,
  });
  assert.equal(groupDmText("#mpdm-eric--eve--katherine--lucas--sean-1"), "eric, eve, katherine, lucas, sean");
});

test("groupDmLabel counts the clean comma-separated form Slack ingestion now stores", () => {
  assert.deepEqual(groupDmLabel("eric, eve, katherine, lucas, sean"), {
    names: ["eric", "eve", "katherine", "lucas", "sean"],
    text: "eric, eve, katherine, lucas, sean",
    count: 5,
  });
});

test("groupDmLabel returns null for missing labels", () => {
  assert.equal(groupDmLabel(null), null);
  assert.equal(groupDmLabel("   "), null);
});
