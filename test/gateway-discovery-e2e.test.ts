import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createGatewayCatalog } from "../src/model/gateway-catalog.ts";
import { setGatewayModels } from "../src/model/gateway-models.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { oneShot } from "../src/harness/pi-harness.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { runtimeConfigBody } from "../src/api/runtime-config.ts";
import { scopeId } from "../src/types.ts";

const metadata = {
  model_group: "acme/future",
  mode: "chat",
  supports_function_calling: true,
  max_input_tokens: 64000,
  max_output_tokens: 4096,
  input_cost_per_token: 0.000001,
  output_cost_per_token: 0.000002,
};

for (const protocol of ["openai", "anthropic", "unknown"] as const)
  test(`live ${protocol} gateway discovery, picker and tool continuation`, async (t) => {
    const expectedPath = { openai: "/v1/responses", anthropic: "/v1/messages", unknown: "/v1/chat/completions" }[
      protocol
    ];
    const expectedApi = { openai: "openai-responses", anthropic: "anthropic-messages", unknown: "openai-completions" }[
      protocol
    ];
    let useTool = false;
    let clockOffset = 0;
    const requests: Array<{ path: string; body: Record<string, unknown>; key: unknown }> = [];
    const upstream = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url!, body, key: req.headers["x-gateway-key"] });
      if (req.headers["x-gateway-key"] !== "company-key") {
        res.writeHead(401);
        return res.end();
      }
      if (req.url === "/v1/models" || req.url === "/model_group/info") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            data:
              req.url === "/v1/models"
                ? [{ id: "acme/future" }]
                : [
                    {
                      ...metadata,
                      providers: [protocol],
                      supports_reasoning: protocol === "anthropic",
                      supports_adaptive_thinking: protocol === "anthropic",
                    },
                  ],
          }),
        );
      }
      assert.equal(req.url, expectedPath);
      assert.equal(body.model, "acme/future");
      assert.equal(body.prompt_cache_retention, undefined);
      assert.equal(body.store, protocol === "openai" ? false : undefined);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (protocol === "anthropic") {
        if (body.thinking) assert.equal(body.thinking.type, "adaptive");
        const toolResult = body.messages.some(
          (m: { content: unknown }) =>
            Array.isArray(m.content) && m.content.some((c: { type: string }) => c.type === "tool_result"),
        );
        if (toolResult) {
          assert.ok(
            body.messages.some(
              (m: { content: unknown }) =>
                Array.isArray(m.content) &&
                m.content.some(
                  (c: { type: string; signature?: string }) =>
                    c.type === "thinking" && c.signature === "signed-thinking",
                ),
            ),
          );
        }
        const send = (type: string, data: object) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send("message_start", {
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [],
            model: body.model,
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        send("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } });
        send("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Check the tool." } });
        send("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "signed-thinking" } });
        send("content_block_stop", { index: 0 });
        if (useTool && !toolResult) {
          clockOffset += 300001;
          send("content_block_start", {
            index: 1,
            content_block: { type: "tool_use", id: "call_discovery", name: "execute", input: {} },
          });
          send("content_block_delta", {
            index: 1,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo discovery-tool-ok" }) },
          });
        } else {
          send("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
          send("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Discovered model replied" } });
        }
        send("content_block_stop", { index: 1 });
        send("message_delta", {
          delta: { stop_reason: useTool && !toolResult ? "tool_use" : "end_turn" },
          usage: { output_tokens: 20 },
        });
        send("message_stop", {});
        return res.end();
      }
      if (protocol === "openai") {
        const toolResult = body.input.some((item: { type: string }) => item.type === "function_call_output");
        const send = (type: string, data: object) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send("response.created", { response: { id: "resp_test", status: "in_progress" } });
        let item;
        if (useTool && !toolResult) {
          clockOffset += 300001;
          item = {
            type: "function_call",
            id: "fc_discovery",
            call_id: "call_discovery",
            name: "execute",
            arguments: JSON.stringify({ command: "echo discovery-tool-ok" }),
            status: "completed",
          };
        } else {
          item = {
            type: "message",
            id: "msg_test",
            role: "assistant",
            content: [{ type: "output_text", text: "Discovered model replied", annotations: [] }],
            status: "completed",
          };
        }
        send("response.output_item.added", { output_index: 0, item });
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", {
          response: {
            id: "resp_test",
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          },
        });
        return res.end();
      }
      if (useTool && !body.messages.some((m: { role: string }) => m.role === "tool")) {
        clockOffset += 300001;
        const chunk = {
          id: "test",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_discovery",
                    type: "function",
                    function: { name: "execute", arguments: JSON.stringify({ command: "echo discovery-tool-ok" }) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        );
        return res.end("data: [DONE]\n\n");
      }

      for (const [delta, finish] of [
        [{ role: "assistant", content: "Discovered model replied" }, null],
        [{}, "stop"],
      ]) {
        res.write(
          `data: ${JSON.stringify({
            id: "test",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            usage: finish ? { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } : undefined,
          })}\n\n`,
        );
      }
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      upstream.closeAllConnections();
      upstream.close();
      setGatewayModels([]);
    });
    const config = {
      url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      apiKey: "company-key",
      apiKeyHeader: "x-gateway-key",
      models: {},
    };
    const built = buildApp(
      testConfig({
        modelGateway: config,
        harness: "pi",
        piSystemCacheSplit: true,
        modelId: "gateway/acme/future",
      }),
    );
    await built.refreshModels();
    const runtime = await runtimeConfigBody(
      {
        deps: {
          config: built.config,
          harnessId: "pi",
          baseModelDefault: "gateway/acme/future",
          modelCredentials: built.modelCredentials,
          refreshModels: built.refreshModels,
        },
      },
      scopeId("org", "default-org"),
    );
    assert.deepEqual(runtime.modelsByHarness.pi, ["gateway/acme/future"]);
    assert.equal(runtime.modelCatalog["gateway/acme/future"]?.api, expectedApi);
    assert.doesNotMatch(JSON.stringify(runtime), /company-key|127\.0\.0\.1/);
    const catalog = createGatewayCatalog(config, fetch, () => Date.now() + clockOffset);
    await catalog.refresh();
    const model = resolveModel("gateway/acme/future")!;
    const reply = await oneShot("gateway-e2e", model, {}, "Reply briefly", "Hello", {
      modelGateway: catalog.transport,
    });
    assert.equal(reply, "Discovered model replied");
    assert.ok(requests.some((r) => r.path === expectedPath));
    assert.ok(requests.every((r) => r.key === "company-key"));
    useTool = true;
    const beforeRefresh = requests.filter((r) => r.path === "/v1/models").length;
    assert.equal(
      await oneShot("gateway-ttl-e2e", model, {}, "Reply briefly", "Use a tool", { modelGateway: catalog.transport }),
      "Discovered model replied",
    );
    assert.ok(requests.filter((r) => r.path === "/v1/models").length > beforeRefresh);
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "discovery-tool-loop" },
      text: "Use the execute tool, then reply.",
    });
    assert.equal(result.status, "ok");
    assert.match(result.reply ?? "", /Discovered model replied/);
    assert.ok(
      requests.some(
        (r) =>
          (Array.isArray(r.body.input) &&
            r.body.input.some((item: { type: string }) => item.type === "function_call_output")) ||
          (Array.isArray(r.body.messages) &&
            r.body.messages.some(
              (m: { role: string; content: unknown }) =>
                m.role === "tool" ||
                (Array.isArray(m.content) && m.content.some((c: { type: string }) => c.type === "tool_result")),
            )),
      ),
    );
  });

test("gateway outage leaves direct providers available", async () => {
  const built = buildApp(
    testConfig({
      anthropicApiKey: "independent-key",
      modelGateway: {
        url: "https://gateway.invalid",
        apiKey: "company-key",
        apiKeyHeader: "x-api-key",
        models: {},
      },
    }),
    { modelCredentialFetch: async () => new Response(null, { status: 503 }) },
  );
  const providers = await built.modelCredentials.availability();
  assert.equal(providers.anthropic, true);
  assert.deepEqual([...providers.modelIds!], []);
  await built.refreshModels();
});
