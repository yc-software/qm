import assert from "node:assert/strict";
import test from "node:test";
import {
  effortLevelsForModel,
  loadoutActions,
  ultrafastChoice,
  modelLoadoutOptions,
  parseLoadout,
  reconcileLoadout,
  upsertLoadout,
  type LoadoutEntry,
} from "../src/composer-loadout.ts";
import type { ModelOption } from "../src/model-options.ts";

function entry(value: string, effort: LoadoutEntry["effort"] = "auto", fast = false): LoadoutEntry {
  return { value, effort, fast };
}

function option(id: string): ModelOption {
  return {
    value: id,
    label: id,
    buttonLabel: id,
    groupLabel: "Models",
    model: {
      id,
      name: id,
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
  };
}

test("invalid persistence cannot create a loadout or invent an effort level", () => {
  for (const raw of [null, "", "{", "null", "true", '"model"', "{}"]) assert.deepEqual(parseLoadout(raw), []);
  assert.deepEqual(
    parseLoadout(
      JSON.stringify([
        null,
        8,
        [],
        { value: 7, effort: "high" },
        { value: " ", effort: "auto" },
        { value: "bad", effort: "extreme", fast: true },
        { value: "missing" },
        { value: "valid", effort: "low", fast: "true" },
        { value: "other", effort: "xhigh", fast: true },
      ]),
    ),
    [entry("valid", "low"), entry("other", "xhigh", true)],
  );
});

test("persistence keeps the first valid model settings and eight unique models in order", () => {
  const saved = [
    entry("first", "high", true),
    entry("second", "medium"),
    entry("first", "low"),
    ...["third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"].map((id) => entry(id)),
  ];
  assert.deepEqual(parseLoadout(JSON.stringify(saved)), [saved[0], saved[1], ...saved.slice(3, 9)]);
});

test("model identity preserves colon-containing model ids", () => {
  const free = entry("provider/model:free", "high");
  const paid = entry("provider/model:paid", "low");
  assert.deepEqual(parseLoadout(JSON.stringify([free, entry("provider/model:free"), paid])), [free, paid]);
});

test("reconciliation removes unavailable models and keeps a valid active model's position and current tweaks", () => {
  const saved = [entry("gone"), entry("one", "high"), entry("two", "low", true)];
  const snapshot = structuredClone(saved);
  const active = entry("one", "xhigh", true);
  assert.deepEqual(reconcileLoadout(saved, [option("two"), option("one")], active), [active, saved[2]]);
  assert.deepEqual(saved, snapshot);
});

test("reconciliation never restores an unavailable active model", () => {
  const saved = [entry("gone", "max", true), entry("one", "medium")];
  assert.deepEqual(reconcileLoadout(saved, [option("one")], saved[0]!), [saved[1]]);
  assert.deepEqual(reconcileLoadout(saved, [], saved[0]!), []);
});

test("a new active model remains selectable even when eight saved models fill the loadout", () => {
  const saved = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((id) => entry(id));
  const active = entry("nine", "xhigh", true);
  const options = [...saved, active].map(({ value }) => option(value));
  assert.deepEqual(reconcileLoadout(saved, options, active), [...saved.slice(0, 7), active]);
  assert.deepEqual(reconcileLoadout([], options, active), [active]);
});

test("editing a setup preserves order and other models' independent effort and fast settings", () => {
  const first = entry("first", "low", true);
  const second = entry("second", "high");
  const saved = [first, second];
  const updated = entry(second.value, "xhigh", true);
  const next = upsertLoadout(saved, updated);
  assert.deepEqual(next, [first, updated]);
  assert.deepEqual(saved, [first, second]);
  assert.deepEqual(parseLoadout(JSON.stringify(next)), next);
});

test("adding at capacity preserves the newly selected model and never duplicates an existing setup", () => {
  const saved = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((id) => entry(id));
  const active = entry("nine", "xhigh", true);
  assert.deepEqual(upsertLoadout(saved, active), [...saved.slice(0, 7), active]);
  assert.deepEqual(upsertLoadout([...saved, active], active), [...saved.slice(0, 7), active]);
  const updated = entry(saved[1]!.value, "max", true);
  assert.deepEqual(upsertLoadout(saved, updated), [saved[0], updated, ...saved.slice(2)]);
  assert.deepEqual(upsertLoadout([saved[0]!, saved[0]!], updated), [saved[0], updated]);
});

test("effort choices without model metadata exclude provider-native settings and label extra high clearly", () => {
  assert.deepEqual(
    effortLevelsForModel().map(({ value }) => value),
    ["auto", "low", "medium", "high", "xhigh", "max", "ultracode"],
  );
  assert.equal(effortLevelsForModel().find(({ value }) => value === "xhigh")?.label, "Extra high");
});

test("native reasoning choices require model metadata and always offer Default", () => {
  const model = { ...option("one").model, effortLevels: ["auto", "adaptive", "default", "low", "high"] };
  assert.deepEqual(effortLevelsForModel(model), [
    { value: "auto", label: "Default" },
    { value: "adaptive", label: "Auto" },
    { value: "default", label: "Provider default" },
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ]);
  assert.ok(
    effortLevelsForModel(option("one").model).every(({ value }) => value !== "adaptive" && value !== "default"),
  );
  const withoutEfforts = { ...model, effortLevels: [] };
  assert.deepEqual(effortLevelsForModel(withoutEfforts), [{ value: "auto", label: "Default" }]);
  const saved = [entry("one", "adaptive"), entry("two", "default"), entry("three", "auto")];
  assert.deepEqual(parseLoadout(JSON.stringify(saved)), saved);
});

for (const modelId of ["gpt-6-astra", "gpt-6.1-sol"]) {
  test(`${modelId} speed variants share a preset and preserve a saved tier`, () => {
    const base = option(modelId);
    const ultra = option(`${modelId}-ultrafast`);
    const saved = entry(ultra.value, "high");
    assert.deepEqual(modelLoadoutOptions([ultra, base], []), [base]);
    assert.deepEqual(modelLoadoutOptions([base, ultra], [saved]), [ultra]);
    assert.deepEqual(modelLoadoutOptions([ultra], []), [ultra]);
    assert.deepEqual(upsertLoadout([entry(base.value)], saved), [saved]);
    assert.deepEqual(parseLoadout(JSON.stringify([saved, entry(base.value)])), [saved]);
    assert.equal(ultrafastChoice([base, ultra], base), ultra);
    assert.equal(ultrafastChoice([base, ultra], ultra), base);
    assert.equal(ultrafastChoice([base], base), undefined);
    let current = saved;
    const actions = loadoutActions(
      () => [base, ultra],
      () => current,
      (_, next) => {
        current = next;
      },
      (id) => id === modelId,
    );
    actions.toggleFastMode();
    assert.deepEqual(current, entry(base.value, "high", true));
    actions.toggleFastMode();
    assert.deepEqual(current, entry(base.value, "high", false));
  });
}
