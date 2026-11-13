import assert from "node:assert/strict";
import test from "node:test";
import { parseSuggestedActivities } from "../../chassis/src/suggested-activities.ts";

const activity = {
  id: "weekly-brief",
  title: "Wake up to a fresh briefing",
  prompt: "Let's set up a weekly briefing on the topics I follow.",
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

test("icons accept a single emoji or the YC mark, never arbitrary text or markup", () => {
  for (const icon of ["🛠️", "👩🏽‍💻", "📊", "🇺🇸", "1️⃣", "yc"]) {
    assert.equal(parseSuggestedActivities(JSON.stringify([{ ...activity, icon }]))[0]?.icon, icon);
  }
  for (const icon of ["hello", "📊📚", "<img src=x>", "https://example.com/logo.svg", "📊 text"]) {
    assert.throws(() => parseSuggestedActivities(JSON.stringify([{ ...activity, icon }])));
  }
});
