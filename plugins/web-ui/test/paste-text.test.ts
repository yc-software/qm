import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64ToBytes,
  base64ToText,
  bytesToBase64,
  insertIntoDraft,
  pasteChipLabel,
  textToBase64,
} from "../src/paste-text.ts";

test("text round-trips through base64, including multi-byte characters", () => {
  for (const text of ["plain ascii", "emoji 🎉 and accents éàü", "日本語のテキスト", "x".repeat(200_000)]) {
    assert.equal(base64ToText(textToBase64(text)), text);
  }
});

test("textToBase64 matches btoa for ascii", () => {
  assert.equal(textToBase64("hello"), btoa("hello"));
});

test("bytesToBase64 handles buffers larger than one chunk", () => {
  const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 256);
  const decoded = atob(bytesToBase64(bytes));
  assert.equal(decoded.length, bytes.length);
  assert.equal(decoded.charCodeAt(0x8000 + 3), bytes[0x8000 + 3]);
});

test("base64ToBytes strips a data-URL prefix", () => {
  const b64 = btoa("hi");
  assert.deepEqual(base64ToBytes(`data:text/plain;base64,${b64}`), base64ToBytes(b64));
});

test("pasteChipLabel formats character counts", () => {
  assert.equal(pasteChipLabel(950), "Pasted text · 950 chars");
  assert.equal(pasteChipLabel(4200), "Pasted text · 4.2k chars");
  assert.equal(pasteChipLabel(9980), "Pasted text · 10k chars");
  assert.equal(pasteChipLabel(123_456), "Pasted text · 123k chars");
});

test("insertIntoDraft appends to an empty draft without padding", () => {
  assert.deepEqual(insertIntoDraft("", "pasted", null), { draft: "pasted", cursor: 6 });
});

test("insertIntoDraft pads with newlines so text never glues onto words", () => {
  const { draft, cursor } = insertIntoDraft("before after", "pasted", 6);
  assert.equal(draft, "before\npasted\n after");
  assert.equal(draft.slice(cursor - 6, cursor), "pasted");
});

test("insertIntoDraft skips padding at existing newlines", () => {
  assert.equal(insertIntoDraft("line\n", "pasted", 5).draft, "line\npasted");
});

test("insertIntoDraft treats an out-of-range cursor as end", () => {
  assert.equal(insertIntoDraft("draft", "pasted", 99).draft, "draft\npasted");
  assert.equal(insertIntoDraft("draft", "pasted", -1).draft, "draft\npasted");
});
