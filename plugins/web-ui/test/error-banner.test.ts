import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";

import { showStateError } from "../src/error-banner.ts";

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function failed(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

test("a failed run records its error on BOTH the transcript message and agent state", async () => {
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const error = failed("model call failed");
    stream.push({ type: "error", reason: "error", error });
    stream.end(error);
    return stream;
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: "",
      model: { id: "test", provider: "anthropic", api: "anthropic-messages" } as never,
      messages: [],
      tools: [],
    },
    streamFn,
    convertToLlm: () => [],
  });
  await agent.prompt("hi");

  const last = agent.state.messages[agent.state.messages.length - 1] as AssistantMessage;
  assert.equal(last.stopReason, "error");
  assert.equal(last.errorMessage, "model call failed");
  assert.equal(agent.state.errorMessage, "model call failed", "the same error is also copied onto agent state");

  assert.equal(
    showStateError(agent.state.messages, agent.state.errorMessage),
    false,
    "so the state-level banner must not render it again",
  );
});

test("the state banner is suppressed when the trailing message already shows the same error", () => {
  assert.equal(showStateError([failed("boom")], "boom"), false);
});

test("the state banner still renders an error the transcript does not carry", () => {
  assert.equal(showStateError([], "boom"), true);
  assert.equal(showStateError([{ role: "user", content: "hi" }], "boom"), true);
  assert.equal(showStateError([failed("other error")], "boom"), true, "a different trailing error is not this error");
});

test("no banner without an error, and aborted turns show the Stopped note instead", () => {
  assert.equal(showStateError([], undefined), false);
  assert.equal(showStateError([], ""), false);
  assert.equal(showStateError([failed("aborted")], "aborted"), false);
});
