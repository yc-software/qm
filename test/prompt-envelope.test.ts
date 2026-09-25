import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { promptEnvelopeWithoutHistory } from "../src/harness/harness.ts";
import { sanitizeLlmPayload } from "../src/harness/pi-harness.ts";
import { promptEnvelopeBody } from "../src/sessions/session-store.ts";

const cases: Array<{
  name: string;
  payload: (history: string[], instruction: string, tool: string) => unknown;
}> = [
  {
    name: "Anthropic and Bedrock messages",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      system: [{ text: instruction }],
      tools: [{ name: tool }],
      messages: history.map((text) => ({ role: "user", content: [{ text }] })),
    }),
  },
  {
    name: "Chat Completions and Mistral messages",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      temperature: 0.5,
      tools: [{ type: "function", function: { name: tool } }],
      messages: [
        { role: "system", content: instruction },
        ...history.map((content) => ({ role: "user" as const, content })),
        { role: "developer", content: "developer instruction" },
        { role: "assistant", content: "answer" },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    }),
  },
  {
    name: "OpenAI and Azure Responses input",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      tools: [{ type: "function", name: tool, parameters: {}, strict: false }],
      input: [
        { role: "system", content: instruction },
        ...history.map((text) => ({ role: "user" as const, content: [{ type: "input_text" as const, text }] })),
        { type: "message", role: "developer", content: [{ type: "input_text", text: "developer instruction" }] },
        { type: "function_call", call_id: "call_1", name: tool, arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "result" },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "reasoning" },
      ],
    }),
  },
  {
    name: "Codex Responses instructions",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      instructions: instruction,
      tools: [{ type: "function", name: tool, parameters: {}, strict: false }],
      input: history.map((content) => ({ role: "user", content })),
    }),
  },
  {
    name: "Responses string input",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      instructions: instruction,
      tools: [{ type: "function", name: tool, parameters: {}, strict: false }],
      input: history.join("\n"),
    }),
  },
  {
    name: "Gemini and Vertex contents",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      config: { systemInstruction: instruction, tools: [{ functionDeclarations: [{ name: tool }] }] },
      contents: history.map((text) => ({ role: "user", parts: [{ text }] })),
    }),
  },
  {
    name: "Pi messages context",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      options: { temperature: 0.5 },
      context: {
        systemPrompt: instruction,
        tools: [{ name: tool, description: "test tool", parameters: { type: "object", properties: {} } }],
        messages: history.map((content) => ({ role: "user", content, timestamp: 1 })),
      } satisfies Context,
    }),
  },
];

for (const { name, payload } of cases) {
  test(`${name}: capture hashes ignore history but retain instructions and tools without mutation`, () => {
    const first = payload(["hello"], "be helpful", "lookup");
    const grown = payload(["hello", "another user message", "tool result"], "be helpful", "lookup");
    const original = structuredClone(grown);
    for (const extract of [promptEnvelopeWithoutHistory, (value: unknown) => sanitizeLlmPayload(value).envelope]) {
      const envelope = extract(grown);
      assert.deepEqual(grown, original);
      const body = promptEnvelopeBody(envelope)!;
      assert.equal(body.hash, promptEnvelopeBody(extract(first))!.hash);
      assert.notEqual(body.hash, promptEnvelopeBody(extract(payload([], "new instruction", "lookup")))!.hash);
      assert.notEqual(body.hash, promptEnvelopeBody(extract(payload([], "be helpful", "other_tool")))!.hash);
      assert.match(body.body, /be helpful/);
      assert.match(body.body, /lookup/);
      assert.doesNotMatch(body.body, /hello|another user message|tool result|reasoning|call_1/);
      if (name.includes("Chat") || name.includes("Azure")) assert.match(body.body, /developer instruction/);
    }
    assert.equal(sanitizeLlmPayload(grown).truncated, false);
  });
}

test("empty histories and malformed payloads do not add envelope fields or throw", () => {
  for (const value of [null, undefined, "text", 12, []]) assert.equal(promptEnvelopeWithoutHistory(value), value);
  for (const value of [null, "history", [], [{ role: "user", content: "hello" }]]) {
    assert.deepEqual(promptEnvelopeWithoutHistory({ messages: value, input: value, contents: value }), {});
  }
  assert.deepEqual(promptEnvelopeWithoutHistory({ input: [null, 1, {}, { role: "user" }] }), {});
});
