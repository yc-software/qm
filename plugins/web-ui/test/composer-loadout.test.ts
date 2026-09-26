import assert from "node:assert/strict";
import test from "node:test";
import {
  compatibleHarnessOptions,
  effortLevelsForHarness,
  loadoutModelId,
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

function option(value: string): ModelOption {
  const separator = value.indexOf(":");
  const harnessId = separator < 0 ? "pi" : value.slice(0, separator);
  const id = loadoutModelId(value);
  return {
    value,
    harnessId,
    harnessLabel: harnessId,
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
        { value: "pi:bad", effort: "extreme", fast: true },
        { value: "pi:missing" },
        { value: "pi:valid", effort: "low", fast: "true" },
        { value: "codex:other", effort: "xhigh", fast: true },
      ]),
    ),
    [entry("pi:valid", "low"), entry("codex:other", "xhigh", true)],
  );
});

test("persistence keeps the first valid model settings and eight unique models in order", () => {
  const saved = [
    entry("pi:first", "high", true),
    entry("pi:second", "medium"),
    entry("pi:first", "low"),
    ...["third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"].map((id) => entry(`pi:${id}`)),
  ];
  assert.deepEqual(parseLoadout(JSON.stringify(saved)), [saved[0], saved[1], ...saved.slice(3, 9)]);
});

test("legacy harness pairs merge into one model preference while preserving the first settings", () => {
  const first = entry("claude:one", "high", true);
  const legacy = entry("two", "low");
  assert.deepEqual(parseLoadout(JSON.stringify([first, entry("pi:one", "max"), legacy, entry("codex:two", "xhigh")])), [
    first,
    legacy,
  ]);
  assert.deepEqual(parseLoadout(JSON.stringify([legacy, entry("pi:two"), first])), [legacy, first]);
});

test("model identity preserves colon-containing model ids and unqualified legacy values", () => {
  assert.equal(loadoutModelId("pi:provider/model:free"), "provider/model:free");
  assert.equal(loadoutModelId("claude:one"), "one");
  assert.equal(loadoutModelId("legacy"), "legacy");
  const free = entry("pi:provider/model:free", "high");
  const paid = entry("pi:provider/model:paid", "low");
  assert.deepEqual(parseLoadout(JSON.stringify([free, entry("opencode:provider/model:free"), paid])), [free, paid]);
});

test("reconciliation removes unavailable models and keeps a valid active model's position and current tweaks", () => {
  const saved = [entry("pi:gone"), entry("codex:one", "high"), entry("pi:two", "low", true)];
  const snapshot = structuredClone(saved);
  const active = entry("codex:one", "xhigh", true);
  assert.deepEqual(reconcileLoadout(saved, [option("pi:two"), option("codex:one")], active), [active, saved[2]]);
  assert.deepEqual(saved, snapshot);
});

test("reconciliation never restores an unavailable active model", () => {
  const saved = [entry("pi:gone", "max", true), entry("codex:one", "medium")];
  assert.deepEqual(reconcileLoadout(saved, [option("codex:one")], saved[0]!), [saved[1]]);
  assert.deepEqual(reconcileLoadout(saved, [], saved[0]!), []);
});

test("an unavailable saved harness falls back to another harness for the same model in the same slot", () => {
  const saved = [entry("claude:one", "high", true), entry("pi:two", "low"), entry("codex:gone")];
  const snapshot = structuredClone(saved);
  const options = [option("opencode:two"), option("pi:one"), option("claude:two")];
  assert.deepEqual(reconcileLoadout(saved, options, entry("codex:gone")), [
    entry("pi:one", "high", true),
    entry("opencode:two", "low"),
  ]);
  assert.deepEqual(saved, snapshot);
});

test("reconciliation qualifies legacy values and replaces duplicate harness pairs with the active preference", () => {
  const saved = [entry("one", "high", true), entry("pi:two", "low"), entry("claude:one", "max")];
  const active = entry("claude:one", "medium");
  const options = [option("pi:one"), option("claude:one"), option("pi:two")];
  assert.deepEqual(reconcileLoadout(saved, options, entry("pi:missing")), [entry("pi:one", "high", true), saved[1]]);
  assert.deepEqual(reconcileLoadout(saved, options, active), [active, saved[1]]);
});

test("a new active model remains selectable even when eight saved models fill the loadout", () => {
  const saved = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((id) => entry(`pi:${id}`));
  const active = entry("codex:nine", "xhigh", true);
  const options = [...saved, active].map(({ value }) => option(value));
  assert.deepEqual(reconcileLoadout(saved, options, active), [...saved.slice(0, 7), active]);
  assert.deepEqual(reconcileLoadout([], options, active), [active]);
});

test("editing a setup preserves order and other models' independent effort and fast settings", () => {
  const first = entry("pi:first", "low", true);
  const second = entry("codex:second", "high");
  const saved = [first, second];
  const updated = entry(second.value, "xhigh", true);
  const next = upsertLoadout(saved, updated);
  assert.deepEqual(next, [first, updated]);
  assert.deepEqual(saved, [first, second]);
  assert.deepEqual(parseLoadout(JSON.stringify(next)), next);
});

test("adding at capacity preserves the newly selected model and never duplicates an existing setup", () => {
  const saved = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((id) => entry(`pi:${id}`));
  const active = entry("codex:nine", "xhigh", true);
  assert.deepEqual(upsertLoadout(saved, active), [...saved.slice(0, 7), active]);
  assert.deepEqual(upsertLoadout([...saved, active], active), [...saved.slice(0, 7), active]);
  const updated = entry(saved[1]!.value, "max", true);
  assert.deepEqual(upsertLoadout(saved, updated), [saved[0], updated, ...saved.slice(2)]);
  assert.deepEqual(upsertLoadout([saved[0]!, saved[0]!], updated), [saved[0], updated]);
});

test("changing a model's harness updates its existing slot even at capacity", () => {
  const saved = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((id) => entry(`pi:${id}`));
  const snapshot = structuredClone(saved);
  const changed = entry("claude:two", "high", true);
  assert.deepEqual(upsertLoadout(saved, changed), [saved[0], changed, ...saved.slice(2)]);
  assert.deepEqual(upsertLoadout([entry("two"), entry("pi:one"), entry("pi:two")], changed), [
    changed,
    entry("pi:one"),
  ]);
  assert.deepEqual(saved, snapshot);
});

test("compatible harness choices never substitute another model and deduplicate a harness", () => {
  const options = [option("pi:one"), option("codex:two"), option("claude:one"), option("pi:one")];
  assert.deepEqual(compatibleHarnessOptions(options, "one"), [options[0], options[2]]);
  assert.deepEqual(compatibleHarnessOptions(options, "two"), [options[1]]);
  assert.deepEqual(compatibleHarnessOptions(options, "missing"), []);
});

test("the model catalog has one row per model and remembers each model's saved harness", () => {
  const options = [
    option("pi:one"),
    option("pi:two"),
    option("claude:one"),
    option("codex:two"),
    option("codex:three"),
    option("codex:two"),
  ];
  const saved = [entry("claude:one"), entry("pi:one"), entry("pi:two")];
  assert.deepEqual(modelLoadoutOptions(options, saved, "codex"), [options[2], options[1], options[4]]);
  assert.deepEqual(modelLoadoutOptions(options, [], "codex"), [options[0], options[3], options[4]]);
  assert.deepEqual(modelLoadoutOptions(options, []), [options[0], options[1], options[4]]);
});

test("the model catalog falls back from unavailable saved harnesses using only compatible options", () => {
  const options = [option("pi:one"), option("pi:two"), option("claude:one")];
  const saved = [entry("opencode:one"), entry("codex:two"), entry("pi:gone")];
  assert.deepEqual(modelLoadoutOptions(options, saved, "claude"), [options[2], options[1]]);
  assert.deepEqual(modelLoadoutOptions(options, saved, "unavailable"), [options[0], options[1]]);
  assert.deepEqual(modelLoadoutOptions([], saved, "claude"), []);
});

test("harness effort choices exclude unsupported settings and label extra high clearly", () => {
  assert.deepEqual(
    effortLevelsForHarness("pi").map(({ value }) => value),
    ["low", "medium", "high", "xhigh", "max", "ultracode"],
  );
  assert.deepEqual(
    effortLevelsForHarness("claude").map(({ value }) => value),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    effortLevelsForHarness("codex").map(({ value }) => value),
    ["low", "medium", "high", "xhigh"],
  );
  for (const harnessId of ["pi", "claude", "codex"])
    assert.equal(effortLevelsForHarness(harnessId).find(({ value }) => value === "xhigh")?.label, "Extra high");
  for (const harnessId of ["opencode", "mock", "unknown"])
    assert.deepEqual(effortLevelsForHarness(harnessId), [{ value: "auto", label: "Legacy default" }]);
});

test("native reasoning choices require model and harness metadata while legacy settings survive", () => {
  const model = {
    ...option("pi:one").model,
    effortLevelsByHarness: {
      pi: ["auto", "adaptive", "default", "low", "high"],
      claude: ["auto", "low", "high"],
    },
  };
  assert.deepEqual(effortLevelsForHarness("pi", model), [
    { value: "adaptive", label: "Auto" },
    { value: "default", label: "Provider default" },
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ]);
  assert.equal(effortLevelsForHarness("pi", model, "auto")[0]?.label, "Legacy default");
  for (const harness of ["claude", "codex"])
    assert.ok(
      effortLevelsForHarness(harness, model, "adaptive").every(
        ({ value }) => value !== "adaptive" && value !== "default",
      ),
    );
  for (const selected of ["auto", "adaptive", "default"])
    assert.ok(
      effortLevelsForHarness("pi", option("pi:one").model, selected).every(
        ({ value }) => value !== "adaptive" && value !== "default",
      ),
    );
  const withoutEfforts = { ...model, effortLevelsByHarness: { pi: [] } };
  assert.deepEqual(effortLevelsForHarness("pi", withoutEfforts), [{ value: "auto", label: "Legacy default" }]);
  const saved = [entry("pi:one", "adaptive"), entry("pi:two", "default"), entry("pi:three", "auto")];
  assert.deepEqual(parseLoadout(JSON.stringify(saved)), saved);
});
