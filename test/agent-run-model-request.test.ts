import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAgent } from "../src/agent/agent-run.ts";
import { modelRequestOverrides } from "../src/model/pi-models.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";

const modelId = "gpt-5.4";

test("Pi reports each model request to the turn before the reply streams, and only to that turn", async (t) => {
  const order: string[] = [];
  const server = createServer(async (req, res) => {
    await new Promise((resolve) => req.resume().on("end", resolve));
    order.push("served");
    const message = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
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
  const agent = createAgent({
    defaultModelId: modelId,
    modelGateway: {
      url: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      apiKeyHeader: "api-key",
      models: { [modelId]: modelRequestOverrides(modelId)?.model ?? modelId },
    },
  });
  t.after(() => agent.close?.());
  let seq = 0;
  const turn = (extra: Partial<AgentTurnInput>) =>
    agent.runTurn({
      session: { id: "model-request" } as AgentTurnInput["session"],
      input: "hello",
      systemPrompt: "Reply ok.",
      history: [],
      tools: {} as AgentTurnInput["tools"],
      scopeLabel: "personal:test",
      orgScopeId: "org:test",
      emit: async (entry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as never,
      recordModelCall: () => {},
      cancel: AbortSignal.timeout(10_000),
      ...extra,
    });
  const first = await turn({
    onModelRequest: () => order.push("request"),
    onDelta: () => order.push("delta"),
  });
  assert.equal(first.reply, "ok");
  assert.deepEqual(order, ["request", "served", "delta"]);
  order.length = 0;
  await turn({});
  assert.deepEqual(order, ["served"], "a later turn does not call the earlier turn's hook");
});
