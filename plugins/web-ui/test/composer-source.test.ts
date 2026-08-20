import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("scope-default buttons render when any runtime setting differs from the scope default", () => {
  assert.match(composer, /const runtimeToggled =\s*!runtimePending/);
  assert.match(composer, /composerState\.effortLevel !== effectiveEffort/);
  assert.match(composer, /fastOn !== effectiveFast/);
  assert.match(composer, /\$\{\s*runtimeToggled\s*\? html`[\s\S]{0,800}?>\s*Make default\s*<\/button>/);
  assert.match(composer, /\$\{\s*runtimeToggled && activeRuntimeConfig\?\.scopeOverride/);
});

test("composer-right keeps its control order: make default, use org default, model, harness, send", () => {
  const right = composer.slice(composer.indexOf('class="composer-right"'));
  const makeDefault = right.indexOf("Make default");
  const orgDefault = right.indexOf("Use org default");
  const model = right.indexOf('kind: "model"');
  const harness = right.indexOf('kind: "harness"');
  const send = right.indexOf("sendControls(agent)");
  for (const [name, at] of [
    ["Make default", makeDefault],
    ["Use org default", orgDefault],
    ["model picker", model],
    ["harness picker", harness],
    ["send controls", send],
  ] as const) {
    assert.ok(at >= 0, `${name} missing from composer-right`);
  }
  assert.ok(makeDefault < orgDefault, "Make default should precede Use org default");
  assert.ok(orgDefault < model, "Use org default should precede the model picker");
  assert.ok(model < harness, "the model picker should precede the harness picker");
  assert.ok(harness < send, "the harness picker should precede the send controls");
});

test("attaching files is allowed while a turn is streaming", () => {
  // The attach button and drop/paste paths must not gate on isStreaming —
  // only on runtime readiness and pending approvals.
  assert.match(composer, /const attachingDisabled = inputBlocked;/);
  assert.doesNotMatch(composer, /attachingDisabled = inputBlocked \|\| agent\.state\.isStreaming/);
  // pickFiles, addFiles, and the large-paste path no longer check isStreaming.
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
  // Mid-turn Enter queues through core (queueDraft), so the steer-button attachment note is gone;
  // the queue button gates only on draft text, never on the run slot.
  assert.match(composer, /title="Queue for after this turn"/);
  assert.doesNotMatch(composer, /attachments stay for your next message/);
});

test("a steer whose run already ended is recovered, never silently dropped", () => {
  // steerQueued must inspect the signal outcome and route a failed steer through recovery.
  assert.match(composer, /const outcome = await ctx\.chat\.signalLiveRun\("steer", queued\.text\);/);
  assert.match(composer, /if \(!outcome\.ok\) recoverEndedRunSteer\(agent, queued\.text, outcome\);/);
  // Replayed by core → detach from the stale stream and attach to the fresh run.
  assert.match(composer, /function recoverEndedRunSteer\(/);
  assert.match(composer, /attachWhenIdle\(agent, 0\);/);
  // Not stored anywhere → the text goes back through a normal send.
  assert.match(composer, /resendWhenIdle\(agent, text, 0\);/);
  assert.match(composer, /if \(composerState\.draft === text\) void sendPrompt\(agent\);/);
});

test("scope runtime defaults include effort and fast mode", () => {
  assert.match(composer, /effortLevel: composerState\.effortLevel/);
  assert.match(composer, /fastMode: fastOn/);
  assert.match(composer, /config\.effective\.effortLevel/);
  assert.match(composer, /config\.effective\.fastMode === true/);
});

test("long model menus stay searchable and show the selected effort", () => {
  assert.match(composer, /const MENU_SEARCH_THRESHOLD = 8;/);
  assert.match(composer, /searchable: true/);
  assert.match(composer, /placeholder="Search models…"/);
  assert.match(composer, /option\.groupLabel/);
  assert.match(composer, /suffix: `· \$\{effortLabel\(composerState\.effortLevel\)}`/);
});
