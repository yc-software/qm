import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createStepRecorder } from "../src/agent/step-recorder.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

function recorderSink() {
  const entries: Item[] = [];
  let seq = 0;
  const emit = async (item: NewItem): Promise<Item> => {
    const stored = storedItem(item, { sessionId: "step-recorder-empty-ids", seq: seq++, createdAt: Date.now() });
    entries.push(stored);
    return stored;
  };
  const writes: Promise<unknown>[] = [];
  const steps = createStepRecorder({ emit }, (write) => void writes.push(write()));
  return { entries, steps, settled: () => Promise.all(writes) };
}

function emptyIdMessage(callCount: number): AssistantMessage {
  return {
    role: "assistant",
    content: Array.from({ length: callCount }, (_, i) => ({
      type: "toolCall" as const,
      id: "",
      name: "execute",
      arguments: { command: `ls ${i}` },
    })),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function result(text: string): ToolResultMessage {
  return { role: "toolResult", toolCallId: "", content: [{ type: "text", text }], isError: false } as ToolResultMessage;
}

test("an empty provider tool-call id is synthesized once and shared by the call and its result", async () => {
  const sink = recorderSink();
  sink.steps.assistant(emptyIdMessage(1));
  sink.steps.toolResult(result("ok"));
  await sink.settled();
  const call = sink.entries.find((entry) => entry.kind === "ToolCall");
  const callResult = sink.entries.find((entry) => entry.kind === "ToolResult");
  assert.match(call!.callId!, /^call_/);
  assert.equal(callResult!.callId, call!.callId);
});

test("multiple empty-id tool calls in one message get distinct ids and pair with their results in order", async () => {
  const sink = recorderSink();
  sink.steps.assistant(emptyIdMessage(2));
  sink.steps.toolResult(result("first"));
  sink.steps.toolResult(result("second"));
  await sink.settled();
  const calls = sink.entries.filter((entry) => entry.kind === "ToolCall");
  const results = sink.entries.filter((entry) => entry.kind === "ToolResult");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.callId, calls[1]!.callId);
  assert.deepEqual(
    results.map((entry) => [entry.callId, entry.text]),
    [
      [calls[0]!.callId, "first"],
      [calls[1]!.callId, "second"],
    ],
  );
});
