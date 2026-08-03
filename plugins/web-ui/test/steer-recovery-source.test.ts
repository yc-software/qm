import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
const conversations = readFileSync(new URL("../src/conversations.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("signalLiveRun reports a terminal/vanished run as an outcome instead of throwing", () => {
  assert.match(
    bridge,
    /export type SignalOutcome = \{ ok: true \} \| \{ ok: false; reason: string; replayed\?: boolean \};/,
  );
  assert.match(bridge, /err\.status === 409 \|\| err\.status === 404/);
  assert.match(bridge, /\.\.\.\(body\.replayed \? \{ replayed: true \} : \{\}\)/);
});

test("a server-side run starting for an open conversation attaches the view (working event, not just visibilitychange)", () => {
  assert.match(conversations, /if \(event\.state === "working"\) for \(const conv of live\) conv\.resumeIfIdle\(\);/);
});

test("resuming a tracked run pulls the transcript first so the triggering message is on screen", () => {
  const at = chat.indexOf("async function resumeTrackedRun");
  assert.ok(at >= 0);
  const body = chat.slice(at, chat.indexOf("agent.streamFn = makeRunResumeStreamFn", at));
  assert.match(body, /await refreshTranscriptFromEntries\(agent\);/);
});

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("a steer typed before the run slot goes live is held and delivered, never dropped", () => {
  const at = composer.indexOf("async function sendSteer");
  assert.ok(at >= 0);
  const body = composer.slice(at, composer.indexOf("async function deliverSteer", at));
  // the old guard silently returned when the slot had no run id yet
  assert.doesNotMatch(
    body,
    /if \(!text \|\| !ctx\.chat\.hasLiveRun\(\)\) return;/,
    "steer dropped in the submit window",
  );
  assert.match(body, /steerWhenLive\(agent, text, 0\);/);
});

test("steerWhenLive settles every way a run slot can: live steer, ended resend, timeout restore", () => {
  const at = composer.indexOf("function steerWhenLive");
  assert.ok(at >= 0);
  const body = composer.slice(at, composer.indexOf("// The run ended before the steer landed", at));
  assert.match(body, /void deliverSteer\(agent, text\);/);
  assert.match(body, /recoverEndedRunSteer\(agent, text, \{\}\);/);
  assert.match(body, /composerState\.draft = composerState\.draft\.trim\(\)/);
});
