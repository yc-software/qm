import { test } from "node:test";
import assert from "node:assert/strict";
import { safeChunks, safeClip, safeCutIndex } from "../src/slack/safe-cut.ts";
import { slackSectionBlocks } from "../src/slack/mrkdwn.ts";

const wellFormed = (s: string) => Buffer.from(s, "utf8").toString("utf8") === s;

test("an emoji straddling the boundary is never split into lone surrogates", () => {
  const text = "a".repeat(9) + "😀" + "b".repeat(10);
  for (let max = 8; max <= 12; max++) {
    for (const chunk of safeChunks(text, max)) {
      assert.ok(wellFormed(chunk), `max=${max} produced a mangled chunk`);
    }
  }
});

test("a <url|label> entity that fits the budget is not bisected", () => {
  const text = "see <https://example.test/very/long|the docs> for more, plus trailing text to split";
  const chunks = safeChunks(text, 50);
  for (const c of chunks) {
    const opens = (c.match(/</g) ?? []).length;
    const closes = (c.match(/>/g) ?? []).length;
    assert.equal(opens, closes, `entity split across chunks: ${JSON.stringify(c)}`);
  }
  assert.equal(chunks.join(""), text);
});

test("a bold run that fits the budget is not left dangling open at the cut", () => {
  const text = "start *bold text* trailing words follow here";
  for (const c of safeChunks(text, 14)) {
    assert.equal((c.match(/\*/g) ?? []).length % 2, 0, `unbalanced bold in ${JSON.stringify(c)}`);
  }
});

test("chunks always reassemble to the original text", () => {
  const text = "🎉".repeat(50) + " <https://x.test|link> " + "*bold*".repeat(30);
  assert.equal(safeChunks(text, 37).join(""), text);
  assert.equal(safeChunks(text, 7).join(""), text);
});

test("a pathological single entity longer than the budget still cuts", () => {
  const text = "<" + "x".repeat(100);
  const chunks = safeChunks(text, 10);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
});

test("safeClip appends an ellipsis and never mangles", () => {
  const text = "abc😀def";
  for (let max = 1; max <= 8; max++) {
    const out = safeClip(text, max);
    assert.ok(wellFormed(out));
  }
  assert.equal(safeClip("short", 10), "short");
});

test("slackSectionBlocks uses safe cuts", () => {
  const text = "x".repeat(2_899) + "😀" + "y".repeat(100);
  for (const b of slackSectionBlocks(text)) {
    const t = (b as { text: { text: string } }).text.text;
    assert.ok(wellFormed(t));
    assert.ok(t.length <= 2_900);
  }
});

test("safeCutIndex returns full length for short text", () => {
  assert.equal(safeCutIndex("abc", 10), 3);
});
