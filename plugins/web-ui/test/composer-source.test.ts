import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("preset default actions live on the row while inheritance remains in the footer", () => {
  const row = composer.slice(composer.indexOf("function loadoutRow"), composer.indexOf("function cancelLoadoutClose"));
  const loadout = composer.slice(
    composer.indexOf("function loadoutControl"),
    composer.indexOf("function menuArrowKeys"),
  );
  assert.ok(row.includes('class="loadout-make-default"'));
  assert.ok(row.includes("effortLevel: settings.effort"));
  assert.ok(row.includes("fastMode: settings.fast"));
  assert.ok(!loadout.includes("Make default"));
  assert.ok(loadout.includes("changeScopeRuntime({ inherit: true }, agent)"));
});

test("compact and full composers share one left-side picker with Fast inside its menu", () => {
  assert.ok(
    /const runtimeControls = loadoutControl\(agent, selectedModel, inputBlocked\)/.test(composer),
    "compact surfaces must retain the full model and effort picker",
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
  assert.equal((composer.match(/@click=\$\{\(\) => toggleFastMode\(agent\)\}/g) ?? []).length, 1);
});

test("switching setups preserves prior tweaks and validates effort and Fast for the selected model", () => {
  const apply = composer.slice(
    composer.indexOf("function applyLoadout"),
    composer.indexOf("function composerShortcut"),
  );
  const remember = apply.indexOf("rememberActiveTweaks(previous)");
  const select = apply.indexOf("selectModel(entry.value, agent)");
  assert.ok(remember >= 0 && select > remember, "save the prior model's tweaks before switching");
  const normalize = composer.slice(
    composer.indexOf("function normalizeLoadoutEntry"),
    composer.indexOf("function seededLoadout"),
  );
  assert.ok(normalize.includes("effortLevelsForHarness(option.harnessId)"));
  assert.ok(/levels.some\([\s\S]*?\? entry.effort/.test(normalize));
  assert.ok(apply.includes("normalizeLoadoutEntry(entry, option)"));
  assert.ok(
    /entry.fast && harnessSupportsFastMode\(option.harnessId\) && modelSupportsFastMode\(scopeKey\(\), option.model.id\)/.test(
      normalize,
    ),
    "a stored Fast preference cannot enable an unsupported model",
  );
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
  assert.match(composer, /effortLevel: settings\.effort/);
  assert.match(composer, /fastMode: settings\.fast/);
  assert.match(composer, /getRuntimeConfig\(scopeKey\(\)\)\?\.effective\.effortLevel/);
  assert.match(composer, /getRuntimeConfig\(scopeKey\(\)\)\?\.effective\.fastMode === true/);
});
