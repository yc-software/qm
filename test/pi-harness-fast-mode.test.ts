import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTurnEffort,
  applyFastSpeed,
  piUsageToCallUsage,
  scaleCost,
  withFastModeHeaders,
  FAST_COST_MULTIPLIER,
  modelSupportsFastMode,
  wantsFastMode,
  createPiHarness,
  type ProviderKeys,
} from "../src/harness/pi-harness.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { defaultInteractiveThinkingLevel, getRequiredModel } from "../src/model/pi-models.ts";

test("modelSupportsFastMode allows only the documented direct Opus ids", () => {
  for (const id of ["claude-opus-5", "claude-opus-4-8"]) {
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

test('applyFastSpeed injects service_tier:"priority" for OpenAI-API models', () => {
  const on = { model: "gpt-5.6-sol", input: [] } as Record<string, unknown>;
  applyFastSpeed(on, true, "openai-responses");
  assert.equal(on.service_tier, "priority");
  assert.equal("speed" in on, false, "no Anthropic speed field on an OpenAI request");

  const off = { model: "gpt-5.6-sol", input: [] } as Record<string, unknown>;
  applyFastSpeed(off, false, "openai-responses");
  assert.equal("service_tier" in off, false);
});

test("modelSupportsFastMode covers the GPT-5.6 family (priority tier)", () => {
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.equal(modelSupportsFastMode(id), true, id);
  }
});

test("scaleCost doubles OpenAI per-token rates for fast mode", () => {
  const scaled = scaleCost({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, FAST_COST_MULTIPLIER);
  assert.deepEqual(scaled, { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 });
});

test('applyFastSpeed injects speed:"fast" into the body only when fast is requested', () => {
  const on = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  assert.equal(applyFastSpeed(on, true), on, "returns the same object (in-place mutation)");
  assert.equal(on.speed, "fast");

  const off = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  applyFastSpeed(off, false);
  applyFastSpeed(off, undefined);
  assert.equal("speed" in off, false, "no speed field on a non-fast turn");
});

test("applyFastSpeed never throws on non-object payloads", () => {
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
const OPUS = getRequiredModel("claude-opus-5", false) as Model<Api>;
const SONNET = getRequiredModel("claude-sonnet-5", false) as Model<Api>;

function piUsage(u: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...u,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...u.cost },
  };
}

function priced(u: Partial<Usage>, model: Model<Api> | undefined, fast: boolean): number {
  const row = piUsageToCallUsage(u, model, fast);
  assert.ok(row, "a usage object always normalizes to a row");
  return row.costUsd;
}

function assertUsd(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message} — expected $${expected}, recorded $${actual}`);
}

const ASTRA_TOKENS = { input: 10_000, output: 2_000, cacheRead: 50_000, cacheWrite: 4_000, totalTokens: 66_000 };

test("fast mode prices a turn at exactly twice the standard rate for the same tokens", () => {
  const standard = priced(piUsage(ASTRA_TOKENS), ASTRA, false);
  const fast = priced(piUsage(ASTRA_TOKENS), ASTRA, true);
  assertUsd(standard, 0.3, "the standard price is unchanged from what QM stores today");
  assertUsd(fast, 0.6, "a Fast-mode turn records the priority rate it is billed at");
  assertUsd(fast, standard * FAST_COST_MULTIPLIER, "the uplift is applied exactly once");
});

test("token fields pass through the normalizer verbatim", () => {
  const row = piUsageToCallUsage(piUsage({ ...ASTRA_TOKENS, reasoning: 900 }), ASTRA, true);
  assert.ok(row);
  const { costUsd, ...tokens } = row;
  assert.deepEqual(tokens, {
    input: 10_000,
    output: 2_000,
    cacheRead: 50_000,
    cacheWrite: 4_000,
    totalTokens: 66_000,
  });
  assertUsd(costUsd, 0.6, "and the row carries the fast price");
});

test("an already-uplifted provider cost is never multiplied a second time", () => {
  for (const [label, factor] of [
    ["standard", 1],
    ["priority echo (pi-ai already doubled)", 2],
    ["flex echo (pi-ai already halved)", 0.5],
  ] as const) {
    const u = piUsage({
      ...ASTRA_TOKENS,
      cost: {
        input: 0.1 * factor,
        output: 0.1 * factor,
        cacheRead: 0.05 * factor,
        cacheWrite: 0.05 * factor,
        total: 0.3 * factor,
      },
    });
    assertUsd(priced(u, ASTRA, true), 0.6, `${label}: cost comes from tokens, never from an adjusted total`);
  }
});

test("pricing is idempotent and leaves the provider's usage object untouched", () => {
  const live = piUsage(ASTRA_TOKENS);
  const snapshot = structuredClone(live);
  for (const attempt of [1, 2, 3])
    assertUsd(priced(live, ASTRA, true), 0.6, `call ${attempt} of the three message_end consumers`);
  assert.deepEqual(live, snapshot, "calculateCost mutates its argument — the normalizer must price a copy");
});

test("withFastModeHeaders is transport-only and never touches the rate card", () => {
  const astraCard = structuredClone(ASTRA.cost);
  const opusCard = structuredClone(OPUS.cost);
  assert.deepEqual(withFastModeHeaders(ASTRA).cost, astraCard, "the OpenAI branch no longer reprices the card");
  const fastOpus = withFastModeHeaders(OPUS);
  assert.deepEqual(fastOpus.cost, opusCard, "the Anthropic branch carries the beta header, not a doubled card");
  assert.equal(fastOpus.headers?.["anthropic-beta"], "fast-mode-2026-02-01");
  const withPrior = withFastModeHeaders({ ...OPUS, headers: { "anthropic-beta": "prior-beta" } } as Model<Api>);
  assert.equal(withPrior.headers?.["anthropic-beta"], "prior-beta,fast-mode-2026-02-01");
});

test("every priced component doubles under fast mode, not just input and output", () => {
  assertUsd(priced(piUsage({ cacheRead: 100_000, totalTokens: 100_000 }), ASTRA, false), 0.1, "cache reads, standard");
  assertUsd(priced(piUsage({ cacheRead: 100_000, totalTokens: 100_000 }), ASTRA, true), 0.2, "cache reads, fast");
  assertUsd(priced(piUsage({ cacheWrite: 8_000, totalTokens: 8_000 }), ASTRA, false), 0.1, "cache writes, standard");
  assertUsd(priced(piUsage({ cacheWrite: 8_000, totalTokens: 8_000 }), ASTRA, true), 0.2, "cache writes, fast");
});

test("Anthropic 1h cache writes keep their 2x-input rule under fast mode", () => {
  const u = piUsage({
    input: 10_000,
    output: 1_000,
    cacheRead: 40_000,
    cacheWrite: 16_000,
    cacheWrite1h: 8_000,
    totalTokens: 67_000,
  });
  assertUsd(priced(u, OPUS, false), 0.225, "1h writes bill at 2x base input");
  assertUsd(priced(u, OPUS, true), 0.45, "…and at 2x the doubled input under fast mode");
});

test("the high-input tier is scaled with the base rates, on the same threshold", () => {
  assertUsd(priced(piUsage({ input: 300_000, totalTokens: 300_000 }), ASTRA, false), 6, "above 272k, standard");
  assertUsd(priced(piUsage({ input: 300_000, totalTokens: 300_000 }), ASTRA, true), 12, "above 272k, fast");
  assertUsd(priced(piUsage({ input: 272_000, totalTokens: 272_000 }), ASTRA, false), 2.72, "tiers select on >");
  assertUsd(priced(piUsage({ input: 272_000, totalTokens: 272_000 }), ASTRA, true), 5.44, "…on the fast card too");
});

test("the normalizer is total: no usage, no model, and unpriceable usage all stay finite", () => {
  assert.equal(piUsageToCallUsage(undefined, ASTRA, true), null);
  assert.deepEqual(piUsageToCallUsage({ totalTokens: 500 }, ASTRA, true), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 500,
    costUsd: 0,
  });
  const withProviderCost = piUsage({
    ...ASTRA_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  });
  assertUsd(
    priced(withProviderCost, undefined, true),
    0.3,
    "with no model in hand the provider's own number is preserved rather than invented",
  );
});

test("a cacheWrite1h larger than cacheWrite is clamped instead of pricing a negative short write", () => {
  const sane = priced(piUsage({ cacheWrite: 4_000, cacheWrite1h: 4_000, totalTokens: 4_000 }), OPUS, true);
  assertUsd(sane, 0.08, "all 4k written to the 1h cache, billed at twice the doubled input rate");
  assertUsd(
    priced(piUsage({ cacheWrite: 4_000, cacheWrite1h: 40_000, totalTokens: 4_000 }), OPUS, true),
    sane,
    "an impossible 1h split prices as if every write were 1h, not as a negative short write",
  );
});

test("pricing follows the model and tier the step actually ran on", () => {
  const tokens = { input: 10_000, output: 1_000, totalTokens: 11_000 };
  assertUsd(priced(piUsage(tokens), OPUS, true), 0.15, "a fast Opus step");
  assertUsd(priced(piUsage(tokens), SONNET, false), 0.03, "a non-fast fallback is priced on the fallback card");
  assertUsd(priced(piUsage(tokens), OPUS, false), 0.075, "…and the same Opus step without fast mode");
});

const SEPT_15_PRIORITY_TOKENS = [
  [1614, 198, 82776, 1422],
  [1772, 294, 94569, 1318],
  [517, 491, 70800, 278],
  [2445, 97, 77079, 44],
  [511, 355, 96517, 1166],
  [1917, 99, 85505, 714],
  [788, 447, 65734, 1156],
  [667, 83, 89047, 1064],
  [2173, 415, 93344, 1070],
  [436, 214, 68663, 948],
  [1164, 198, 91700, 450],
  [2196, 306, 70473, 666],
  [1566, 246, 73993, 1210],
  [1622, 220, 89081, 846],
  [1199, 313, 71798, 124],
  [1602, 293, 79622, 424],
  [1309, 105, 91016, 292],
  [613, 429, 84992, 890],
  [2318, 176, 80549, 566],
  [1686, 358, 71592, 276],
  [1656, 72, 73446, 1118],
  [1969, 253, 76471, 734],
  [893, 195, 93619, 408],
  [1609, 97, 94777, 990],
  [1302, 145, 93042, 414],
  [825, 263, 91145, 524],
  [362, 249, 67153, 1426],
  [943, 314, 84598, 1294],
  [1874, 481, 72495, 326],
  [1400, 238, 91557, 730],
  [2342, 399, 81398, 1318],
  [1178, 317, 95244, 666],
  [1069, 385, 95603, 1258],
  [739, 175, 75517, 72],
  [646, 350, 92609, 340],
  [1520, 192, 69935, 866],
  [1710, 457, 96079, 352],
  [1791, 122, 92894, 482],
  [1015, 363, 67250, 1216],
] as const;

const SEPT_15_STANDARD_TOKENS = [
  [1730, 232, 79123, 460],
  [1176, 358, 78249, 1014],
  [526, 330, 78303, 496],
  [2069, 111, 76059, 916],
  [391, 470, 64996, 1308],
  [2006, 314, 59453, 838],
  [1667, 300, 68102, 424],
] as const;

function sumRecorded(table: ReadonlyArray<readonly number[]>, fast: boolean): number {
  return table.reduce(
    (total, [input, output, cacheRead, cacheWrite]) =>
      total +
      priced(
        piUsage({
          input: input!,
          output: output!,
          cacheRead: cacheRead!,
          cacheWrite: cacheWrite!,
          totalTokens: input! + output! + cacheRead! + cacheWrite!,
        }),
        ASTRA,
        fast,
      ),
    0,
  );
}

test("the September 15 maritime fleet ledger reconciles to the gateway once fast mode is priced", () => {
  const priorityBefore = sumRecorded(SEPT_15_PRIORITY_TOKENS, false);
  assertUsd(priorityBefore, 4.651687, "the 39 interactive requests, priced the way the bug priced them");

  const priorityRecorded = sumRecorded(SEPT_15_PRIORITY_TOKENS, true);
  const standardRecorded = sumRecorded(SEPT_15_STANDARD_TOKENS, false);
  assertUsd(priorityRecorded, 9.303374, "LiteLLM charged this for the 39 priority requests");
  assertUsd(priorityRecorded, priorityBefore * 2, "a flat 2.000000 ratio across a mixed set of token shapes");
  assertUsd(standardRecorded, 0.773885, "the 7 automatic-suggestions requests are untouched by the fix");
  assertUsd(
    priorityRecorded + standardRecorded,
    10.0778196 - 0.0005606,
    "the recorded Astra total now matches the gateway, less the four auxiliary Luna calls QM does not price",
  );
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

const ASTRA_WIRE_USAGE = {
  input_tokens: 64_000,
  input_tokens_details: { cached_tokens: 50_000, cache_write_tokens: 4_000 },
  output_tokens: 2_000,
  total_tokens: 66_000,
};

function astraTurn(
  sessionId: string,
  fastMode: boolean,
  sink: { rows: HarnessLlmRequestRecord[] },
  providerKeys?: ProviderKeys,
): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "price this turn",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    runtime: { modelId: "gpt-6-astra", fastMode },
    ...(providerKeys ? { providerKeys } : {}),
    emit: async (entry: NewEntry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as unknown as SessionEntry,
    recordModelCall: () => {},
    recordLlmRequest: (rec: HarnessLlmRequestRecord) => {
      sink.rows.push(rec);
    },
  };
}

async function runAstraTurn(
  sessionId: string,
  fastMode: boolean,
  opts: { gateway: boolean },
): Promise<{ rows: HarnessLlmRequestRecord[]; payloads: Array<Record<string, unknown>> }> {
  const sink = { rows: [] as HarnessLlmRequestRecord[] };
  const payloads: Array<Record<string, unknown>> = [];
  const harness = createPiHarness({
    apiKey: "sk-anthropic-test",
    openaiApiKey: "sk-openai-test",
    ...(opts.gateway
      ? {
          modelGateway: {
            url: "https://gateway.example/v1",
            apiKey: "sk-gateway-test",
            apiKeyHeader: "x-gateway-key",
            models: { "gpt-6-astra": "openai/gpt-6-astra" },
          },
        }
      : {}),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    payloads.push(payload);
    const echoedTier = opts.gateway ? undefined : (payload.service_tier as string | undefined);
    return responsesReply("priced", ASTRA_WIRE_USAGE, echoedTier);
  }) as typeof globalThis.fetch;
  try {
    await harness.turns.runTurn(
      astraTurn(sessionId, fastMode, sink, opts.gateway ? undefined : { openai: "sk-openai-direct" }),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  return { rows: sink.rows, payloads };
}

test("a gateway-routed Fast-mode turn records the priority price it is billed", async () => {
  const { rows, payloads } = await runAstraTurn("astra-gateway-fast", true, { gateway: true });
  assert.equal(rows.length, 1, "one recorded LLM request");
  assert.equal(payloads[0]?.service_tier, "priority", "the tier flag and the price come from one decision");
  assertUsd(rows[0]!.usage!.costUsd, 0.6, "the reported bug recorded $0.30 for this turn");
  assert.deepEqual(
    { ...rows[0]!.usage!, costUsd: 0 },
    { input: 10_000, output: 2_000, cacheRead: 50_000, cacheWrite: 4_000, totalTokens: 66_000, costUsd: 0 },
    "the persisted row gains no keys and its token counts come straight from the provider",
  );
});

test("a direct-key Fast-mode turn records the same price, even when the provider echoes the tier", async () => {
  const { rows, payloads } = await runAstraTurn("astra-direct-fast", true, { gateway: false });
  assert.equal(payloads[0]?.service_tier, "priority");
  assertUsd(rows[0]!.usage!.costUsd, 0.6, "QM's own uplift must not stack with pi-ai's response-echo uplift");
});

test("a standard-tier turn is unchanged by the fast-mode pricing path", async () => {
  const { rows, payloads } = await runAstraTurn("astra-gateway-standard", false, { gateway: true });
  assert.equal("service_tier" in (payloads[0] ?? {}), false, "no tier is requested");
  assertUsd(rows[0]!.usage!.costUsd, 0.3, "standard turns keep the value they record today");
});

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

const REFUSAL_MESSAGE = "Output blocked by content filtering policy: this would violate Anthropic's usage policy.";

const ANTHROPIC_WIRE_USAGE = {
  input_tokens: 10_000,
  output_tokens: 1_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

async function runAnthropicTurn(
  sessionId: string,
  modelId: string,
  fastMode: boolean,
  respond: (requestIndex: number) => Response,
): Promise<{ rows: HarnessLlmRequestRecord[]; payloads: Array<Record<string, unknown>> }> {
  const rows: HarnessLlmRequestRecord[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const harness = createPiHarness({ apiKey: "sk-anthropic-test" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body ?? "{}")));
    return respond(payloads.length - 1);
  }) as typeof globalThis.fetch;
  let seq = 0;
  try {
    await harness.turns.runTurn({
      session: { id: sessionId } as HarnessTurnInput["session"],
      input: "price this turn",
      systemPrompt: "BASE",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
      orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
      runtime: { modelId, fastMode },
      emit: async (entry: NewEntry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as unknown as SessionEntry,
      recordModelCall: () => {},
      recordLlmRequest: (rec: HarnessLlmRequestRecord) => {
        rows.push(rec);
      },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  return { rows, payloads };
}

test("Fast mode requested on a model that cannot serve it records the standard price", async () => {
  const { rows, payloads } = await runAnthropicTurn("sonnet-fast-ineligible", "claude-sonnet-5", true, () =>
    anthropicReply("standard", ANTHROPIC_WIRE_USAGE),
  );
  assert.equal("speed" in (payloads[0] ?? {}), false, "no priority tier is requested for claude-sonnet-5");
  assert.equal(rows.length, 1);
  assertUsd(rows[0]!.usage!.costUsd, 0.03, "the price follows the tier the turn actually ran on, not the request");
});

test("a mid-turn refusal fallback prices each step on the model and tier that step ran on", async () => {
  const { rows, payloads } = await runAnthropicTurn("refusal-fallback-pricing", "claude-sonnet-5", true, (index) =>
    index === 0
      ? new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: REFUSAL_MESSAGE } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      : anthropicReply("recovered", ANTHROPIC_WIRE_USAGE),
  );

  assert.equal(payloads.length, 2, "the refusal is retried once on the fallback model");
  assert.equal(payloads[0]?.model, "claude-sonnet-5");
  assert.equal("speed" in payloads[0]!, false, "claude-sonnet-5 is not fast-mode eligible, so no tier is requested");
  assert.equal(payloads[1]?.model, "claude-opus-5", "refusalFallbackModelId swaps in the Opus fallback");
  assert.equal(payloads[1]?.speed, "fast", "the fallback model is fast-mode eligible, so the tier is requested");

  assert.deepEqual(
    rows.map((r) => [r.step, r.model]),
    [
      [0, "claude-sonnet-5"],
      [1, "claude-opus-5"],
    ],
    "each step is recorded against the model it ran on",
  );
  assertUsd(rows[0]!.usage!.costUsd, 0, "the refused step streamed no tokens and is not repriced");
  assertUsd(rows[1]!.usage!.costUsd, 0.15, "the recovered step is priced 2x on the Opus card it actually ran on");
});
