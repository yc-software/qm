import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

// Exercise the real AgentSession and SDK serializer, not just the effort setter.
for (const [modelId, upper, allowed] of [
  ["gpt-5.4", "xhigh", ["none", "low", "medium", "high", "xhigh"]],
  ["gpt-5", "high", ["minimal", "low", "medium", "high"]],
] as const) {
  test(`Pi sends supported reasoning through HTTP for ${modelId}`, async (t) => {
    const bodies: Array<{ reasoning?: { effort?: string } }> = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      bodies.push(body);
      if (!(allowed as readonly string[]).includes(body.reasoning?.effort)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported reasoning.effort", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const message = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      };
      for (const event of [
        { type: "response.created", response: { id: "resp_test", model: modelId, status: "in_progress", output: [] } },
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
            id: "resp_test",
            model: modelId,
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
    const address = server.address();
    assert(address && typeof address !== "string");
    const originalMap = structuredClone(getRequiredModel(modelId).thinkingLevelMap);
    const harness = createPiHarness({
      defaultModelId: modelId,
      modelGateway: {
        url: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key",
        apiKeyHeader: "api-key",
        models: { [modelId]: modelId },
      },
    });
    t.after(() => harness.turns.close?.());
    // Repeat turns in the same conversation with different effort selections.
    for (const [effortLevel, expected] of [
      ["ultracode", upper],
      ["max", upper],
      ["medium", "medium"],
      ["low", "low"],
      ["high", "high"],
      ["minimal", modelId === "gpt-5" ? "minimal" : "low"],
      ["off", modelId === "gpt-5" ? "minimal" : "none"],
      ["xhigh", upper],
      ["auto", "medium"],
    ]) {
      await t.test(effortLevel!, async () => {
        let seq = 0;
        const result = await harness.turns.runTurn({
          session: { id: `effort-${modelId}` } as HarnessTurnInput["session"],
          input: "hello",
          systemPrompt: "Reply ok.",
          history: [],
          tools: {} as HarnessTurnInput["tools"],
          scopeLabel: "personal:test",
          orgScopeId: "org:test",
          runtime: { effortLevel },
          emit: async (entry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as never,
          recordModelCall: () => {},
          cancel: AbortSignal.timeout(10_000),
        });
        assert.equal(result.reply, "ok");
        assert.equal(bodies.at(-1)?.reasoning?.effort, expected);
      });
    }
    assert.deepEqual(
      getRequiredModel(modelId).thinkingLevelMap,
      originalMap,
      "must not widen the model's supported efforts",
    );
  });
}
