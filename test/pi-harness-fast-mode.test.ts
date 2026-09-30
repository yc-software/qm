import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTurnEffort,
  applyFastSpeed,
  applyThinkingBinding,
  piUsageToCallUsage,
  scaleCost,
  withRequestHeaders,
  FAST_COST_MULTIPLIER,
  modelSupportsFastMode,
  wantsFastMode,
  createPiHarness,
} from "../src/harness/pi-harness.ts";
import type { PiHarnessOptions } from "../src/harness/pi-harness.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { defaultInteractiveThinkingLevel, getRequiredModel } from "../src/model/pi-models.ts";

test("modelSupportsFastMode allows only the documented direct Opus ids and the GPT-5.6 family (priority tier)", () => {
  for (const id of [
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]) {
    assert.equal(modelSupportsFastMode(id), true, `${id} should support fast mode`);
  }
  for (const id of [
    "claude-sonnet-4-6",
    "claude-haiku-4-5",

    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4.8",
    "anthropic/claude-opus-4.8-fast",
    "",
    undefined,
  ]) {
    assert.equal(modelSupportsFastMode(id as string | undefined), false, `${String(id)} must not support fast mode`);
  }
});

test("scaleCost doubles OpenAI per-token rates for fast mode", () => {
  const scaled = scaleCost({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, FAST_COST_MULTIPLIER);
  assert.deepEqual(scaled, { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 });
});

test('applyFastSpeed injects speed:"fast" (Anthropic) or service_tier:"priority" (OpenAI) only when fast is requested, and never throws on non-object payloads', () => {
  const on = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  assert.equal(applyFastSpeed(on, true), on, "returns the same object (in-place mutation)");
  assert.equal(on.speed, "fast");

  const off = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  applyFastSpeed(off, false);
  applyFastSpeed(off, undefined);
  assert.equal("speed" in off, false, "no speed field on a non-fast turn");

  const openai = { model: "gpt-5.6-sol", input: [] } as Record<string, unknown>;
  applyFastSpeed(openai, true, "openai-responses");
  assert.equal(openai.service_tier, "priority");
  assert.equal("speed" in openai, false, "no Anthropic speed field on an OpenAI request");
  const openaiOff = { model: "gpt-5.6-sol", input: [] } as Record<string, unknown>;
  applyFastSpeed(openaiOff, false, "openai-responses");
  assert.equal("service_tier" in openaiOff, false);

  assert.doesNotThrow(() => applyFastSpeed(undefined, true));
  assert.doesNotThrow(() => applyFastSpeed(null, true));
  assert.doesNotThrow(() => applyFastSpeed("raw", true));
});

test("defaultInteractiveThinkingLevel keeps human turns light by provider", () => {
  assert.equal(defaultInteractiveThinkingLevel({ provider: "anthropic", api: "anthropic-messages" }), "low");
  assert.equal(defaultInteractiveThinkingLevel({ provider: "openai", api: "openai-responses" }), "auto");
});

test("fast mode requires an explicit opt-in on a supported model", () => {
  assert.equal(wantsFastMode(undefined, "claude-opus-5"), false);
  assert.equal(wantsFastMode(false, "claude-opus-5"), false);
  assert.equal(wantsFastMode(true, "claude-opus-5"), true);
  assert.equal(wantsFastMode(true, "claude-sonnet-5"), false);
});

test("auto resets a reused Anthropic session to its interactive default", () => {
  const session = {
    state: {
      model: { provider: "anthropic", api: "anthropic-messages" },
      thinkingLevel: "high",
    },
    setThinkingLevel(level: string) {
      this.state.thinkingLevel = level;
    },
  };
  applyTurnEffort(session as never, "auto");
  assert.equal(session.state.thinkingLevel, "low");
});

const ASTRA = getRequiredModel("gpt-6-astra", false) as Model<Api>;
const SOL_61 = getRequiredModel("gpt-6.1-sol", false) as Model<Api>;
const OPUS_55 = getRequiredModel("claude-opus-5-5", false);
const SONNET_55 = getRequiredModel("claude-sonnet-5-5", false);
const OPUS = getRequiredModel("claude-opus-5", false) as Model<Api>;
const ASTRA_TOKENS = { input: 10_000, output: 2_000, cacheRead: 50_000, cacheWrite: 4_000, totalTokens: 66_000 };

function assertUsd(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected $${expected}, recorded $${actual}`);
}

const pricingCases: Array<[string, Model<Api>, Partial<Usage>, number]> = [
  ["mixed tokens", ASTRA, ASTRA_TOKENS, 0.3],
  ["cache reads", ASTRA, { cacheRead: 100_000 }, 0.1],
  ["cache writes", ASTRA, { cacheWrite: 8_000 }, 0.1],
  ["high-input boundary", ASTRA, { input: 272_000 }, 2.72],
  ["high-input tier", ASTRA, { input: 300_000 }, 6],
  ["GPT-6.1 Sol mixed tokens", SOL_61, ASTRA_TOKENS, 0.055],
  ["GPT-6.1 Sol cache reads at 5% of input", SOL_61, { cacheRead: 100_000 }, 0.01],
  ["GPT-6.1 Sol high-input tier", SOL_61, { input: 300_000 }, 1.2],
  [
    "mixed 1h writes",
    OPUS,
    { input: 10_000, output: 1_000, cacheRead: 40_000, cacheWrite: 16_000, cacheWrite1h: 8_000 },
    0.225,
  ],
  [
    "Opus 5.5 mixed tokens and cache durations",
    OPUS_55,
    { input: 10_000, output: 1_000, cacheRead: 40_000, cacheWrite: 16_000, cacheWrite1h: 8_000 },
    0.172,
  ],
  ["Opus 5.5 cache reads", OPUS_55, { cacheRead: 100_000 }, 0.02],
  ["Opus 5.5 1h writes", OPUS_55, { cacheWrite: 4_000, cacheWrite1h: 4_000 }, 0.032],
  ["Sonnet 5.5 1h writes", SONNET_55, { cacheWrite: 4_000, cacheWrite1h: 4_000 }, 0.016],
  ["all 1h writes", OPUS, { cacheWrite: 4_000, cacheWrite1h: 4_000 }, 0.04],
  ["clamped 1h writes", OPUS, { cacheWrite: 4_000, cacheWrite1h: 40_000 }, 0.04],
];
for (const [name, model, usage, standard] of pricingCases) {
  test(`pricing doubles each component exactly once: ${name}`, () => {
    assertUsd(piUsageToCallUsage(usage, model, true)!.costUsd, standard * FAST_COST_MULTIPLIER);
  });
}

test("normalization ignores provider pricing, preserves tokens and never mutates usage or the model", () => {
  const card = structuredClone(ASTRA.cost);
  for (const factor of [1, 2, 0.5]) {
    const usage = {
      ...ASTRA_TOKENS,
      reasoning: 900,
      cost: {
        input: 0.1 * factor,
        output: 0.1 * factor,
        cacheRead: 0.05 * factor,
        cacheWrite: 0.05 * factor,
        total: 0.3 * factor,
      },
    };
    const snapshot = structuredClone(usage);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { costUsd, ...tokens } = piUsageToCallUsage(usage, ASTRA, true)!;
      assertUsd(costUsd, 0.6);
      assert.deepEqual(tokens, ASTRA_TOKENS);
    }
    assert.deepEqual(usage, snapshot);
  }
  assert.deepEqual(ASTRA.cost, card);
});

const HAIKU = getRequiredModel("claude-haiku-4-5", false) as Model<Api>;
const BINDING_BETA = "thinking-binding-controls-2026-08-01";

test("request headers preserve rates and existing beta headers", () => {
  for (const model of [ASTRA, OPUS, OPUS_55]) {
    const snapshot = structuredClone(model);
    assert.deepEqual(withRequestHeaders(model, true, true).cost, snapshot.cost);
    assert.deepEqual(model, snapshot);
  }
  assert.equal(
    withRequestHeaders(OPUS, true, true).headers?.["anthropic-beta"],
    `${BINDING_BETA},fast-mode-2026-02-01`,
  );
  assert.equal(
    withRequestHeaders({ ...OPUS, headers: { "anthropic-beta": "prior-beta" } }, true, true).headers?.[
      "anthropic-beta"
    ],
    `prior-beta,${BINDING_BETA},fast-mode-2026-02-01`,
  );
});

test("direct adaptive-thinking Claude requests opt into thinking binding controls", () => {
  assert.equal(withRequestHeaders(OPUS, true, false).headers?.["anthropic-beta"], BINDING_BETA);
  assert.equal(withRequestHeaders(OPUS, false, true).headers?.["anthropic-beta"], undefined);
  assert.equal(withRequestHeaders(ASTRA, true, false).headers?.["anthropic-beta"], undefined);
  assert.equal(withRequestHeaders(HAIKU, true, false).headers?.["anthropic-beta"], undefined);
  assert.equal(withRequestHeaders(HAIKU, true, true).headers?.["anthropic-beta"], "fast-mode-2026-02-01");
});

test("applyThinkingBinding sets drop_block only on requests that carry the beta header", () => {
  const bound = withRequestHeaders(OPUS, true, true);
  const adaptive = { thinking: { type: "adaptive", display: "summarized" } } as Record<string, unknown>;
  assert.equal(applyThinkingBinding(adaptive, bound), adaptive);
  assert.deepEqual(adaptive.thinking, {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  const budget = { thinking: { type: "enabled", budget_tokens: 2048 } } as Record<string, unknown>;
  applyThinkingBinding(budget, bound);
  assert.deepEqual(budget.thinking, {
    type: "enabled",
    budget_tokens: 2048,
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  const disabled = { thinking: { type: "disabled" } } as Record<string, unknown>;
  applyThinkingBinding(disabled, bound);
  assert.deepEqual(disabled.thinking, { type: "disabled" });
  const unbound = { thinking: { type: "adaptive" } } as Record<string, unknown>;
  applyThinkingBinding(unbound, OPUS);
  applyThinkingBinding(unbound, withRequestHeaders(HAIKU, true, true));
  assert.deepEqual(unbound.thinking, { type: "adaptive" });
  const none = { messages: [] } as Record<string, unknown>;
  applyThinkingBinding(none, bound);
  assert.equal("thinking" in none, false);
  assert.doesNotThrow(() => applyThinkingBinding(undefined, bound));
});

test("normalization handles absent usage, missing token fields and an unknown model", () => {
  assert.equal(piUsageToCallUsage(undefined, ASTRA, true), null);
  assert.deepEqual(piUsageToCallUsage({ totalTokens: 500 }, ASTRA, true), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 500,
    costUsd: 0,
  });
  const usage = { ...ASTRA_TOKENS, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
  assert.deepEqual(piUsageToCallUsage(usage, undefined, true), { ...ASTRA_TOKENS, costUsd: 0.3 });
  assert.equal(piUsageToCallUsage({}, undefined, undefined)!.costUsd, 0);
});

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type as string}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function responsesReply(text: string, usage: Record<string, unknown>, serviceTier?: string): Response {
  const item = {
    id: "msg_astra",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sse([
    { type: "response.created", response: { id: "resp_astra", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_astra",
        status: "completed",
        output: [item],
        usage,
        ...(serviceTier ? { service_tier: serviceTier } : {}),
      },
    },
  ]);
}

function anthropicReply(text: string, usage: Record<string, unknown>): Response {
  return sse([
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude", usage },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: usage.output_tokens as number },
    },
    { type: "message_stop" },
  ]);
}

const ASTRA_WIRE_USAGE = {
  input_tokens: 64_000,
  input_tokens_details: { cached_tokens: 50_000, cache_write_tokens: 4_000 },
  output_tokens: 2_000,
  total_tokens: 66_000,
};
const ANTHROPIC_WIRE_USAGE = {
  input_tokens: 10_000,
  output_tokens: 1_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

async function withFetch<T>(
  respond: (payload: Record<string, unknown>, index: number, init?: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) =>
    respond(
      JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      index++,
      init,
    )) as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const refusal = (type: string, message: string): Response =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

async function runTurn(
  sessionId: string,
  modelId: string,
  fastMode: boolean,
  respond: (payload: Record<string, unknown>, index: number) => Response,
  gateway = false,
  extra: Partial<PiHarnessOptions> = {},
): Promise<{ rows: HarnessLlmRequestRecord[]; payloads: Array<Record<string, unknown>>; betas: Array<string | null> }> {
  const rows: HarnessLlmRequestRecord[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const betas: Array<string | null> = [];
  const harness = createPiHarness({
    apiKey: "sk-anthropic-test",
    openaiApiKey: "sk-openai-test",
    ...(gateway
      ? {
          modelGateway: {
            url: "https://gateway.example/v1",
            apiKey: "sk-gateway-test",
            apiKeyHeader: "x-gateway-key",
            models: {
              "gpt-6-astra": "openai/gpt-6-astra",
              "gpt-6-astra-ultrafast": "openai/gpt-6-astra",
              "claude-sonnet-5": "anthropic/claude-sonnet-5",
            },
          },
        }
      : {}),
    ...extra,
  });
  let seq = 0;
  const respondAndRecord = (payload: Record<string, unknown>, index: number, init?: RequestInit) => {
    payloads.push(payload);
    betas.push(new Headers(init?.headers).get("anthropic-beta"));
    return respond(payload, index);
  };
  await withFetch(respondAndRecord, () =>
    harness.turns.runTurn({
      session: { id: sessionId } as HarnessTurnInput["session"],
      input: "price this turn",
      systemPrompt: "BASE",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
      orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
      runtime: { modelId, fastMode },
      ...(!gateway && modelId === ASTRA.id ? { providerKeys: { openai: "sk-openai-direct" } } : {}),
      emit: async (entry: NewEntry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as unknown as SessionEntry,
      recordModelCall: () => {},
      recordLlmRequest: (rec: HarnessLlmRequestRecord) => {
        rows.push(rec);
      },
    }),
  );
  return { rows, payloads, betas };
}

for (const [name, gateway, fastMode, expected, echoedTier] of [
  ["gateway fast without tier echo", true, true, 0.6],
  ["direct key fast with tier echo", false, true, 0.6],
  ["gateway standard", true, false, 0.3],
  ["direct standard with priority default", false, false, 0.6, "priority"],
  ["direct standard with flex default", false, false, 0.15, "flex"],
] as const) {
  test(`Astra records the billed price: ${name}`, async () => {
    const { rows, payloads } = await runTurn(
      name.replaceAll(" ", "-"),
      ASTRA.id,
      fastMode,
      (payload) =>
        responsesReply(
          "priced",
          ASTRA_WIRE_USAGE,
          echoedTier ?? (gateway ? undefined : (payload.service_tier as string)),
        ),
      gateway,
    );
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.service_tier, fastMode ? "priority" : undefined);
    assert.equal(rows.length, 1);
    const { costUsd, ...tokens } = rows[0]!.usage!;
    assertUsd(costUsd, expected);
    assert.deepEqual(tokens, ASTRA_TOKENS);
  });
}

test("an unsupported fast-mode request records the standard price", async () => {
  const { rows, payloads, betas } = await runTurn("sonnet-fast-ineligible", "claude-sonnet-5", true, () =>
    anthropicReply("standard", ANTHROPIC_WIRE_USAGE),
  );
  assert.equal(payloads.length, 1);
  assert.equal("speed" in payloads[0]!, false);
  assert.equal(betas[0], BINDING_BETA);
  assert.deepEqual((payloads[0]!.thinking as { block_binding?: unknown }).block_binding, {
    prefix_mismatch_behavior: "drop_block",
  });
  assert.equal(rows.length, 1);
  assertUsd(rows[0]!.usage!.costUsd, 0.03);
});

test("gateway-routed Claude requests carry neither the binding beta nor block_binding", async () => {
  const { payloads, betas } = await runTurn(
    "sonnet-gateway-unbound",
    "claude-sonnet-5",
    false,
    () => anthropicReply("routed", ANTHROPIC_WIRE_USAGE),
    true,
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.model, "anthropic/claude-sonnet-5");
  assert.equal(betas[0]?.includes(BINDING_BETA) ?? false, false);
  assert.equal("block_binding" in (payloads[0]!.thinking as object), false);
});

test("a refusal fallback prices each step on its actual model and tier", async () => {
  const { rows, payloads } = await runTurn("refusal-fallback-pricing", "claude-sonnet-5", true, (_payload, index) =>
    index === 0
      ? refusal("api_error", "Output blocked by content filtering policy: this would violate Anthropic's usage policy.")
      : anthropicReply("recovered", ANTHROPIC_WIRE_USAGE),
  );
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0]?.model, "claude-sonnet-5");
  assert.equal("speed" in payloads[0]!, false);
  assert.equal(payloads[1]?.model, "claude-opus-5");
  assert.equal(payloads[1]?.speed, "fast");
  assert.deepEqual(
    rows.map((r) => [r.step, r.model]),
    [
      [0, "claude-sonnet-5"],
      [1, "claude-opus-5"],
    ],
  );
  assertUsd(rows[0]!.usage!.costUsd, 0);
  assertUsd(rows[1]!.usage!.costUsd, 0.15);
});

for (const gateway of [true, false]) {
  test(`Ultrafast prices a successful turn exactly once through ${gateway ? "gateway" : "direct"}`, async () => {
    const { rows, payloads } = await runTurn(
      `astra-ultrafast-${gateway}`,
      "gpt-6-astra-ultrafast",
      false,
      () => responsesReply("done", ASTRA_WIRE_USAGE, "ultrafast"),
      gateway,
    );
    assert.equal(payloads[0]?.model, gateway ? "openai/gpt-6-astra" : "gpt-6-astra");
    assert.equal(payloads[0]?.service_tier, "ultrafast");
    assert.equal(rows.length, 1);
    assertUsd(rows[0]!.usage!.costUsd, 1.8);
    assert.equal(rows[0]!.model, "gpt-6-astra-ultrafast");
  });
}

const USAGE_POLICY_REFUSAL =
  "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.";

test("a current Usage Policy refusal retries on the admin-configured fallback runtime", async () => {
  const { payloads } = await runTurn(
    "refusal-configured-fallback",
    "claude-sonnet-5",
    false,
    (_payload, index) =>
      index === 0
        ? refusal("invalid_request_error", USAGE_POLICY_REFUSAL)
        : responsesReply("recovered", ASTRA_WIRE_USAGE),
    false,
    { resolveFallbackRuntime: () => ({ modelId: "gpt-6-sol", effortLevel: "low" }) },
  );
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1]?.model, "gpt-6-sol");
  assert.equal((payloads[1]?.reasoning as { effort?: string } | undefined)?.effort, "low");
});

test("an unavailable gateway model retries on the configured fallback instead of failing the turn", async () => {
  const { payloads } = await runTurn(
    "unavailable-configured-fallback",
    "claude-sonnet-5",
    false,
    () => responsesReply("recovered", ASTRA_WIRE_USAGE),
    false,
    {
      modelGateway: {
        url: "https://gateway.example/v1",
        apiKey: "k",
        apiKeyHeader: "x-k",
        models: {},
        reservedModelIds: new Set(["claude-sonnet-5"]),
      },
      resolveFallbackRuntime: () => ({ modelId: "gpt-6-sol", effortLevel: "low" }),
    },
  );
  assert.deepEqual(
    payloads.map((p) => p.model),
    ["gpt-6-sol"],
  );
});

test("compaction retries a refused summary on the configured fallback model", async () => {
  const harness = createPiHarness({
    apiKey: "sk-anthropic-test",
    openaiApiKey: "sk-openai-test",
    modelId: "claude-sonnet-5",
    resolveFallbackRuntime: () => ({ modelId: "gpt-6-sol" }),
  });
  const models: unknown[] = [];
  const text = await withFetch(
    (payload, index) => {
      models.push(payload.model);
      return index === 0
        ? refusal("invalid_request_error", USAGE_POLICY_REFUSAL)
        : responsesReply("summary of the work", ASTRA_WIRE_USAGE);
    },
    () =>
      harness.models.compactHistory!({
        session: { id: "compact-fallback" } as HarnessTurnInput["session"],
        history: [
          { seq: 1, kind: "user", payload: { text: "hello" }, createdAt: 1 },
          { seq: 2, kind: "assistant", payload: { text: "hi" }, createdAt: 2 },
        ] as unknown as SessionEntry[],
        recordModelCall: () => {},
      }),
  );
  assert.match(text, /summary of the work/);
  assert.deepEqual(models, ["claude-sonnet-5", "gpt-6-sol"]);
});
