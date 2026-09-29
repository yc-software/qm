import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiHarness, droppedThinkingNotice } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

const dropped = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    type: "thinking_dropped",
    path: `messages.${i * 2 + 1}.content.0`,
    reason: "organization_binding_mismatch",
  }));

function anthropicStream(inputTransformations: unknown[], toolUse: boolean): Response {
  const block = toolUse
    ? { type: "tool_use", id: "toolu_attach", name: "attach", input: {} }
    : { type: "text", text: "" };
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-fable-5-1",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        input_transformations: inputTransformations,
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    toolUse
      ? { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"files":[]}' } }
      : { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: toolUse ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("a dropped-thinking report records one system entry until the API drops more", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const responses: Array<[number, boolean]> = [
    [2, true],
    [2, false],
    [2, false],
    [3, false],
  ];
  globalThis.fetch = (async () => {
    const [count, toolUse] = responses.shift()!;
    return anthropicStream(dropped(count), toolUse);
  }) as typeof fetch;
  const harness = createPiHarness({ defaultModelId: "claude-fable-5-1", apiKey: "sk-offline-test-key" });
  t.after(() => harness.turns.close?.());
  const tapeRows: NonNullable<HarnessTurnInput["tapeRows"]> = [];
  let seq = 0;
  const runTurn = async () => {
    const entries: Array<{ type: string; payload: unknown }> = [];
    const result = await harness.turns.runTurn({
      session: { id: "thinking-drops" } as HarnessTurnInput["session"],
      input: "hello",
      systemPrompt: "Reply ok.",
      history: [],
      tapeMode: "serve",
      tapeRows: [...tapeRows],
      tape: async (record) => {
        tapeRows.push({ ...record, sessionId: "thinking-drops", seq: tapeRows.length + 1, createdAt: Date.now() });
      },
      tools: { attach: async () => ({ ok: true, files: [], staged: 0 }) } as unknown as HarnessTurnInput["tools"],
      scopeLabel: "personal:test",
      orgScopeId: "org:test",
      emit: async (entry) => {
        entries.push(entry);
        return { ...entry, sessionId: "thinking-drops", parentSeq: null, seq: seq++, createdAt: Date.now() } as never;
      },
      recordModelCall: () => {},
      cancel: AbortSignal.timeout(10_000),
    });
    assert.equal(result.reply, "ok");
    return entries.filter((entry) => entry.type === "system").map((entry) => entry.payload);
  };
  assert.deepEqual(await runTurn(), [
    { kind: "thinking_dropped", count: 2, reasons: ["organization_binding_mismatch"] },
  ]);
  assert.deepEqual(await runTurn(), []);
  assert.deepEqual(await runTurn(), [
    { kind: "thinking_dropped", count: 3, reasons: ["organization_binding_mismatch"] },
  ]);
});

test("only thinking_dropped transformations count as dropped reasoning", () => {
  const diagnostic = (transformations: unknown[]) => ({
    diagnostics: [
      { type: "provider_retry", timestamp: 1 },
      { type: "anthropic_input_transformations", timestamp: 2, details: { transformations } },
    ],
  });
  assert.equal(droppedThinkingNotice({ content: [] }), undefined);
  assert.equal(droppedThinkingNotice(diagnostic([{ type: "image_resized", reason: "size" }])), undefined);
  const mixed = diagnostic([
    { type: "thinking_dropped", reason: "model_binding_mismatch" },
    { type: "image_resized", reason: "size" },
    { type: "thinking_dropped" },
  ]);
  assert.deepEqual(droppedThinkingNotice(mixed), {
    kind: "thinking_dropped",
    count: 2,
    reasons: ["model_binding_mismatch", "unknown"],
  });
  assert.equal(droppedThinkingNotice(mixed, mixed), undefined);
});
