import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampGrindBudget,
  createGrindMeter,
  enforceGrindBudget,
  grindNudge,
  grindState,
  grindStopProgress,
  hasGrindWaiver,
  meterGrindCall,
  parseGrindDirective,
} from "../src/harness/grind.ts";

test("parses every grind unit and strips the directive", () => {
  assert.deepEqual(parseGrindDirective("/grind 20t inspect this"), {
    input: "inspect this",
    grind: { minTurns: 20 },
  });
  assert.deepEqual(parseGrindDirective("/grind 45m — inspect this"), {
    input: "inspect this",
    grind: { minMs: 2_700_000 },
  });
  assert.deepEqual(parseGrindDirective("/grind 2h inspect this"), {
    input: "inspect this",
    grind: { minMs: 7_200_000 },
  });
  assert.deepEqual(parseGrindDirective("/grind 500k inspect this"), {
    input: "inspect this",
    grind: { minTokens: 500_000 },
  });
  assert.deepEqual(parseGrindDirective("/grind $3 inspect this"), {
    input: "inspect this",
    grind: { minUsd: 3 },
  });
});

test("combines floors with AND and allows an empty task", () => {
  assert.deepEqual(parseGrindDirective("/grind 1h $5 20t 10k"), {
    input: "",
    grind: { minMs: 3_600_000, minUsd: 5, minTurns: 20, minTokens: 10_000 },
  });
  assert.deepEqual(parseGrindDirective("/grind 1h 30m 2h 5t 9t audit"), {
    input: "audit",
    grind: { minMs: 7_200_000, minTurns: 9 },
  });
});

test("preserves task whitespace after stripping the directive", () => {
  assert.deepEqual(parseGrindDirective("/grind 2t — first line\n\n  indented line"), {
    input: "first line\n\n  indented line",
    grind: { minTurns: 2 },
  });
});

test("fails open for malformed directives and bare numbers", () => {
  for (const input of ["/grind", "/grind nope", "/grind 2000 audit", "/grind 0t audit", "x /grind 2t"]) {
    assert.deepEqual(parseGrindDirective(input), { input });
  }
});

test("clamps a time floor to the hard wall-clock ceiling", () => {
  assert.deepEqual(clampGrindBudget({ minMs: 7_200_000, minTurns: 2 }, 1_800_000), {
    minMs: 1_800_000,
    minTurns: 2,
    clampedMs: true,
  });
});

test("meters assistant steps, provider tokens, and model-priced dollars", () => {
  const meter = createGrindMeter(1_000);
  meterGrindCall(
    meter,
    { input: 2_000, output: 1_000, cacheRead: 0, cacheWrite: 0, totalTokens: 99_000, costUsd: 99 },
    "claude-opus-4",
  );
  meterGrindCall(
    meter,
    { input: 500, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000, costUsd: 0 },
    "unknown-model",
  );
  assert.deepEqual(
    { ...meter, usd: Number(meter.usd.toFixed(4)) },
    {
      turns: 2,
      tokens: 4_000,
      usd: 0.05,
      startedAt: 1_000,
    },
  );
  assert.equal(grindState({ minTurns: 2, minTokens: 4_000, minUsd: 0.05, minMs: 5_000 }, meter, 6_000).met, true);
});

test("an unmet stop produces the required continuation message", () => {
  const state = grindState({ minTurns: 3, minTokens: 1_000 }, { turns: 1, tokens: 200, usd: 0, startedAt: 0 }, 1);
  assert.equal(state.met, false);
  assert.equal(
    grindNudge(state, true),
    "[grind] Budget floor not met: 1/3 turns, 200/1000 tokens. Wall-clock floor was clamped to the turn ceiling. Do not summarize or conclude; go deeper on the least-examined area.",
  );
});

test("five progress-free nudges auto-waive and tool use resets the guard", () => {
  let progress = { attempts: 0, toolCalls: 0 };
  for (let i = 0; i < 4; i++) {
    const next = grindStopProgress(progress, 0);
    assert.equal(next.waive, false);
    progress = next;
  }
  assert.equal(grindStopProgress(progress, 0).waive, true);
  assert.deepEqual(grindStopProgress(progress, 1), { attempts: 1, toolCalls: 1, waive: false });
});

test("recognizes only visible explicit waiver lines", () => {
  assert.equal(hasGrindWaiver("work\n[grind-waived: no useful path remains]\n"), true);
  assert.equal(hasGrindWaiver("work [grind-waived: inline]"), false);
  assert.equal(hasGrindWaiver("[grind-waived:]"), false);
});

test("the continuation loop intercepts silent stops and exposes the stall waiver", async () => {
  const meter = createGrindMeter(0);
  let silent = true;
  const prompts: string[] = [];
  const result = await enforceGrindBudget({
    grind: { minTurns: 20 },
    meter,
    outcome: "ok",
    ok: "ok",
    closingText: () => "",
    toolCalls: () => 0,
    blocked: () => false,
    beforePrompt: (note) => {
      silent = false;
      prompts.push(note);
    },
    prompt: async () => {
      meterGrindCall(meter, null, "test-model");
      return "ok";
    },
  });
  assert.equal(silent, false);
  assert.equal(prompts.length, 4);
  assert.ok(prompts.every((note) => note.startsWith("[grind] Budget floor not met:")));
  assert.equal(result.waiverNote, "[grind waived: agent made no progress after 5 nudges]");
});

test("the continuation loop honors explicit waiver and tool progress", async () => {
  const meter = createGrindMeter(0);
  let text = "initial stop";
  let tools = 0;
  let prompts = 0;
  const result = await enforceGrindBudget({
    grind: { minTurns: 10 },
    meter,
    outcome: "ok",
    ok: "ok",
    closingText: () => text,
    toolCalls: () => tools,
    blocked: () => false,
    beforePrompt: () => {
      prompts++;
    },
    prompt: async () => {
      tools++;
      meterGrindCall(meter, null, "test-model");
      text = prompts === 2 ? "[grind-waived: diminishing returns]" : "another stop";
      return "ok";
    },
  });
  assert.equal(prompts, 2);
  assert.equal(result.waiverNote, "");
});
