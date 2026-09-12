import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("Edit exposes changed runtime defaults and always allows an existing override to inherit", () => {
  const loadout = composer.slice(
    composer.indexOf("function loadoutControl"),
    composer.indexOf("function menuArrowKeys"),
  );
  assert.ok(/const runtimeToggled =\s*activeRuntimeConfig !== null/.test(loadout));
  assert.ok(loadout.includes("selected.value !== defaultModelValue(scopeKey())"));
  assert.ok(loadout.includes("composerState.effortLevel !== effective"));
  assert.ok(loadout.includes("fastOn !== (activeRuntimeConfig.effective.fastMode"));
  assert.ok(/loadoutEditing\s*\? html`<div class="loadout-edit-actions">/.test(loadout), "defaults belong under Edit");
  assert.ok(/runtimeToggled\s*\? html`<button[^`]*>\s*Make default\s*<\/button>/.test(loadout));
  assert.ok(
    /activeRuntimeConfig\?\.scopeOverride\s*\? html`<button[^`]*>\s*Use org default\s*<\/button>/.test(loadout),
    "inherit remains available when the selected setup already matches the personal default",
  );
  assert.ok(loadout.includes("changeScopeRuntime({ inherit: true }, agent)"));
});

test("compact and full composers share one left-side picker with Fast inside its menu", () => {
  const runtimeControls = /const runtimeControls = ([^\n]*)/.exec(composer)?.[1] ?? "";
  assert.match(
    runtimeControls,
    /loadoutControl\(agent, selectedModel, inputBlocked\)/,
    "compact surfaces must retain the full model and effort picker",
  );
  assert.match(
    runtimeControls,
    /harnessControl\(agent, selectedModel, inputBlocked\)/,
    "the harness picker rides beside it on both surfaces",
  );
  const leftStart = composer.indexOf('class="composer-left"');
  const rightStart = composer.indexOf('class="composer-right"');
  assert.ok(leftStart >= 0 && rightStart > leftStart);
  assert.ok(composer.slice(leftStart, rightStart).includes("showRuntimeControls ? runtimeControls : nothing"));
  assert.ok(/class="composer-right">\$\{sendControls\(agent\)\}<\/div>/.test(composer));
  const loadout = composer.slice(
    composer.indexOf("function loadoutControl"),
    composer.indexOf("function menuArrowKeys"),
  );
  assert.ok(/role="menuitemcheckbox"\s+aria-label="Fast"/.test(loadout));
  assert.ok(/fastAvailable\s*\? html`<button/.test(loadout));
  assert.equal((composer.match(/@click=\$\{\(\) => toggleFastMode\(agent\)\}/g) ?? []).length, 1);
});

test("switching setups preserves prior tweaks and validates effort and Fast for the selected model", () => {
  const apply = composer.slice(composer.indexOf("function applyLoadout"), composer.indexOf("function cycleEffort"));
  const remember = apply.indexOf("rememberActiveTweaks(previous)");
  const select = apply.indexOf("selectModel(entry.value, agent)");
  assert.ok(remember >= 0 && select > remember, "save the prior model's tweaks before switching");
  assert.ok(/effortLevelsForHarness\(option.harnessId\).some\([\s\S]*?\? entry.effort/.test(apply));
  assert.ok(
    /entry.fast && harnessSupportsFastMode\(option.harnessId\) && modelSupportsFastMode\(scopeKey\(\), option.model.id\)/.test(
      apply,
    ),
    "a stored Fast preference cannot enable an unsupported model",
  );
  assert.ok(apply.includes("persistPreference(EFFORT_STORAGE_KEY, composerState.effortLevel)"));
  assert.ok(apply.includes('persistPreference(FAST_MODE_STORAGE_KEY, composerState.fastMode ? "1" : "0")'));
  assert.ok(apply.includes("saveLoadout(loadout)"));
});

test("attaching files is allowed while a turn is streaming", () => {
  assert.match(composer, /const attachingDisabled = inputBlocked;/);
  assert.doesNotMatch(composer, /attachingDisabled = inputBlocked \|\| agent\.state\.isStreaming/);
  const guards = composer.match(/isStreaming/g) ?? [];
  const pickFiles = composer.slice(
    composer.indexOf("function pickFiles"),
    composer.indexOf("function removeAttachment"),
  );
  assert.doesNotMatch(pickFiles, /isStreaming/);
  const addFiles = composer.slice(
    composer.indexOf("async function addFiles"),
    composer.indexOf("function dragHasFiles"),
  );
  assert.doesNotMatch(addFiles, /isStreaming/);
  assert.ok(guards.length > 0, "streaming still gates steer/send routing");
});

test("a mid-turn submit queues — attachments cannot ride a queued message and stay for the next", () => {
  assert.match(composer, /\$\{tip\("Queue for after this turn"\)\}/);
  assert.doesNotMatch(composer, /attachments stay for your next message/);
});

test("a steer whose run already ended is recovered, never silently dropped", () => {
  assert.match(composer, /const outcome = await ctx\.chat\.signalLiveRun\("steer", queued\.text\);/);
  assert.match(composer, /if \(!outcome\.ok\) recoverEndedRunSteer\(agent, queued\.text, outcome\);/);
  assert.match(composer, /function recoverEndedRunSteer\(/);
  assert.match(composer, /attachWhenIdle\(agent, 0\);/);
  assert.match(composer, /resendWhenIdle\(agent, text, 0\);/);
  assert.match(composer, /if \(composerState\.draft === text\) void sendPrompt\(agent\);/);
});

test("scope runtime defaults include effort and fast mode", () => {
  assert.ok(/effortLevel: composerState\.effortLevel/.test(composer));
  assert.ok(/fastMode: fastOn/.test(composer));
  const restore = composer.slice(
    composer.indexOf("function applySelectedRuntime"),
    composer.indexOf("async function changeScopeRuntime"),
  );
  assert.ok(/saved\?\.effort \?\? \(config\.effective\.effortLevel/.test(restore));
  assert.ok(/\(saved\?\.fast \?\? config\.effective\.fastMode\) === true/.test(restore));
});
