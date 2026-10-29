import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cutToolOutput,
  DEFAULT_INLINE_TOKENS,
  inlineTokensFrom,
  parkedOutputKey,
} from "../src/sessions/tool-output.ts";

test("the inline cap setting: unset means 4096 tokens, 0 means off, junk falls back", () => {
  assert.equal(inlineTokensFrom(undefined), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom(null), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom(0), 0);
  assert.equal(inlineTokensFrom("2048"), 2048);
  assert.equal(inlineTokensFrom(-1), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom({}), DEFAULT_INLINE_TOKENS);
});

test("cutToolOutput keeps text within the budget untouched and halves the rest between head and tail", () => {
  assert.equal(cutToolOutput("short", 10, "c1"), null);
  assert.equal(cutToolOutput("x".repeat(1_000), 0, "c1"), null);
  const text = "H".repeat(500) + "T".repeat(500);
  const cut = cutToolOutput(text, 50, "c1")!;
  assert.equal(cut.shownChars, 200);
  assert.ok(cut.text.startsWith("H".repeat(100)));
  assert.ok(cut.text.endsWith("T".repeat(100)));
  const path = /tool-output\/\S+(?=;)/.exec(cut.text)![0];
  assert.equal(path.length, "tool-output/md5/".length + 32);
  assert.equal(parkedOutputKey(path)?.callId, undefined);
});

test("tool-output paths name one call", () => {
  assert.equal(parkedOutputKey("tool-output/toolu_1")?.callId, "toolu_1");
  assert.equal(parkedOutputKey(`tool-output/md5/${"ab".repeat(16)}`)?.digest, "ab".repeat(16));
  assert.equal(parkedOutputKey("tool-output/"), null);
  assert.equal(parkedOutputKey("tool-output/a/b"), null);
  assert.equal(parkedOutputKey(`tool-output/md5/${"AB".repeat(16)}`), null);
  assert.equal(parkedOutputKey("tool-output/md5/abc"), null);
  assert.equal(parkedOutputKey("notes/tool-output/a"), null);
});
