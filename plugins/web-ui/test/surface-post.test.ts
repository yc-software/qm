import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { postCallText, postResultOk } from "../src/surface-post.ts";
import { postSpeechText, type ToolRowModel } from "../src/timeline.ts";

const call: Item = item("ToolCall", {
  seq: 1,
  createdAt: 1,
  tool: "web",
  callId: "post",
  body: { action: "post", text: "The answer" },
});

for (const [name, fields, ok] of [
  ["successful", { isError: false, body: { ok: true } }, true],
  ["legacy sent", { text: "[sent]", isError: false }, true],
  ["unscreened success", { text: "untrusted wrapper: [sent]", isError: false, body: { unscreened: true } }, true],
  ["failed", { body: { ok: false } }, false],
  ["error flag", { isError: true }, false],
  ["error detail", { body: { error: "delivery failed" } }, false],
  ["denied", { body: { denied: true } }, false],
  ["approval blocked", { body: { blocked: "needs_approval" } }, false],
] as const) {
  test(`${name} post uses the same delivery decision in live and persisted views`, () => {
    const result = item("ToolResult", { seq: 2, createdAt: 2, tool: "web", callId: "post", ...fields });
    const row: ToolRowModel = { call, result };
    assert.equal(postResultOk(result), ok);
    assert.equal(postSpeechText(row), ok ? "The answer" : null);
    assert.equal(postSpeechText(row, true), ok ? "The answer" : null);
  });
}

test("an unconfirmed post can preview posting but cannot appear as delivered speech", () => {
  const row: ToolRowModel = { call, result: null };
  assert.equal(postSpeechText(row), null);
  assert.equal(postSpeechText(row, true), "The answer");
  row.approval = item("Elicitation", { seq: 2, createdAt: 2, elicitId: "post" });
  assert.equal(postSpeechText(row, true), null);
});

test("file-only posts remain eligible for transcript attachments, not text bubbles", () => {
  const body = { action: "post", text: "", files: ["report.pdf"] };
  assert.equal(postCallText({ body }), "");
  assert.equal(postSpeechText({ call: { ...call, body }, result: null }, true), null);
});

test("non-post and legacy bytes-only calls remain tool activity", () => {
  for (const body of [
    { action: "read", text: "not speech" },
    { action: "post", bytes: 100 },
    { action: "post", text: "  " },
  ]) {
    assert.equal(postCallText({ body }), null);
    assert.equal(postSpeechText({ call: { ...call, body }, result: null }, true), null);
  }
});
