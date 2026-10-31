import assert from "node:assert/strict";
import { test } from "node:test";
import { DISCORD_MESSAGE_IDS, SLACK_MESSAGE_IDS } from "../src/surfaces/message-ids.ts";

test("the Discord codec packs a snowflake into base36 and restores it exactly", () => {
  assert.equal(DISCORD_MESSAGE_IDS.encode("1300000000000000001"), "~9vkbjfeanyf5");
  assert.equal(DISCORD_MESSAGE_IDS.decode("~9vkbjfeanyf5"), "1300000000000000001");
  assert.equal(DISCORD_MESSAGE_IDS.encode("999999999999999999"), "~7lieexzx4kxr");
  assert.equal(DISCORD_MESSAGE_IDS.decode("~7lieexzx4kxr"), "999999999999999999");
});

test("the Discord codec yields no id for non-snowflakes and rejects malformed tokens", () => {
  assert.equal(DISCORD_MESSAGE_IDS.encode("1717360800.000100"), "");
  assert.equal(DISCORD_MESSAGE_IDS.encode(""), "");
  for (const bad of ["9vkbjfeanyf5", "~", "~0", "~not-base36!", "1300000000000000001", "~zz"])
    assert.equal(DISCORD_MESSAGE_IDS.decode(bad), null, bad);
});

test("the Slack codec still round-trips a ts and refuses a snowflake", () => {
  assert.equal(SLACK_MESSAGE_IDS.decode(SLACK_MESSAGE_IDS.encode("1717360800.000100")), "1717360800.000100");
  assert.equal(SLACK_MESSAGE_IDS.encode("1300000000000000001"), "");
});

test("the Discord comparator orders snowflakes numerically across digit-count boundaries", () => {
  const ids = ["1300000000000000001", "999999999999999999", "1300000000000000000"];
  assert.deepEqual([...ids].sort(DISCORD_MESSAGE_IDS.compare), [
    "999999999999999999",
    "1300000000000000000",
    "1300000000000000001",
  ]);
  assert.deepEqual([...ids].sort(SLACK_MESSAGE_IDS.compare), [
    "1300000000000000000",
    "1300000000000000001",
    "999999999999999999",
  ]);
});
