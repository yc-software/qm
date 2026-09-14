import assert from "node:assert/strict";
import test from "node:test";
import { parseSuggestedActivities } from "../suggested-activities.ts";

const activity = {
  id: "weekly-brief",
  title: "Wake up to a fresh briefing",
  prompt: "Set up a weekly briefing. Ask me which topics and schedule to use.",
  icon: "schedule",
};

test("suggested activities are off unless explicitly configured", () => {
  for (const value of [undefined, "", "  ", "[]"]) assert.deepEqual(parseSuggestedActivities(value), []);
});

test("configured activities preserve order and discard unrelated fields", () => {
  assert.deepEqual(
    parseSuggestedActivities(JSON.stringify([{ ...activity, title: ` ${activity.title} `, secret: "not returned" }])),
    [activity],
  );
});

test("invalid configuration fails without echoing its contents", () => {
  for (const value of [
    "private-invalid-json",
    "{}",
    "null",
    JSON.stringify([null]),
    JSON.stringify([activity, activity]),
    JSON.stringify([{ ...activity, icon: "<script>" }]),
    JSON.stringify([{ ...activity, prompt: " " }]),
    JSON.stringify([{ ...activity, title: "a".repeat(66) }]),
    JSON.stringify([{ ...activity, prompt: "a".repeat(1201) }]),
    JSON.stringify([{ ...activity, id: "../private" }]),
    JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ ...activity, id: `item-${i}` }))),
    "x".repeat(20_001),
  ]) {
    assert.throws(() => parseSuggestedActivities(value), {
      message:
        "WEB_UI_SUGGESTED_ACTIVITIES must be a JSON array of up to 12 unique activities with id, title, prompt, and icon",
    });
  }
});
