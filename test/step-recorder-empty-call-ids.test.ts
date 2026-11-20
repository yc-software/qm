import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createStepRecorder } from "../src/agent/step-recorder.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

test("empty provider tool-call ids are synthesized per call and shared with their results in order", async () => {
  const entries: Item[] = [];
  let seq = 0;
  const emit = async (item: NewItem): Promise<Item> => {
    const stored = storedItem(item, { sessionId: "empty-ids", seq: seq++, createdAt: Date.now() });
    entries.push(stored);
    return stored;
  };
  const writes: Promise<unknown>[] = [];
  const steps = createStepRecorder({ emit }, (write) => void writes.push(write()));
  const blocks = ["ls", "pwd"].map((command) => ({
    type: "toolCall",
    id: "",
    name: "execute",
    arguments: { command },
  }));
  steps.assistant({
    role: "assistant",
    content: blocks,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as AssistantMessage);
  for (const text of ["first", "second"]) {
    steps.toolResult({ role: "toolResult", toolCallId: "", content: [{ type: "text", text }] } as ToolResultMessage);
  }
  await Promise.all(writes);
  const calls = entries.filter((entry) => entry.kind === "ToolCall");
  assert.equal(calls.length, 2);
  for (const call of calls) assert.match(call.callId!, /^call_/);
  assert.notEqual(calls[0]!.callId, calls[1]!.callId);
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "ToolResult").map((entry) => [entry.callId, entry.text]),
    [
      [calls[0]!.callId, "first"],
      [calls[1]!.callId, "second"],
    ],
  );
});
