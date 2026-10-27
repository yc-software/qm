import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { applyReasoningMode, buildModelRuntime } from "../../src/harness/pi-model-runtime.ts";
import { createPiHarness } from "../../src/harness/pi-harness.ts";
import {
  getRequiredModel,
  thinkingLevelsFor,
  safeModelMetadata,
  CODEX_SUBSCRIPTION_PROVIDER,
} from "../../src/model/pi-models.ts";
import { validateRuntimeChoice } from "../../src/api/runtime-config.ts";
import type { HarnessTurnInput } from "../../src/harness/harness.ts";
import { setGatewayModels } from "../../src/model/gateway-models.ts";
import { testConfigStore } from "../support/test-database.ts";
import { zstdDecompressSync } from "node:zlib";

const adaptiveId = "claude-sonnet-4-6";

test("native Auto is model specific, while legacy auto remains valid", () => {
  assert.equal(validateRuntimeChoice({ modelId: adaptiveId, effortLevel: "auto" }), null);
  assert.equal(validateRuntimeChoice({ modelId: adaptiveId, effortLevel: "adaptive" }), null);
  for (const modelId of ["gpt-6-astra", "codex/gpt-5.4", "claude-haiku-4-5", "openrouter/auto"])
    assert.equal(validateRuntimeChoice({ modelId, effortLevel: "adaptive" }), "effort_not_supported");
  assert.deepEqual(safeModelMetadata(adaptiveId)?.effortLevels, thinkingLevelsFor(adaptiveId));
});

test("gateway capability is determined by the real API and metadata, not its model name", (t) => {
  t.after(() => setGatewayModels([]));
  const model = getRequiredModel(adaptiveId);
  setGatewayModels([
    { ...model, provider: "qm:gateway", id: "gateway/opaque", api: "anthropic-messages" },
    { ...model, provider: "qm:gateway", id: "gateway/claude-sonnet-4-6", api: "openai-completions", compat: {} },
  ]);
  assert.ok(thinkingLevelsFor("gateway/opaque").includes("adaptive"));
  assert.ok(!thinkingLevelsFor("gateway/claude-sonnet-4-6").includes("adaptive"));
});

test("mode serialization retains unrelated output configuration and rejects unsupported Auto", () => {
  const payload = {
    thinking: { type: "enabled", budget_tokens: 1000 },
    output_config: { effort: "high", format: "json" },
  };
  assert.deepEqual(applyReasoningMode(payload, getRequiredModel(adaptiveId), "adaptive"), {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { format: "json" },
  });
  assert.throws(() => applyReasoningMode({}, getRequiredModel("gpt-5.4"), "adaptive"), /not supported/);
});

test("real Pi AgentSession and Anthropic serializer send Auto without a fixed effort across credential routes", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ headers: Headers; body: Record<string, any> }> = [];
  let sendTool = false;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const events: Array<Record<string, unknown>> = [
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: adaptiveId,
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    if (sendTool) {
      sendTool = false;
      events.splice(
        1,
        4,
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Use the attachment tool." },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "test-preserved-signature" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "attach-native-auto", name: "attach", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ files: ["test.txt"] }) },
        },
        { type: "content_block_stop", index: 1 },
      );
      events[events.length - 2] = {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 10 },
      };
    }
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  for (const modelId of [adaptiveId, "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
    for (const route of ["api-key", "personal-key", "oauth", "gateway"] as const) {
      await t.test(`${modelId}/${route}`, async () => {
        const harness = createPiHarness({
          defaultModelId: modelId,
          ...(route === "gateway"
            ? {
                modelGateway: {
                  url: "https://gateway.invalid",
                  apiKey: "test-key",
                  apiKeyHeader: "x-gateway-key",
                  models: { [modelId]: "routed-model" },
                },
              }
            : { apiKey: "sk-offline-test-key" }),
        });
        const mandatoryThinking = getRequiredModel(modelId).thinkingLevelMap?.off === null;
        for (const effortLevel of [
          "high",
          "adaptive",
          "default",
          "auto",
          "adaptive",
          "low",
          ...(mandatoryThinking ? ["xhigh", "max", "ultracode", "medium"] : []),
        ]) {
          sendTool = true;
          const result = await harness.turns.runTurn({
            session: { id: `native-auto-${modelId}-${route}` } as HarnessTurnInput["session"],
            input: "Reply OK",
            systemPrompt: "Reply OK",
            history: [],
            tools: { attach: async () => ({ ok: true, files: [], staged: 0 }) } as unknown as HarnessTurnInput["tools"],
            scopeLabel: "personal:test",
            orgScopeId: "org:test",
            runtime: { effortLevel },
            ...(route === "personal-key" || route === "oauth"
              ? { providerKeys: { anthropic: route === "oauth" ? "sk-ant-oat-offline-test" : "sk-personal-test" } }
              : {}),
            emit: async (entry) => ({ ...entry, seq: 1, createdAt: Date.now() }) as never,
            recordModelCall: () => {},
            cancel: AbortSignal.timeout(10_000),
          });
          assert.equal(result.reply, "OK");
          const request = requests.at(-1)!;
          const assistant = request.body.messages.find((message: { role: string }) => message.role === "assistant");
          assert.deepEqual(
            assistant.content.find((block: { type: string }) => block.type === "thinking"),
            { type: "thinking", thinking: "Use the attachment tool.", signature: "test-preserved-signature" },
          );
          assert.equal(request.body.temperature, undefined);
          assert.equal(request.body.thinking?.budget_tokens, undefined);
          assert.equal(request.body.max_tokens, getRequiredModel(modelId).maxTokens);
          if (effortLevel === "adaptive" || effortLevel === "default")
            assert.equal(request.body.output_config?.effort, undefined);
          else
            assert.equal(
              request.body.output_config?.effort,
              { auto: "low", ultracode: "max" }[effortLevel] ?? effortLevel,
            );
          if (effortLevel === "default" && (route === "gateway" || !mandatoryThinking))
            assert.equal(request.body.thinking, undefined);
          else assert.equal(request.body.thinking?.type, "adaptive");
          if (route === "gateway") {
            assert.equal(request.body.model, "routed-model");
            assert.equal(request.headers.get("x-gateway-key"), "test-key");
          }
          if (route === "oauth") assert.match(request.headers.get("authorization") ?? "", /^Bearer /);
          if (route === "personal-key") assert.equal(request.headers.get("x-api-key"), "sk-personal-test");
        }
      });
    }
});

test("runtime scope writes and turn dispatch reject unsupported modes without changing legacy selections", async () => {
  const { resolveRuntimeChoice } = await import("../../src/harness/runtime-choice.ts");
  const { createRuntimeService } = await import("../../src/harness/runtime-control.ts");
  const config = testConfigStore();
  const active = { modelId: "claude-sonnet-5", effortLevel: "auto" };
  await config.setRuntimeSelection("personal:test", active);
  const service = createRuntimeService({ config }, { authorizesCapabilityScope: async () => true });
  const claims = { actorId: "test", scopeId: "personal:test" as const, liveActor: true, exp: Date.now() + 60_000 };
  for (const effort of ["adaptive", "default"]) {
    const result = await service(claims, active, { action: "set", effort, lifetime: "scope" });
    assert.equal(result.ok, true);
    assert.equal(resolveRuntimeChoice(config, "org:default-org", "personal:test", active).effortLevel, effort);
  }
  assert.deepEqual(
    await service(claims, active, { action: "set", effort: "adaptive", model: "gpt-6-astra", lifetime: "scope" }),
    { ok: false, error: "effort_not_supported" },
  );
  assert.equal(config.getRuntimeSelection("personal:test")?.effortLevel, "default");
  assert.throws(
    () =>
      resolveRuntimeChoice(config, "org:default-org", "personal:test", active, {
        modelId: "gpt-6-astra",
        effortLevel: "adaptive",
      }),
    /not supported/,
  );
  await config.setRuntimeSelection("personal:test", active);
  assert.equal(resolveRuntimeChoice(config, "org:default-org", "personal:test", active).effortLevel, "auto");
});

const subscriptionToken = `e30.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
).toString("base64url")}.test`;

test("a derived ChatGPT access token authenticates pi-ai's oauth-only codex provider for its own runtime only", async () => {
  const runtime = await buildModelRuntime({ [CODEX_SUBSCRIPTION_PROVIDER]: subscriptionToken });
  assert.equal(runtime.hasConfiguredAuth(CODEX_SUBSCRIPTION_PROVIDER), true);
  assert.equal((await runtime.getAuth(CODEX_SUBSCRIPTION_PROVIDER))?.auth.apiKey, subscriptionToken);
  const metered = await buildModelRuntime({ openai: "sk-metered-test-key" });
  assert.equal(metered.hasConfiguredAuth(CODEX_SUBSCRIPTION_PROVIDER), false);
  assert.equal(await metered.getAuth(CODEX_SUBSCRIPTION_PROVIDER), undefined);
});

test("codex subscription requests reach chatgpt.com with the bare model id on both streaming paths", async (t) => {
  const runtime = await buildModelRuntime({ [CODEX_SUBSCRIPTION_PROVIDER]: subscriptionToken });
  const model = getRequiredModel("codex/gpt-5.6-sol");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const method of ["stream", "streamSimple"] as const) {
    let request: { url: string; body: { model?: string } } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const encoded = new Headers(init?.headers).get("content-encoding") === "zstd";
      const text = encoded ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body);
      request = { url: String(url), body: JSON.parse(text) as { model?: string } };
      return new Response(JSON.stringify({ error: { message: "offline test response" } }), { status: 400 });
    }) as typeof fetch;
    const response = await runtime[method](
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { transport: "sse", maxRetries: 0 },
    ).result();
    assert.ok(request, `${method} must reach the provider request: ${response.errorMessage ?? "no error"}`);
    assert.match(request.url, /^https:\/\/chatgpt\.com\/backend-api\//);
    assert.equal(request.body.model, "gpt-5.6-sol", `${method} must send the provider's own model id`);
    assert.equal(response.model, "codex/gpt-5.6-sol", `${method} keeps QM's namespaced id on the assistant message`);
  }
});

const bindingBeta = "thinking-binding-controls-2026-08-01";
const context = { messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 0 }] };

for (const modelId of ["claude-opus-5-5", "claude-sonnet-5-5"])
  test(`${modelId} wire requests keep mandatory thinking, caller hooks and beta headers across Pi entry points`, (t) =>
    assertMandatoryThinkingWire(t, modelId));

test("claude-haiku-5-5 wire requests bind adaptive thinking at every effort", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return okStream("claude-haiku-5-5");
  }) as typeof fetch;
  const model = getRequiredModel("claude-haiku-5-5");
  const runtime = await buildModelRuntime({ anthropic: "sk-offline-test-key" });
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const response = await runtime.streamSimple(model, context, { reasoning: effort, maxRetries: 0 }).result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    const request = requests.at(-1)!;
    assert.ok(request.headers.get("anthropic-beta")?.includes(bindingBeta));
    assert.deepEqual(request.body.thinking, {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    assert.deepEqual(request.body.output_config, { effort });
    assert.equal(request.body.temperature, undefined);
  }
});

function okStream(modelId: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function assertMandatoryThinkingWire(t: TestContext, modelId: string): Promise<void> {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return okStream(modelId);
  }) as typeof fetch;
  const model = { ...getRequiredModel(modelId), headers: { "anthropic-beta": "prior-beta" } };
  const runtime = await buildModelRuntime({ anthropic: "sk-offline-test-key" });
  for (const effort of [undefined, "low", "xhigh", "max"] as const) {
    const response = await runtime
      .streamSimple(model, context, {
        reasoning: effort,
        maxRetries: 0,
        onPayload: (payload) => ({ ...(payload as object), metadata: { user_id: "caller-hook" } }),
      })
      .result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    const request = requests.at(-1)!;
    assert.ok(request.headers.get("anthropic-beta")?.includes("prior-beta"));
    assert.ok(request.headers.get("anthropic-beta")?.includes(bindingBeta));
    assert.deepEqual(request.body.thinking, {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    assert.deepEqual(request.body.metadata, { user_id: "caller-hook" });
    if (effort) assert.deepEqual(request.body.output_config, { effort });
  }
  const streamed = await runtime.stream(model, context, { maxRetries: 0 }).result();
  assert.equal(streamed.stopReason, "stop", streamed.errorMessage);
  assert.deepEqual(requests.at(-1)!.body.thinking, {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  assert.deepEqual(model.headers, { "anthropic-beta": "prior-beta" });

  const gateway = await buildModelRuntime(
    {},
    {
      url: "https://gateway.invalid",
      apiKey: "test-gateway-key",
      apiKeyHeader: "x-test-key",
      models: { [model.id]: "routed-opus" },
    },
  );
  await gateway.streamSimple(model, context, { reasoning: "low", maxRetries: 0 }).result();
  const routed = requests.at(-1)!;
  assert.equal(routed.body.model, "routed-opus");
  assert.equal(routed.headers.get("x-test-key"), "test-gateway-key");
  assert.ok(!routed.headers.get("anthropic-beta")?.includes(bindingBeta));
  assert.deepEqual(routed.body.thinking, { type: "adaptive", display: "summarized" });

  await runtime
    .streamSimple(getRequiredModel("claude-haiku-4-5"), context, { reasoning: "low", maxRetries: 0 })
    .result();
  const haiku = requests.at(-1)!;
  assert.ok(!haiku.headers.get("anthropic-beta")?.includes(bindingBeta));
  assert.ok(haiku.headers.get("anthropic-beta")?.includes("interleaved-thinking"));
}
