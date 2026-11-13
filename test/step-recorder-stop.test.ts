import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { createStepRecorder } from "../src/agent/step-recorder.ts";
import { recordStoppedTurn } from "../src/agent/turn-support.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

function recorderSink() {
  const entries: Item[] = [];
  let seq = 0;
  const emit = async (item: NewItem): Promise<Item> => {
    const stored = storedItem(item, { sessionId: "step-recorder-stop", seq: seq++, createdAt: Date.now() });
    entries.push(stored);
    return stored;
  };
  const writes: Promise<unknown>[] = [];
  const steps = createStepRecorder({ emit }, (write) => void writes.push(write()));
  const turn = { emit } as unknown as AgentTurnInput;
  return { entries, steps, turn, settled: () => Promise.all(writes) };
}

function assistantMessage(stopReason: AssistantMessage["stopReason"], withToolCall: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Let me look that up." },
      ...(withToolCall
        ? [{ type: "toolCall" as const, id: "call-1", name: "execute", arguments: { command: "ls" } }]
        : []),
    ],
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
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage;
}

async function stopAfter(message: AssistantMessage) {
  const sink = recorderSink();
  sink.steps.assistant(message);
  await sink.settled();
  await recordStoppedTurn(sink.turn, "Let me look that up.", "by user", sink.steps.closing("Let me look that up."));
  await sink.settled();
  return sink.entries.filter((entry) => entry.kind === "AgentMessage");
}

test("a Stop that aborts a message holding text and a tool call records the partial reply once", async () => {
  const messages = await stopAfter(assistantMessage("aborted", true));
  assert.equal(messages.length, 1, "the partial text is written exactly once");
  assert.equal(messages[0]!.text, "Let me look that up.");
  assert.equal(messages[0]!.variant ?? null, null, "no narration row is written for an aborted message");
  assert.equal(messages[0]!.body?.stopped, true);
});

test("a Stop that aborts a text-only message records the partial reply once", async () => {
  const messages = await stopAfter(assistantMessage("aborted", false));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.body?.stopped, true);
});

test("text before a tool call in a completed message is still recorded as narration", async () => {
  const sink = recorderSink();
  sink.steps.assistant(assistantMessage("toolUse", true));
  await sink.settled();
  const messages = sink.entries.filter((entry) => entry.kind === "AgentMessage");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.variant, "narration");
});

test("a turn that ends on the message carrying its tool call does not repeat that message's text as the reply", () => {
  const sink = recorderSink();
  sink.steps.assistant(assistantMessage("toolUse", true));
  assert.equal(sink.steps.narrated("Let me look that up."), true);
  sink.steps.assistant(assistantMessage("stop", false));
  assert.equal(sink.steps.narrated("Let me look that up."), false);
});
