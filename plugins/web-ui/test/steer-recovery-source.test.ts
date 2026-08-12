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

test("a message typed mid-turn is never dropped by the run-slot window — it queues through core", () => {
  // sendSteer's held-steer machinery (steerWhenLive/deliverSteer) is gone: mid-turn Enter now
  // queues via POST /api/turn regardless of run-slot state, so there is no submit window in
  // which a message can silently vanish. The queue path gates only on text and thread.
  const at = composer.indexOf("async function queueDraft");
  assert.ok(at >= 0);
  const body = composer.slice(at, composer.indexOf("async function enqueueTurn", at));
  assert.doesNotMatch(body, /hasLiveRun\(\)/, "queueing must not depend on the run slot");
  assert.match(body, /if \(!text \|\| !threadRef\) return;/);
  assert.match(
    body,
    /if \(!\(await enqueueTurn\(agent, threadRef, text\)\)\) composerState\.draft = text;/,
    "a queue core never took goes back in the composer",
  );
  assert.ok(composer.indexOf("function steerWhenLive") < 0, "the held-steer shim is gone with its window");
});

test("a queued steer the run outlived settles every way: replay followed, ended resend, requeue", () => {
  const at = composer.indexOf("async function steerQueued");
  assert.ok(at >= 0);
  const body = composer.slice(at, composer.indexOf("function recoverEndedRunSteer", at));
  assert.match(body, /if \(!outcome\.ok\) recoverEndedRunSteer\(agent, queued\.text, outcome\);/);
  assert.match(
    body,
    /if \(!\(await enqueueTurn\(agent, threadRef, queued\.text\)\)\) composerState\.draft = queued\.text;/,
    "a signal that never reached core re-queues the withdrawn text",
  );
});
