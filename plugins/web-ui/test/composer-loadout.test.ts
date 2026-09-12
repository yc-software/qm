import assert from "node:assert/strict";
import test from "node:test";
import {
  effortLevelsForHarness,
  harnessTarget,
  isPeakEffort,
  parseLoadout,
  reconcileLoadout,
  reorderLoadout,
  upsertLoadout,
  type LoadoutEntry,
} from "../src/composer-loadout.ts";
import type { ModelOption } from "../src/model-options.ts";

function entry(value: string, effort: LoadoutEntry["effort"] = "auto", fast = false): LoadoutEntry {
  return { value, effort, fast };
}

function option(value: string): ModelOption {
  const [harnessId = "pi", id = value] = value.split(":");
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
        { value: "codex:valid", effort: "xhigh", fast: true },
      ]),
    ),
    [entry("pi:valid", "low"), entry("codex:valid", "xhigh", true)],
  );
});

test("persistence keeps the first valid model settings and five unique models in order", () => {
  const saved = [
    entry("pi:first", "high", true),
    entry("pi:second", "medium"),
    entry("pi:first", "low"),
    ...["third", "fourth", "fifth", "sixth"].map((id) => entry(`pi:${id}`)),
  ];
  assert.deepEqual(parseLoadout(JSON.stringify(saved)), [saved[0], saved[1], saved[3], saved[4], saved[5]]);
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

test("a new active model remains selectable even when five saved models fill the loadout", () => {
  const saved = ["one", "two", "three", "four", "five"].map((id) => entry(`pi:${id}`));
  const active = entry("codex:six", "xhigh", true);
  const options = [...saved, active].map(({ value }) => option(value));
  assert.deepEqual(reconcileLoadout(saved, options, active), [...saved.slice(0, 4), active]);
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
  const saved = ["one", "two", "three", "four", "five"].map((id) => entry(`pi:${id}`));
  const active = entry("codex:six", "xhigh", true);
  assert.deepEqual(upsertLoadout(saved, active), [...saved.slice(0, 4), active]);
  assert.deepEqual(upsertLoadout([...saved, active], active), [...saved.slice(0, 4), active]);
  const updated = entry(saved[1]!.value, "max", true);
  assert.deepEqual(upsertLoadout(saved, updated), [saved[0], updated, ...saved.slice(2)]);
  assert.deepEqual(upsertLoadout([saved[0]!, saved[0]!], updated), [saved[0], updated]);
});

test("drag ordering moves a setup into the target position without separating its settings", () => {
  const saved = [entry("pi:first", "max", true), entry("codex:second", "xhigh"), entry("pi:third", "low")];
  const snapshot = structuredClone(saved);
  assert.deepEqual(reorderLoadout(saved, "pi:first", "pi:third"), [saved[1], saved[2], saved[0]]);
  assert.deepEqual(reorderLoadout(saved, "pi:third", "pi:first"), [saved[2], saved[0], saved[1]]);
  assert.deepEqual(reorderLoadout(saved, "pi:first", "pi:first"), saved);
  assert.deepEqual(reorderLoadout(saved, "missing", "pi:first"), saved);
  assert.deepEqual(reorderLoadout(saved, "pi:first", "missing"), saved);
  assert.deepEqual(saved, snapshot);
});

test("harness effort choices exclude unsupported settings and label extra high clearly", () => {
  assert.deepEqual(
    effortLevelsForHarness("pi").map(({ value }) => value),
    ["auto", "low", "medium", "high", "xhigh", "max", "ultracode"],
  );
  assert.deepEqual(
    effortLevelsForHarness("claude").map(({ value }) => value),
    ["auto", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    effortLevelsForHarness("codex").map(({ value }) => value),
    ["auto", "low", "medium", "high", "xhigh"],
  );
  for (const harnessId of ["pi", "claude", "codex"])
    assert.equal(effortLevelsForHarness(harnessId).find(({ value }) => value === "xhigh")?.label, "Extra high");
  for (const harnessId of ["opencode", "mock", "unknown"])
    assert.deepEqual(effortLevelsForHarness(harnessId), [{ value: "auto", label: "Auto" }]);
});

test("switching harness keeps the same model when the new harness offers it", () => {
  const options = [
    { value: "codex:gpt-5.6-sol", model: { id: "gpt-5.6-sol" } },
    { value: "codex:gpt-6-astra", model: { id: "gpt-6-astra" } },
  ];
  assert.equal(harnessTarget(options, "gpt-6-astra", [])?.value, "codex:gpt-6-astra");
});

test("switching harness falls back to a model already in the loadout", () => {
  const options = [
    { value: "pi:claude-sonnet-5", model: { id: "claude-sonnet-5" } },
    { value: "pi:claude-opus-5", model: { id: "claude-opus-5" } },
  ];
  const loadout = [{ value: "pi:claude-opus-5" }];
  assert.equal(harnessTarget(options, "gpt-6-astra", loadout)?.value, "pi:claude-opus-5");
});

test("switching harness otherwise takes the first model the harness serves", () => {
  const options = [
    { value: "pi:claude-fable-5-1", model: { id: "claude-fable-5-1" } },
    { value: "pi:claude-opus-5", model: { id: "claude-opus-5" } },
  ];
  assert.equal(harnessTarget(options, "gpt-6-astra", [])?.value, "pi:claude-fable-5-1");
});

test("a harness that serves nothing yields no target", () => {
  assert.equal(harnessTarget([], "claude-opus-5", [{ value: "pi:claude-opus-5" }]), undefined);
});

test("the top three effort tiers are the peak tiers", () => {
  for (const level of ["xhigh", "max", "ultracode"]) assert.equal(isPeakEffort(level), true, level);
  for (const level of ["auto", "low", "medium", "high"]) assert.equal(isPeakEffort(level), false, level);
  assert.equal(isPeakEffort(undefined), false);
});

test("every peak tier is a level some harness actually offers", () => {
  const offered = new Set(["pi", "codex", "claude"].flatMap((h) => effortLevelsForHarness(h).map((l) => l.value)));
  for (const level of ["xhigh", "max", "ultracode"]) assert.ok(offered.has(level), `${level} is offered by no harness`);
});
