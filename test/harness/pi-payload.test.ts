import { test } from "node:test";
import assert from "node:assert/strict";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import {
  guardOutputBudget,
  OUTPUT_BUDGET_FLOOR_TOKENS,
  OUTPUT_GUARD_SAFETY_TOKENS,
  trimPayloadToByteBudget,
  transportFromModel,
} from "../../src/harness/pi-payload.ts";

const FABLE = { contextWindow: 200_000, maxTokens: 64_000 };

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-fable-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: [{ type: "text", text: "You are Agent." }],
    max_tokens: 64_000,
    stream: true,
    ...over,
  };
}

function asAssistantError(err: Error) {
  return {
    role: "assistant",
    content: [],
    provider: "anthropic",
    model: "claude-fable-5",
    stopReason: "error",
    errorMessage: err.message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    timestamp: Date.now(),
  } as never;
}

test("a healthy output cap is left untouched", () => {
  const p = payload();
  const before = JSON.stringify(p);
  assert.deepEqual(guardOutputBudget(p, FABLE), { kind: "ok" });
  assert.equal(JSON.stringify(p), before, "payload not mutated");
});

test("the incident shape: a clamped cap on a small real prompt is raised to the model cap", () => {
  const p = payload({ max_tokens: 1 });
  const r = guardOutputBudget(p, FABLE);
  assert.equal(r.kind, "raised");
  assert.equal(p.max_tokens, FABLE.maxTokens, "cap restored to the model's own output cap");
});

test("the raise is bounded by what actually fits: window - estimate - safety", () => {
  const text = "x".repeat(600_000);
  const p = payload({ max_tokens: 1, messages: [{ role: "user", content: [{ type: "text", text }] }] });
  const r = guardOutputBudget(p, FABLE);
  assert.equal(r.kind, "raised");
  if (r.kind !== "raised") return;
  assert.equal(r.to, FABLE.contextWindow - r.estimatedPromptTokens - OUTPUT_GUARD_SAFETY_TOKENS);
  assert.ok(r.to < FABLE.maxTokens, "could not fit the full model cap");
  assert.ok(r.to >= OUTPUT_BUDGET_FLOOR_TOKENS, "but always at least the floor");
  assert.equal(p.max_tokens, r.to);
});

test("genuinely full: refuses to dispatch, and pi classifies the refusal as overflow — not retryable", () => {
  const text = "x".repeat(790_000);
  const p = payload({ max_tokens: 1, messages: [{ role: "user", content: [{ type: "text", text }] }] });
  const err = (() => {
    try {
      guardOutputBudget(p, FABLE);
      return undefined;
    } catch (e) {
      return e as Error;
    }
  })();
  assert.ok(err, "guard threw");
  assert.match(err.message, /prompt is too long/i);
  assert.equal(isRetryableAssistantError(asAssistantError(err)), false, "never a blind same-payload retry");
  assert.equal(
    isContextOverflow(asAssistantError(err), FABLE.contextWindow),
    true,
    "handled as overflow: compact, then retry",
  );
});

test("openai responses shape: max_output_tokens is guarded the same way", () => {
  const p = payload({ max_tokens: undefined, max_output_tokens: 3 });
  delete p.max_tokens;
  const r = guardOutputBudget(p, { contextWindow: 1_050_000, maxTokens: 128_000 });
  assert.equal(r.kind, "raised");
  assert.equal(p.max_output_tokens, 128_000);
});

test("inline image bytes do not fake a full window", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000_000) } };
  const p = payload({
    max_tokens: 1,
    messages: [{ role: "user", content: [image, { type: "text", text: "what is this?" }] }],
  });
  const r = guardOutputBudget(p, FABLE);
  assert.equal(r.kind, "raised", "raised, not thrown");
  assert.equal(p.max_tokens, FABLE.maxTokens);
});

test("non-image data blobs count at full length — a redacted_thinking blob cannot hide a full window", () => {
  const blob = { type: "redacted_thinking", data: "E".repeat(790_000) };
  const p = payload({
    max_tokens: 1,
    messages: [
      { role: "assistant", content: [blob] },
      { role: "user", content: [{ type: "text", text: "go on" }] },
    ],
  });
  assert.throws(() => guardOutputBudget(p, FABLE), /prompt is too long/i, "refused, not raised");
});

test("native PDF bytes use a media estimate instead of their encoded text length", () => {
  const doc = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "P".repeat(790_000) },
  };
  const p = payload({
    max_tokens: 1,
    messages: [{ role: "user", content: [doc, { type: "text", text: "summarize" }] }],
  });
  assert.equal(guardOutputBudget(p, FABLE).kind, "raised");
});

test("a data URL pasted as TEXT counts at full length — only url-keyed data URLs are images", () => {
  const pasted = "data:image/png;base64," + "Q".repeat(790_000);
  const p = payload({ max_tokens: 1, messages: [{ role: "user", content: [{ type: "text", text: pasted }] }] });
  assert.throws(() => guardOutputBudget(p, FABLE), /prompt is too long/i, "refused, not raised");
  const asImage = payload({
    max_tokens: 1,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: pasted } },
          { type: "text", text: "what is this?" },
        ],
      },
    ],
  });
  assert.equal(guardOutputBudget(asImage, FABLE).kind, "raised");
});

test("unrecognized payload shapes are left alone", () => {
  assert.deepEqual(guardOutputBudget({ input: "no cap field" }, FABLE), { kind: "ok" });
  assert.deepEqual(guardOutputBudget(null, FABLE), { kind: "ok" });
  assert.deepEqual(guardOutputBudget("nonsense", FABLE), { kind: "ok" });
  const nonNumeric = payload({ max_tokens: "64000" });
  assert.deepEqual(guardOutputBudget(nonNumeric, FABLE), { kind: "ok" });
});

test("without a known context window the guard cannot judge, so it does not touch the payload", () => {
  const p = payload({ max_tokens: 1 });
  assert.deepEqual(guardOutputBudget(p, {}), { kind: "ok" });
  assert.deepEqual(guardOutputBudget(p, { contextWindow: 0 }), { kind: "ok" });
  assert.deepEqual(guardOutputBudget(p, undefined), { kind: "ok" });
  assert.equal(p.max_tokens, 1);
});

test("pi-ai characterization: a stale usage anchor clamps max_tokens to 1 even for a small real prompt", () => {
  const staleAnchor = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    usage: {
      input: 2,
      output: 1,
      cacheRead: 198_187,
      cacheWrite: 412,
      totalTokens: 198_602,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
  };
  const context = {
    systemPrompt: "You are Agent.",
    messages: [
      staleAnchor,
      { role: "user", content: [{ type: "text", text: "please write the final report" }], timestamp: Date.now() },
    ],
  };
  const clamped = clampMaxTokensToContext({ contextWindow: 200_000 } as never, context as never, 64_000);
  assert.equal(clamped, 1, "upstream floors the cap at 1 instead of failing or compacting");
});

for (const capKey of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
  test(`output guard handles small and exhausted budgets via ${capKey}`, () => {
    const p = { [capKey]: 1, messages: [{ role: "user", content: "hello" }] };
    assert.equal(guardOutputBudget(p, FABLE).kind, "raised");
    assert.equal(p[capKey], FABLE.maxTokens);
    const full = { [capKey]: 1, messages: [{ role: "user", content: "x".repeat(790_000) }] };
    assert.throws(() => guardOutputBudget(full, FABLE), /prompt is too long/i);
  });
}

const imageBlock = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

test("trimPayloadToByteBudget returns the payload untouched when it fits", () => {
  const payload = { messages: [{ role: "user", content: [imageBlock("AAAA".repeat(100))] }] };
  assert.equal(trimPayloadToByteBudget(payload, 10_000_000), payload, "same reference — no clone, no cache churn");
  assert.equal(trimPayloadToByteBudget(null, 10), null);
  assert.equal(trimPayloadToByteBudget("nope", 10), "nope");
});

test("trimPayloadToByteBudget sheds the OLDEST images first and keeps the newest", () => {
  const big = "AAAA".repeat(2_000_000);
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }, imageBlock(big)] },
      { role: "user", content: [imageBlock(big)] },
      { role: "user", content: [imageBlock(big)] },
    ],
  };
  const out = trimPayloadToByteBudget(payload, 18_000_000) as any;
  assert.notEqual(out, payload);
  assert.equal(out.messages[0].content[1].type, "text", "oldest image replaced with a placeholder");
  assert.match(out.messages[0].content[1].text, /image removed/);
  assert.equal(out.messages[1].content[0].type, "text", "second-oldest also shed to reach slack headroom");
  assert.equal(out.messages[2].content[0].type, "image", "newest image survives");
  assert.ok(JSON.stringify(out).length <= 18_000_000, "result fits the budget");
  assert.equal((payload.messages[0]!.content[1] as any).type, "image", "input payload not mutated");
});

test("trimPayloadToByteBudget reaches images nested in tool_result content", () => {
  const big = "AAAA".repeat(5_000_000);
  const payload = {
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [imageBlock(big)] }] },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
  };
  const out = trimPayloadToByteBudget(payload, 18_000_000) as any;
  const inner = out.messages[0].content[0].content[0];
  assert.equal(inner.type, "text");
  assert.match(inner.text, /image removed/);
  assert.equal(out.messages[0].content[0].tool_use_id, "t1", "tool_result envelope preserved");
  assert.ok(JSON.stringify(out).length <= 18_000_000);
});

test("trimPayloadToByteBudget also trims the OpenAI Responses wire shape", () => {
  const dataUrl = `data:image/png;base64,${"AAAA".repeat(5_000_000)}`;
  const payload = {
    input: [
      { role: "user", content: [{ type: "input_image", detail: "auto", image_url: dataUrl }] },
      { role: "user", content: [{ type: "input_text", text: "latest" }] },
    ],
  };
  const out = trimPayloadToByteBudget(payload, 18_000_000) as any;
  assert.deepEqual(out.input[0].content[0], {
    type: "input_text",
    text: out.input[0].content[0].text,
  });
  assert.match(out.input[0].content[0].text, /image removed/);
  assert.ok(JSON.stringify(out).length <= 18_000_000);
});

test("trimPayloadToByteBudget keeps a shed image block's cache_control breakpoint", () => {
  const big = "AAAA".repeat(5_000_000);
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: big },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
  };
  const out = trimPayloadToByteBudget(payload, 18_000_000) as any;
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal(out.messages[0].content[0].type, "text");
});

test("transportFromModel keeps the model id + string headers (the anthropic-beta that the body omits)", () => {
  const model = { id: "claude-opus-4-8", headers: { "anthropic-beta": "fast,interleaved", "x-num": 7 } };
  assert.deepEqual(
    transportFromModel(model),
    {
      modelId: "claude-opus-4-8",
      headers: { "anthropic-beta": "fast,interleaved" },
    },
    "non-string header values are dropped",
  );
  assert.equal(transportFromModel({}), undefined, "no id and no headers → no transport");
  assert.equal(transportFromModel(null), undefined, "no model → no transport");
});
