import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { builtInModelCatalog } from "../src/model/model-catalog.ts";
import {
  modelRequestOverrides,
  modelSupportedByHarness,
  parseEffort,
  resolveModel,
  thinkingLevelsForHarness,
} from "../src/model/pi-models.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

const sse = (events: Array<Record<string, unknown>>) =>
  new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const anthropicReply = (model: string) =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        model,
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);

const openaiReply = (model: string) => {
  const message = {
    id: "msg",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  return sse([
    { type: "response.created", response: { id: "resp", model, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp",
        model,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
};

test("Pi sends every catalog model's offered effort to the provider exactly as selected", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return String(url).includes("/messages") ? anthropicReply(body.model) : openaiReply(body.model);
  }) as typeof fetch;
  const modelIds = builtInModelCatalog()
    .map((model) => model.id)
    .filter((id) => modelSupportedByHarness(id, "pi") && thinkingLevelsForHarness("pi", id).length > 1);
  assert.ok(modelIds.some((id) => resolveModel(id)?.api === "anthropic-messages"));
  assert.ok(modelIds.some((id) => resolveModel(id)?.api === "openai-responses"));
  assert.ok(modelIds.includes("claude-sonnet-5-5"));
  for (const modelId of modelIds) {
    const harness = createPiHarness({ defaultModelId: modelId });
    t.after(() => harness.turns.close?.());
    const anthropic = resolveModel(modelId)!.api === "anthropic-messages";
    for (const level of thinkingLevelsForHarness("pi", modelId).filter((level) => level !== "auto")) {
      await t.test(`${modelId} ${level}`, async () => {
        const result = await harness.turns.runTurn({
          session: { id: `catalog-${modelId}` } as HarnessTurnInput["session"],
          input: "hello",
          systemPrompt: "Reply ok.",
          history: [],
          tools: {} as HarnessTurnInput["tools"],
          scopeLabel: "personal:test",
          orgScopeId: "org:test",
          providerKeys: { anthropic: "sk-offline-test", openai: "sk-offline-test" },
          runtime: { modelId, effortLevel: parseEffort("pi", modelId, level) },
          emit: async (entry) => ({ ...entry, seq: 1, createdAt: Date.now() }) as never,
          recordModelCall: () => {},
          cancel: AbortSignal.timeout(10_000),
        });
        assert.equal(result.reply, "ok");
        const body = bodies.at(-1)!;
        assert.equal(body.model, modelRequestOverrides(modelId)?.model ?? resolveModel(modelId)!.id);
        const sent = anthropic ? body.output_config?.effort : body.reasoning?.effort;
        assert.equal(sent, level === "default" || level === "adaptive" ? undefined : level);
        if (level === "adaptive") assert.equal(body.thinking?.type, "adaptive");
      });
    }
  }
});
