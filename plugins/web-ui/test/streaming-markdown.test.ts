import assert from "node:assert/strict";
import test from "node:test";
import { splitStreamingMarkdown, stableSplitPoint } from "../src/streaming-markdown.ts";

const Q = 1;

test("plain paragraphs cut at blank lines; the partial block stays in the tail", () => {
  const text = "para one\n\npara two\n\npara three still typ";
  const { segments, tail } = splitStreamingMarkdown(text, Q);
  assert.deepEqual(segments, ["para one\n\n", "para two\n\n"]);
  assert.equal(tail, "para three still typ");
});

test("no boundary yet — everything is tail", () => {
  assert.deepEqual(splitStreamingMarkdown("just one paragraph so far", Q), {
    segments: [],
    tail: "just one paragraph so far",
  });
});

test("never cuts inside an unclosed code fence", () => {
  const text = "intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n";
  const { segments, tail } = splitStreamingMarkdown(text, Q);
  assert.deepEqual(segments, ["intro\n\n"]);
  assert.equal(tail, "```js\nconst a = 1;\n\nconst b = 2;\n");
});

test("cuts after a closed fence", () => {
  const { segments } = splitStreamingMarkdown("intro\n\n```js\ncode\n```\n\nmore prose comi", Q);
  assert.deepEqual(segments, ["intro\n\n", "```js\ncode\n```\n\n"]);
});

test("a ~~~ fence is tracked like a backtick fence, and they don't close each other", () => {
  const { segments } = splitStreamingMarkdown("a\n\n~~~\nblock\n```\nstill open\n\nb\n", Q);
  assert.deepEqual(segments, ["a\n\n"]);
});

test("never cuts inside unclosed $$ block math", () => {
  assert.deepEqual(splitStreamingMarkdown("a\n\n$$\nx^2\n\ny^2\n", Q).segments, ["a\n\n"]);
  assert.deepEqual(splitStreamingMarkdown("a\n\n$$\nx^2\n$$\n\ntail", Q).segments, ["a\n\n", "$$\nx^2\n$$\n\n"]);
});

test("never cuts an indented code block in half, including at the stream's live edge", () => {
  const midBlock = "a\n\n    code line 1\n\n    code line 2\n";
  assert.deepEqual(splitStreamingMarkdown(midBlock, Q).segments, ["a\n\n"]);
  const liveEdge = "a\n\n    code line 1\n\n";
  assert.deepEqual(splitStreamingMarkdown(liveEdge, Q).segments, ["a\n\n"]);
});

test("the quantum coalesces small blocks into one segment", () => {
  const text = "a\n\nb\n\nc\n\nd is still streaming";
  const { segments, tail } = splitStreamingMarkdown(text, 6);
  assert.deepEqual(segments, ["a\n\nb\n\n"]);
  assert.equal(tail, "c\n\nd is still streaming");
});

test("append-only: existing segments never change as the stream grows", () => {
  const full = "one\n\ntwo\n\n```\nfence\n```\n\nthree\n\n    ind\n\n    ind2\n\nfour is still streaming";
  let prev: string[] = [];
  for (let len = 1; len <= full.length; len++) {
    const { segments } = splitStreamingMarkdown(full.slice(0, len), 4);
    for (let i = 0; i < prev.length; i++) {
      assert.equal(segments[i], prev[i], `segment ${i} changed at len ${len}`);
    }
    assert.ok(segments.length >= prev.length, `segment list shrank at len ${len}`);
    prev = segments;
  }
});

test("segments + tail always reassemble the original text", () => {
  const samples = [
    "a\n\nb\n\nc",
    "x",
    "",
    "a\n\n```\nb\n\nc\n```\n\nd",
    "$$\nmath\n$$\n\nprose",
    "a\n\n    code\n\n    more\n",
  ];
  for (const s of samples) {
    const { segments, tail } = splitStreamingMarkdown(s, Q);
    assert.equal(segments.join("") + tail, s);
  }
});

test("stableSplitPoint is monotonic as the stream grows", () => {
  const full = "one\n\ntwo\n\n```\nfence\n```\n\nthree\n\nfour is still streaming";
  let prevAt = 0;
  for (let len = 1; len <= full.length; len++) {
    const at = stableSplitPoint(full.slice(0, len));
    assert.ok(at >= prevAt, `split point moved backwards at len ${len}`);
    prevAt = at;
  }
});
