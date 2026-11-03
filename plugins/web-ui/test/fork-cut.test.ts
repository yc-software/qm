import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsToMessages, forkCutSeq } from "../src/core-bridge.ts";

const LOG: Item[] = [
  item("UserMessage", { seq: 0, createdAt: 0, text: "first" }),
  item("ToolCall", { seq: 1, createdAt: 1 }),
  item("ToolResult", { seq: 2, createdAt: 2 }),
  item("AgentMessage", { seq: 3, createdAt: 3, text: "reply one" }),
  item("UserMessage", { seq: 4, createdAt: 4, text: "second" }),
  item("AgentMessage", { seq: 5, createdAt: 5, text: "reply two" }),
];
const ROWS = itemsToMessages(LOG);

test("forking a user message cuts at that user entry", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 0), 0);
  assert.equal(forkCutSeq(LOG, ROWS, 2), 4);
});

test("forking an assistant message keeps its whole turn (tools included)", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 1), 3);
});

test("forking the last assistant message stops at the items that existed when clicked", () => {
  assert.equal(forkCutSeq(LOG, ROWS, 3), 5);
});

test("a fork's rows cut at their own items, not at inherited ones", () => {
  const rows = itemsToMessages(LOG.slice(4));
  assert.equal(forkCutSeq(LOG, rows, 0, 3), 4);
  assert.equal(forkCutSeq(LOG, [{ role: "user", content: "second" }], 0, 3), 4);
});

test("an unsaved live prompt maps to the next saved user entry after the last saved row", () => {
  const live = [...itemsToMessages(LOG.slice(0, 4)), { role: "user", content: "second" }];
  assert.equal(forkCutSeq(LOG, live, 2), 4);
  assert.equal(forkCutSeq(LOG.slice(0, 4), live, 2), undefined);
  const resumed = [
    ...itemsToMessages(LOG.slice(0, 4)),
    { role: "user", content: "", resumeAnchor: true },
    { role: "assistant" },
  ];
  assert.equal(forkCutSeq(LOG, resumed, 3), 3);
});
