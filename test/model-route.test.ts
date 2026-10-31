import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent, type AgentOptions } from "../src/agent/agent-run.ts";
import type { AgentTurnInput, CompactInput } from "../src/agent/agent.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { ProviderTurnError } from "../src/core/turn-error.ts";
import { buildModelRuntime } from "../src/model/model-runtime.ts";
import { lastGatewayBudgetRejection } from "../src/model/model-route.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import { runtimeConfigBody } from "../src/api/runtime-config.ts";
import { testConfigStore } from "./support/test-database.ts";
import { orgScope } from "../src/config.ts";

const GATEWAY = {
  url: "https://gateway.example/v1",
  apiKey: "sk-gateway",
  apiKeyHeader: "x-gateway-key",
  models: { "gpt-6-astra": "openai/gpt-6-astra" },
};

const HISTORY = [
  { seq: 1, type: "user", payload: { text: "hello" }, createdAt: 1 },
  { seq: 2, type: "assistant", payload: { text: "hi" }, createdAt: 2 },
] as unknown as SessionEntry[];

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type as string}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function anthropicReply(text: string, stopReason = "end_turn"): Response {
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return sse([
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "c", usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function budgetRejection(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Budget has been exceeded! Current cost: 12.01, Max budget: 12.0",
        type: "budget_exceeded",
        param: null,
        code: "400",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function errorReply(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetch<T>(
  respond: (url: string, body: Record<string, unknown>) => Response,
  run: (calls: Array<{ host: string; model: unknown }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ host: string; model: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ host: new URL(url).host, model: body.model });
    return respond(url, body);
  }) as typeof globalThis.fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function compact(agent: ReturnType<typeof createAgent>, route: Partial<CompactInput> = {}): Promise<string> {
  return agent.compactHistory!({
    session: { id: "route-compaction" } as CompactInput["session"],
    history: HISTORY,
    recordModelCall: () => {},
    ...route,
  });
}

function turn(agent: ReturnType<typeof createAgent>, modelId: string): Promise<unknown> {
  let seq = 0;
  return agent.runTurn({
    session: { id: `route-turn-${modelId}` } as AgentTurnInput["session"],
    input: "hello",
    systemPrompt: "BASE",
    history: [],
    tools: {} as AgentTurnInput["tools"],
    scopeLabel: "personal:tester" as AgentTurnInput["scopeLabel"],
    orgScopeId: "org:test" as AgentTurnInput["orgScopeId"],
    runtime: { modelId },
    emit: async (entry: NewEntry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as unknown as SessionEntry,
    recordModelCall: () => {},
  });
}

test("compaction summarizes on the session's own provider while the shared gateway is out of budget", async (t) => {
  setCustomProviders([
    {
      id: "direct",
      name: "Direct",
      protocol: "anthropic",
      baseUrl: "https://direct.example",
      models: [{ id: "claude-opus-5-5" }],
    },
  ]);
  t.after(() => setCustomProviders([]));
  const agent = createAgent({
    defaultModelId: "gpt-6-astra",
    modelGateway: GATEWAY,
    resolveProviderKeys: async () => ({ direct: "sk-direct" }),
  });
  await withFetch(
    (url) => (url.includes("gateway.example") ? budgetRejection() : anthropicReply("summary of the work")),
    async (calls) => {
      const text = await compact(agent, { runtime: { modelId: "custom/direct/claude-opus-5-5" } });
      assert.match(text, /summary of the work/);
      assert.deepEqual(calls, [{ host: "direct.example", model: "claude-opus-5-5" }]);
    },
  );
});

test("an out-of-budget summary moves to the configured fallback on another account", async () => {
  const agent = createAgent({
    defaultModelId: "gpt-6-astra",
    modelGateway: GATEWAY,
    resolveProviderKeys: async () => ({ anthropic: "sk-anthropic" }),
    resolveFallbackRuntime: () => ({ modelId: "claude-sonnet-5" }),
  });
  await withFetch(
    (url) => (url.includes("gateway.example") ? budgetRejection() : anthropicReply("fallback summary")),
    async (calls) => {
      assert.match(await compact(agent), /fallback summary/);
      assert.deepEqual(
        calls.map((call) => call.host),
        ["gateway.example", "api.anthropic.com"],
      );
    },
  );
});

test("a summary that fails everywhere names each route it tried and why", async () => {
  const agent = createAgent({
    defaultModelId: "gpt-6-astra",
    modelGateway: GATEWAY,
    resolveProviderKeys: async () => ({ anthropic: "sk-anthropic" }),
    resolveFallbackRuntime: () => ({ modelId: "claude-sonnet-5" }),
  });
  await withFetch(
    (url) =>
      url.includes("gateway.example") ? budgetRejection() : errorReply(401, "authentication_error", "key revoked"),
    async () => {
      const error = await compact(agent).then(
        () => assert.fail("the summary should fail"),
        (e: unknown) => e,
      );
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.code, "model_budget");
      assert.match(error.message, /shared model gateway.*Budget has been exceeded/s);
      assert.match(error.message, /fallback .*organization's own provider key.*key revoked/s);
    },
  );
});

test("a refusal with no configured fallback stays on the refused model", async () => {
  const agent = createAgent({ apiKey: "sk-anthropic", openaiApiKey: "sk-openai" });
  await withFetch(
    () => anthropicReply("", "refusal"),
    async (calls) => {
      const error = await turn(agent, "claude-sonnet-5").then(
        () => assert.fail("the refused turn should fail"),
        (e: unknown) => e,
      );
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.code, "refusal");
      assert.deepEqual(
        calls.map((call) => call.model),
        ["claude-sonnet-5"],
      );
    },
  );
});

test("a fallback that fails keeps the original refusal and says what happened to the fallback", async () => {
  const options: AgentOptions = {
    apiKey: "sk-anthropic",
    modelGateway: GATEWAY,
    resolveFallbackRuntime: () => ({ modelId: "gpt-6-astra" }),
  };
  const agent = createAgent(options);
  await withFetch(
    (url) => (url.includes("gateway.example") ? budgetRejection() : anthropicReply("", "refusal")),
    async (calls) => {
      const error = await turn(agent, "claude-sonnet-5").then(
        () => assert.fail("the refused turn should fail"),
        (e: unknown) => e,
      );
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.code, "refusal");
      assert.match(error.message, /fallback .*shared model gateway.*Budget has been exceeded/s);
      assert.deepEqual(
        calls.map((call) => call.host),
        ["api.anthropic.com", "gateway.example"],
      );
    },
  );
});

test("helper calls run on the org's utility model, not the deployment default", async () => {
  const agent = createAgent({
    defaultModelId: "claude-opus-5-5",
    resolveBaseModelId: () => "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ anthropic: "sk-anthropic", openai: "sk-openai" }),
  });
  await withFetch(
    () => errorReply(400, "invalid_request_error", "stop here"),
    async (calls) => {
      await agent.oneShot!("system", "remember this").catch(() => undefined);
      await agent.generateTitle!("a transcript").catch(() => undefined);
      assert.deepEqual(
        calls.map((call) => call.model),
        ["gpt-5.6-luna", "gpt-5.6-luna"],
      );
    },
  );
});

test("the runtime listing says which account each model bills and when the gateway last ran out of budget", async () => {
  const deps = {
    config: testConfigStore("default-org"),
    baseModelDefault: "claude-sonnet-5",
    modelCredentials: {
      availability: async () => ({ anthropic: true, modelIds: new Set(["gpt-6-astra"]) }),
    },
  } as unknown as Parameters<typeof runtimeConfigBody>[0]["deps"];
  await deps.config!.setWebuiModels(orgScope(), ["claude-sonnet-5", "gpt-6-astra"]);
  const runtime = await buildModelRuntime({}, GATEWAY);
  const call = () =>
    runtime
      .streamSimple(getRequiredModel("gpt-6-astra"), { messages: [{ role: "user", content: "hi", timestamp: 0 }] })
      .result();

  await withFetch(budgetRejection, async () => {
    await call();
  });
  const listed = await runtimeConfigBody({ deps }, orgScope());
  assert.equal(listed.modelCatalog["claude-sonnet-5"]?.billing, "org_key");
  assert.equal(listed.modelCatalog["gpt-6-astra"]?.billing, "model_gateway");
  assert.match(listed.gatewayBudgetRejected?.error ?? "", /Budget has been exceeded/);

  await withFetch(
    () => errorReply(400, "invalid_request_error", "a request problem, not a budget"),
    async () => {
      await call();
    },
  );
  assert.ok(lastGatewayBudgetRejection(), "an unrelated failure leaves the budget note in place");
  await withFetch(
    () =>
      sse([
        { type: "response.created", response: { id: "r", status: "in_progress", output: [] } },
        { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } },
      ]),
    async () => {
      await call();
    },
  );
  assert.equal((await runtimeConfigBody({ deps }, orgScope())).gatewayBudgetRejected, undefined);
});
