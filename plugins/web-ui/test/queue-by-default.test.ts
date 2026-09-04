import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { harnessSupportsSteer } from "../src/model-options.ts";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

test("a mid-turn Enter queues the message — it no longer steers the running turn", () => {
  assert.match(composer, /if \(agent\.state\.isStreaming\) return queueDraft\(agent\);/);
  assert.doesNotMatch(composer, /isStreaming\) return sendSteer\(/);
  assert.match(composer, /placeholder = "Queue a message for after this turn…"/);
  assert.match(composer, /title="Queue for after this turn"/);
});

// The whole point of the rewrite: the queue is core's, not the browser's. A queued message is a
// real run core will execute whether or not this tab survives, so there is nothing to flush, no
// per-tab store to keep in sync, and no way for two tabs to send the same message twice.
test("the queue lives in core, not in the browser", () => {
  assert.ok(!existsSync(new URL("../src/message-queue.ts", import.meta.url)), "the localStorage queue module is gone");
  for (const [name, src] of [
    ["composer", composer],
    ["chat", chat],
  ] as const) {
    assert.doesNotMatch(src, /"web-ui:queued"/, `${name} persists no queue of its own`);
    assert.doesNotMatch(src, /flushQueuedMessages/, `${name} has no flush path left`);
  }
  assert.match(
    composer,
    /const queuedRuns = new Map<string, QueuedRun\[\]>\(\);/,
    "what the composer holds is a view of core's queue, rebuilt from core — not a store",
  );
  assert.match(composer, /const queued = await queueTurn\(threadRef, text, agent, ctx\.chat\.currentTurnOptions\);/);
  assert.match(
    bridge,
    /export async function queueTurn\([\s\S]{0,600}?api<\{ runId\?: string \}>\("\/api\/turn"/,
    "queuing is an ordinary turn submission; core enqueues it behind the live run",
  );
});

test("a queued turn carries the same model, effort and scope a typed one would", () => {
  assert.match(bridge, /function turnRequestBody\(/);
  const body = bridge.slice(bridge.indexOf("function turnRequestBody"));
  assert.match(body, /thinkingLevel/);
  assert.match(body, /scopeId: turnOptions\.scopeId/);
  assert.match(bridge, /\.\.\.turnRequestBody\(threadRef, text, model, agent, getTurnOptions, attachments\),/);
  assert.match(bridge, /turnRequestBody\(threadRef, text, agent\.state\.model, agent, getTurnOptions\)/);
});

// Found in live QA: when the Steer control was swapped in and out of an existing strip, a tab that
// opened the conversation BEFORE its run attached (the queue draws first, the live run a moment
// later) ended up with a Steer button that received clicks but ran nothing. Whether the harness can
// steer is fixed for the conversation, so the button's presence must be too — only its enabled
// state may change.
test("the Steer control's presence is fixed for the conversation; only enablement changes", () => {
  const strip = composer.slice(
    composer.indexOf("function queuedStrip"),
    composer.indexOf("function composerApprovalPanel"),
  );
  assert.match(strip, /\?disabled=\$\{!steerable\}/, "an unusable Steer is disabled, never removed");
  assert.doesNotMatch(
    strip,
    /steerable\s*\?\s*html`<button/,
    "the button must not be conditionally inserted into a strip that is already on screen",
  );
});

test("steering is reachable only as an explicit act on a queued row", () => {
  const strip = composer.slice(
    composer.indexOf("function queuedStrip"),
    composer.indexOf("function composerApprovalPanel"),
  );
  assert.match(strip, /class="queued-steer"/);
  assert.match(strip, /steerQueued\(agent, q\)/);
  assert.match(strip, /class="chip-x"[\s\S]{0,240}removeQueued\(agent, q\)/);
  assert.match(
    composer,
    /const steerable =\s*agent\.state\.isStreaming && ctx\.chat\.hasLiveRun\(\) && harnessSupportsSteer\(currentModelOption\(\)\.harnessId\);/,
    "Steer acts only against a live run on a harness that can fold one in",
  );
});

// The one ordering that matters: withdraw is atomic, so putting it first means the message is
// either steered or run — never both, and never neither.
test("Steer withdraws the queued run before it signals, and only then shows the steered row", () => {
  const fn = composer.slice(
    composer.indexOf("async function steerQueued"),
    composer.indexOf("async function sendPrompt"),
  );
  const withdraw = fn.indexOf("await withdrawRun(queued.runId)");
  const signal = fn.indexOf('signalLiveRun("steer"');
  const push = fn.indexOf("agent.state.messages.push");
  assert.ok(withdraw > 0 && signal > withdraw, "the run is off the queue before its text is folded in");
  assert.ok(
    push > withdraw && signal > push,
    "the steered row shows before the signal so a run that ended first can recover it in place",
  );
  assert.match(
    fn,
    /if \(!outcome\.ok\) recoverEndedRunSteer\(agent, queued\.text, outcome\);/,
    "a steer the run outlived is recovered (replayed run followed, or resent as its own turn)",
  );
  assert.match(fn, /if \(!\(await withdrawRun\(queued\.runId\)\)\) return ctx\.chat\.drawActiveChat\(agent\);/);
  assert.match(
    fn,
    /err instanceof ApiError && err\.status === 409[\s\S]{0,240}?already started/,
    "losing to the claim is reported as running, not as a failure to steer",
  );
  assert.match(
    fn,
    /err instanceof ApiError && err\.status === 404[\s\S]{0,240}?already removed/,
    "a run another tab withdrew is reported gone",
  );
  assert.match(
    fn,
    /if \(started \|\| gone\) forgetQueuedRun\(threadRef, queued\.runId\);/,
    "both ways out of the queue clear the chip — no ghost row survives a lost race",
  );
  assert.match(
    fn,
    /catch \(err\) \{[\s\S]{0,600}?Could not steer the running task[\s\S]{0,600}?await enqueueTurn\(agent, threadRef, queued\.text\)/,
    "a steer that never reached core puts the message back on the queue as its own turn",
  );
});

test("× cancels the queued run in core, and treats a lost race as running rather than removed", () => {
  const fn = composer.slice(
    composer.indexOf("async function removeQueued"),
    composer.indexOf("async function steerQueued"),
  );
  assert.match(fn, /await withdrawRun\(queued\.runId\)/);
  assert.match(
    fn,
    /if \(!\(err instanceof ApiError && \(err\.status === 409 \|\| err\.status === 404\)\)\)/,
    "409 (claimed) and 404 (withdrawn elsewhere) both mean the run left the queue — the chip goes",
  );
  assert.match(bridge, /export async function withdrawRun\(runId: string\): Promise<boolean>/);
  assert.match(
    server,
    /path: "\/api\/runs\/:id\/withdraw"[\s\S]{0,320}?\/v1\/runs\/\$\{encodeURIComponent\(id\)\}\/withdraw/,
  );
});

// A queue outlives the run it was sent behind: when the head finishes between core's read and the
// surface's, the answer has no live run but the queue is still real. Reporting the followed run as
// queued, or dropping the queue with the run, both put the strip out of step with core.
test("a thread with no live run still reports its queue, and the followed run is never in it", () => {
  assert.match(server, /const waiting = queued\.filter\(\(q\) => q\.runId !== runId\);/);
  assert.match(bridge, /queued: QueuedRun\[\];/, "the queue is always present, not optional");
  assert.match(bridge, /return \{ \.\.\.live, queued: r\.queued \?\? \[\] \};/);
  assert.match(
    bridge,
    /export async function activeRunForThread\(threadRef: string\): Promise<ActiveRun>/,
    "the call no longer answers null, which used to take the queue down with it",
  );
});

test("the strip renders core's queue, refreshed from the same read that names the live run", () => {
  assert.match(composer, /function queuedStrip[\s\S]{0,140}?queuedRunsFor\(ctx\.chat\.state\.threadRef\)/);
  assert.match(chat, /setQueuedRuns\(threadRef, activeRun\.queued\)/);
  assert.match(bridge, /queued\?: QueuedRun\[\]/);
  assert.match(server, /json\(res, 200, \{ runId, run, \.\.\.\(waiting\.length \? \{ queued: waiting \} : \{\}\) \}\)/);
});

// Nothing is sent when a turn settles: core already started the next queued run. The client's only
// job is to show it, so a client that never comes back costs the person nothing but the view.
test("settling a turn follows the next queued run instead of sending it", () => {
  assert.match(chat, /void followNextQueuedRun\(agent, threadRef, normalStreamFn, onWork\);/);
  const fn = chat.slice(
    chat.indexOf("async function followNextQueuedRun"),
    chat.indexOf("async function resumeTrackedRun"),
  );
  assert.match(fn, /makeRunResumeStreamFn\(active\.runId, active\.run, onWork, runSlot\)/, "it attaches to core's run");
  assert.doesNotMatch(fn, /queueTurn/, "it never submits anything");
  assert.match(
    fn,
    /await \(recorded \? agent\.continue\(\) : agent\.prompt\(next!\.text\)\)/,
    "an already-recorded turn is resumed, never prompted a second time onto the screen",
  );
  assert.match(fn, /await refreshTranscriptFromEntries\(agent\)/);
  // A second tab watching the same conversation never saw the send, so only core can say what is
  // still queued — trusting this tab's list left it drawing a turn a worker had already claimed.
  assert.match(fn, /active = await activeRunForThread\(threadRef\)/, "the queue is re-read from core on settle");
  assert.match(fn, /setQueuedRuns\(threadRef, active\.queued\)/, "core's answer replaces the list");
  assert.match(
    fn,
    /const next = ctx\.composer\.queuedRunsFor\(threadRef\)\.find\(\(r\) => r\.runId === active\.runId\)/,
    "it renders the live run as ours only when it is one this tab queued",
  );
  // A tab that was already open when ANOTHER tab queued work has an empty local list. Bailing on
  // that emptiness meant it never asked core, so it sat idle through a run core had already
  // started — the exact staleness re-reading core exists to cure.
  assert.doesNotMatch(fn, /queuedRunsFor\(threadRef\)\.length\) return;/, "emptiness must not skip the re-read");
  assert.match(
    fn,
    /const recorded = \(agent\.state\.messages\.at\(-1\) as \{ role\?: string \} \| undefined\)\?\.role === "user";/,
    "a trailing user entry is how a tab recognises a queued turn it never sent",
  );
});

// A spine-routed turn's `text` is a <wake> envelope; the person's words are in displayText. A
// surface that renders `text` shows the envelope, and Steer would fold the envelope into the live
// turn in place of the message.
test("the queue exposes what the person typed, never the wake envelope that wraps it", () => {
  const appTurn = readFileSync(new URL("../../../src/api/app-turn.ts", import.meta.url), "utf8");
  const fn = appTurn.slice(appTurn.indexOf("async activeRunForThread"), appTurn.indexOf("async withdrawRun"));
  assert.match(fn, /text: run\.request\.displayText \?\? run\.request\.text \?\? ""/);
});

// The Steer button is only honest if the harness running the conversation can actually fold a
// mid-turn message in. Core declares that per adapter; this keeps the client's copy from drifting.
test("every harness core says can steer is one the web UI offers Steer for", () => {
  const dir = new URL("../../../src/harness/", import.meta.url);
  const declared = new Map<string, boolean>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith("-harness.ts")) continue;
    const src = readFileSync(new URL(file, dir), "utf8");
    const id = /defineHarness\(\s*\{\s*id:\s*"([^"]+)"/.exec(src)?.[1] ?? file.replace("-harness.ts", "");
    const caps = /capabilities: new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? "";
    declared.set(id, caps.includes('"steer"'));
  }
  assert.ok(declared.size >= 4, `expected to find the harness adapters, saw ${[...declared.keys()].join(", ")}`);
  for (const [id, canSteer] of declared) {
    assert.equal(harnessSupportsSteer(id), canSteer, `harnessSupportsSteer("${id}") disagrees with core`);
  }
});
