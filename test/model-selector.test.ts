import { Check } from "typebox/value";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isModelSelector, modelSelectorSchema, resolveModelSelector } from "../src/harness/model-selector.ts";
import type { RuntimeChoice } from "../src/harness/harness.ts";

const inherited: RuntimeChoice = {
  harnessId: "pi",
  modelId: "gpt-6-astra",
  effortLevel: "high",
  fastMode: true,
};
const catalog = {
  approvedHarnesses: ["pi", "codex", "opencode"] as const,
  modelsByHarness: {
    pi: ["gpt-6-astra", "codex/gpt-5.6-sol", "claude-sonnet-5"],
    codex: ["gpt-6-astra"],
    opencode: ["gpt-6-astra"],
  },
  modelCatalog: {
    "gpt-6-astra": { name: "GPT-6 Astra", label: "Astra", buttonLabel: "Astra" },
    "codex/gpt-5.6-sol": { name: "Astra subscription" },
    "claude-sonnet-5": { name: "Sonnet 5" },
  },
};

test("selector shape preserves complete legacy choices and accepts partial settings", () => {
  assert.equal(isModelSelector(inherited), true);
  assert.equal(Check(modelSelectorSchema, inherited), true);
  assert.equal(isModelSelector({ modelId: "Astra" }), true);
  assert.equal(isModelSelector({ modelId: "Astra", effortLevel: "auto", fastMode: false }), true);
  for (const value of [
    null,
    "Astra",
    "inherit",
    [],
    {},
    { modelId: " " },
    { modelId: "Astra", harnessId: "unknown" },
    { modelId: "Astra", effortLevel: "" },
    { modelId: "Astra", fastMode: "false" },
    { modelId: "Astra", provider: "openai" },
  ]) {
    assert.equal(isModelSelector(value), false, JSON.stringify(value));
    assert.equal(Check(modelSelectorSchema, value), false, JSON.stringify(value));
  }
});

test("inherit and omitted settings retain the complete authoritative runtime without mutating it", () => {
  const original = { ...inherited };
  for (const selector of ["inherit", { modelId: "gpt-6-astra" }] as const) {
    const result = resolveModelSelector(selector, inherited, catalog);
    assert.deepEqual(result, { ok: true, choice: inherited });
    if (result.ok) assert.notEqual(result.choice, inherited);
  }
  assert.deepEqual(inherited, original);
  const minimal = { harnessId: "pi", modelId: "gpt-6-astra" } as const;
  assert.deepEqual(resolveModelSelector("inherit", minimal, catalog), { ok: true, choice: minimal });
});

test("exact aliases resolve only on the requested harness and explicit false overrides fast mode", () => {
  for (const modelId of ["Astra", "astra", "GPT-6 ASTRA"]) {
    assert.deepEqual(resolveModelSelector({ modelId, fastMode: false, effortLevel: "low" }, inherited, catalog), {
      ok: true,
      choice: { ...inherited, effortLevel: "low", fastMode: false },
    });
  }
  assert.deepEqual(resolveModelSelector({ modelId: "Astra", harnessId: "codex" }, inherited, catalog), {
    ok: true,
    choice: { ...inherited, harnessId: "codex" },
  });
  assert.deepEqual(resolveModelSelector({ modelId: "claude-sonnet-5", harnessId: "codex" }, inherited, catalog), {
    ok: false,
    error: "model_unavailable",
    candidates: ["gpt-6-astra"],
  });
});

test("unavailable and ambiguous selectors fail closed without choosing another model or harness", () => {
  const ambiguous = {
    ...catalog,
    modelCatalog: { ...catalog.modelCatalog, "codex/gpt-5.6-sol": { label: "Astra" } },
  };
  assert.deepEqual(resolveModelSelector({ modelId: "Astra" }, inherited, ambiguous), {
    ok: false,
    error: "model_ambiguous",
    candidates: ["gpt-6-astra", "codex/gpt-5.6-sol"],
  });
  assert.deepEqual(resolveModelSelector({ modelId: "gpt-6-astra" }, inherited, ambiguous), {
    ok: true,
    choice: inherited,
  });
  assert.equal(resolveModelSelector({ modelId: "Ast" }, inherited, catalog).ok, false);
  assert.deepEqual(resolveModelSelector({ modelId: "Astra", harnessId: "claude" }, inherited, catalog), {
    ok: false,
    error: "harness_not_approved",
    candidates: ["pi", "codex", "opencode"],
  });
  assert.equal(resolveModelSelector("inherit", inherited, { ...catalog, modelsByHarness: {} }).ok, false);
});

test("inherit cannot rebind an unavailable ID to a display alias or a different billing route", () => {
  const subscription: RuntimeChoice = { ...inherited, modelId: "codex/gpt-5.6-sol", fastMode: false };
  assert.deepEqual(resolveModelSelector("inherit", subscription, catalog), { ok: true, choice: subscription });
  const directOnly = {
    ...catalog,
    modelsByHarness: { pi: ["gpt-6-astra"] },
    modelCatalog: { "gpt-6-astra": { label: "codex/gpt-5.6-sol" } },
  };
  assert.deepEqual(resolveModelSelector("inherit", subscription, directOnly), {
    ok: false,
    error: "model_unavailable",
    candidates: ["gpt-6-astra"],
  });
});

test("incompatible inherited and explicit effort or fast settings fail rather than silently disappearing", () => {
  assert.deepEqual(resolveModelSelector({ modelId: "claude-sonnet-5" }, inherited, catalog), {
    ok: false,
    error: "fast_mode_not_supported",
  });
  assert.deepEqual(resolveModelSelector({ modelId: "Astra", harnessId: "opencode" }, inherited, catalog), {
    ok: false,
    error: "effort_not_supported",
  });
  assert.deepEqual(resolveModelSelector({ modelId: "Astra", effortLevel: "typo" }, inherited, catalog), {
    ok: false,
    error: "effort_not_supported",
  });
  assert.deepEqual(resolveModelSelector({ modelId: "claude-sonnet-5", fastMode: false }, inherited, catalog), {
    ok: true,
    choice: { ...inherited, modelId: "claude-sonnet-5", fastMode: false },
  });
});
