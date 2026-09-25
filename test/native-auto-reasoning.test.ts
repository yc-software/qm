import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReasoningMode, createPiHarness } from "../src/harness/pi-harness.ts";
import { getRequiredModel, thinkingLevelsForHarness, safeModelMetadata } from "../src/model/pi-models.ts";
import { validateRuntimeChoice } from "../src/api/runtime-config.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { setGatewayModels } from "../src/model/gateway-models.ts";

const adaptiveId = "claude-sonnet-4-6";

test("native Auto is model and harness specific, while legacy auto remains valid", () => {
  for (const harnessId of ["pi", "codex", "claude", "opencode"] as const) {
    const modelId = harnessId === "codex" ? "gpt-5.4" : adaptiveId;
    assert.equal(validateRuntimeChoice({ harnessId, modelId, effortLevel: "auto" }), null);
    assert.equal(
      validateRuntimeChoice({ harnessId, modelId, effortLevel: "adaptive" }),
      harnessId === "pi" ? null : "effort_not_supported",
    );
  }
  for (const modelId of ["gpt-6-astra", "codex/gpt-5.4", "claude-haiku-4-5", "openrouter/auto"])
    assert.equal(validateRuntimeChoice({ harnessId: "pi", modelId, effortLevel: "adaptive" }), "effort_not_supported");
  assert.deepEqual(safeModelMetadata(adaptiveId)?.effortLevelsByHarness.pi, thinkingLevelsForHarness("pi", adaptiveId));
});

test("gateway capability is determined by the real API and metadata, not its model name", (t) => {
  t.after(() => setGatewayModels([]));
  const model = getRequiredModel(adaptiveId);
  setGatewayModels([
    { ...model, provider: "qm:gateway", id: "gateway/opaque", api: "anthropic-messages" },
    { ...model, provider: "qm:gateway", id: "gateway/claude-sonnet-4-6", api: "openai-completions", compat: {} },
  ]);
  assert.ok(thinkingLevelsForHarness("pi", "gateway/opaque").includes("adaptive"));
  assert.ok(!thinkingLevelsForHarness("pi", "gateway/claude-sonnet-4-6").includes("adaptive"));
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
  for (const modelId of [adaptiveId, "claude-opus-5-5"])
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
        t.after(() => harness.turns.close?.());
        for (const effortLevel of ["high", "adaptive", "default", "auto", "adaptive", "low"]) {
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
          else assert.equal(request.body.output_config?.effort, effortLevel === "auto" ? "low" : effortLevel);
          if (
            effortLevel === "default" &&
            (route === "gateway" || getRequiredModel(modelId).thinkingLevelMap?.off !== null)
          )
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
  const { createMemoryConfigStore } = await import("../src/resolution/config-store.ts");
  const { resolveRuntimeChoice } = await import("../src/harness/harness-router.ts");
  const { createRuntimeService } = await import("../src/harness/runtime-control.ts");
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "claude", "codex", "opencode"]);
  const active = { harnessId: "pi" as const, modelId: "claude-sonnet-5", effortLevel: "auto" };
  await config.setRuntimeSelectionLatest("personal:test", active);
  const service = createRuntimeService({ config, harnessId: "pi" }, { authorizesCapabilityScope: async () => true });
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
  await config.setRuntimeSelectionLatest("personal:test", active);
  assert.equal(resolveRuntimeChoice(config, "org:default-org", "personal:test", active).effortLevel, "auto");
});
