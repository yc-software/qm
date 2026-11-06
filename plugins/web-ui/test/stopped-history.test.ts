import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { itemsToMessages, type AssistantWork } from "../src/core-bridge.ts";
import { workSeconds } from "../src/work-duration.ts";

for (const text of ["", "Partial answer", "(stopped)"]) {
  test(`stopped history preserves status, content and timing: ${JSON.stringify(text)}`, () => {
    const items: Item[] = [
      item("AgentMessage", {
        createdAt: 4000,
        seq: 1,
        text: text,
        body: { stopped: true, workStartedAt: 1000, workFinishedAt: 4000 },
      }),
    ];
    const messages = itemsToMessages(items);
    assert.equal(messages.length, 1);
    const message = messages[0] as AssistantWork;
    assert.equal(message.stopReason, "aborted");
    assert.deepEqual(message.content, [{ type: "text", text }]);
    assert.equal(workSeconds(message.work!), 3);
  });
}

test("legacy stopped placeholders are recognized without treating ordinary replies as cancellation", () => {
  for (const [text, reason] of [
    ["(stopped)", "aborted"],
    ["The process stopped.", "stop"],
  ]) {
    const message = itemsToMessages([
      item("AgentMessage", { createdAt: 1000, seq: 1, text: text }),
    ])[0] as AssistantWork;
    assert.equal(message.stopReason, reason);
  }
});

test("a turn_stopped record renders as the stopped state, once, and never as a message", () => {
  const stop = (seq: number): Item => item("Stop", { createdAt: 5000, seq, body: { reason: "by user" } });
  const request = (seq: number): Item => item("UserMessage", { createdAt: 1000, seq, text: "do the thing" });

  const bare = itemsToMessages([request(1), stop(2)]);
  assert.equal(bare.length, 2);
  assert.equal((bare[1] as AssistantWork).stopReason, "aborted");
  assert.deepEqual((bare[1] as AssistantWork).content, [{ type: "text", text: "" }]);

  const withPartial = itemsToMessages([
    request(1),
    item("AgentMessage", { createdAt: 4000, seq: 2, text: "Partial answer", body: { stopped: true } }),
    stop(3),
  ]);
  assert.equal(withPartial.length, 2, "the partial answer already shows the stopped state");
  assert.deepEqual((withPartial[1] as AssistantWork).content, [{ type: "text", text: "Partial answer" }]);

  const twoStoppedTurns = itemsToMessages([
    request(1),
    item("AgentMessage", { createdAt: 4000, seq: 2, text: "Partial answer", body: { stopped: true } }),
    stop(3),
    item("UserMessage", { createdAt: 6000, seq: 4, text: "continue", hidden: true }),
    stop(5),
  ]);
  assert.equal(
    twoStoppedTurns.filter((m) => (m as AssistantWork).stopReason === "aborted").length,
    2,
    "a later stopped turn after a hidden prompt still shows its own stopped state",
  );
});
