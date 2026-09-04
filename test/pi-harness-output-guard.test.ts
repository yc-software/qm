import { test } from "node:test";
import assert from "node:assert/strict";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import {
  guardOutputBudget,
  OUTPUT_BUDGET_FLOOR_TOKENS,
  OUTPUT_GUARD_SAFETY_TOKENS,
} from "../src/harness/pi-harness.ts";

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

test("a PDF document source is not mistaken for an image", () => {
  const doc = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "P".repeat(790_000) },
  };
  const p = payload({
    max_tokens: 1,
    messages: [{ role: "user", content: [doc, { type: "text", text: "summarize" }] }],
  });
  assert.throws(() => guardOutputBudget(p, FABLE), /prompt is too long/i, "counted at full length -> refused");
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
