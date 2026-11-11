import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { jsonbStringify } from "../src/util/text.ts";
import type { TurnRequest } from "../src/types.ts";
import type { ModelAccount } from "../src/resolution/config-store.ts";
import { testConfig } from "./support/test-config.ts";
import type { SecurityScreener } from "../src/security/security-screener.ts";

function freshApp(securityScreener?: SecurityScreener) {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-wake-"));
  return buildApp(testConfig({ dataDir }), securityScreener ? { securityScreener } : {});
}

const actor = { externalId: "U1" };
function mention(text: string, channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    deliveryTarget: `slack:${channel}:${root}`,
    text,
    origin: { kind: "human" },
    async: true,
  };
}

function overheard(text: string, channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U2" },
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    deliveryTarget: `slack:${channel}:${root}`,
    text,
    origin: { kind: "ambient", live: true },
    async: true,
  };
}

function dm(text: string, channel: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "dm", threadRef: `dm:${channel}`, audience: [actor] },
    deliveryTarget: `slack:${channel}`,
    text,
    origin: { kind: "human" },
    async: true,
  };
}

function web(text: string, threadRef: string, midTurn: "steer" | "queue" = "queue"): TurnRequest {
  return {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef, audience: [actor] },
    text,
    origin: { kind: "human" },
    async: true,
    midTurn,
  };
}

test("spine ON: a mid-turn DM message STEERS the live run instead of forking a second reply", async () => {
  const built = freshApp();
  const channel = "D1";
  const first = await built.app.turn(dm("why did you choose this for me", channel));
  const liveRunId = first.runId!;

  const second = await built.app.turn(dm("@bot why did you choose this", channel));
  assert.equal(second.runId, liveRunId, "the second DM message attached to the LIVE run, not a new turn");
  assert.equal(second.steered, true, "a joined run is flagged steered so the surface stands down");

  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "@bot why did you choose this");

  const runs = await built.runs.list();
  assert.equal(runs.filter((r) => r.sessionId === `dm:${channel}`).length, 1, "no second run enqueued for the DM");
});

test("a mid-turn message from a DIFFERENT person carries its author and is durably recorded", async () => {
  const built = freshApp();
  const channel = "C_FOREIGN";
  const root = "100.9";
  const first = await built.app.turn(mention("@bot file the ticket", channel, root));
  const liveRunId = first.runId!;

  const second = await built.app.turn({
    ...mention("you can use my linear key", channel, root),
    actor: { externalId: "U_PAUL", displayName: "Paul" },
  });
  assert.equal(second.runId, liveRunId);
  assert.equal(second.steered, true);

  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals[0]!.text, "you can use my linear key");
  assert.equal(signals[0]!.request?.actor.displayName, "Paul", "the turn's intake names the author from the request");
  assert.deepEqual(
    await built.signals.steerAuthors(liveRunId),
    ["U_PAUL"],
    "the steer author is durably recorded so keychain onBehalfOf can verify them",
  );

  const third = await built.app.turn(mention("also add a screenshot", channel, root));
  assert.equal(third.steered, true);
  assert.equal((await built.signals.takePending(liveRunId))[0]!.text, "also add a screenshot");
});

test("spine ON: a mid-turn message STEERS the live run instead of forking a second turn", async () => {
  const built = freshApp();
  const channel = "C1";
  const root = "100.1";
  const first = await built.app.turn(mention("@bot start the task", channel, root));
  assert.equal(first.status, "queued");
  const liveRunId = first.runId!;

  const second = await built.app.turn(mention("actually make it blue", channel, root));
  assert.equal(second.status, "queued");
  assert.equal(second.runId, liveRunId, "the second message attached to the LIVE run, not a new turn");
  assert.equal(second.steered, true, "a joined run is flagged steered so the surface stands down");

  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "actually make it blue");

  const runs = await built.runs.list();
  assert.equal(runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length, 1, "no second run was enqueued");
});

test("spine ON: an empty mid-turn message is refused out loud — no second turn, no signal", async () => {
  const built = freshApp();
  const channel = "C5";
  const root = "500.5";
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  const empty = await built.app.turn(mention("   ", channel, root));
  assert.deepEqual(empty, { status: "refused", reason: "empty message" });
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "an empty message sends no signal");
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length,
    1,
    "no second run enqueued for an empty message",
  );
});

test("spine ON: a bare 'stop' mid-turn routes through the ABORT interrupt (not a steer)", async () => {
  const built = freshApp();
  const channel = "C2";
  const root = "200.2";
  const first = await built.app.turn(mention("@bot do a long thing", channel, root));
  const liveRunId = first.runId!;
  assert.ok(await built.runs.claimById(liveRunId, "worker", 30_000));

  const stop = await built.app.turn(mention("stop", channel, root));
  assert.equal(stop.stopped, true, "the stop stopped the live run");
  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "abort", "a bare stop aborts the live run");
});

test("spine ON: an OVERHEARD thread-follow (unprompted, not addressed) STEERS the live run", async () => {
  const built = freshApp();
  const channel = "C6";
  const root = "600.6";
  const first = await built.app.turn(mention("@bot make custom emoji for :gruel:", channel, root));
  const liveRunId = first.runId!;

  const follow = await built.app.turn(overheard("and :caviar:", channel, root));
  assert.equal(follow.runId, liveRunId, "the overheard follow attached to the LIVE run, not a new turn");

  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "and :caviar:");
  assert.equal(signals[0]!.request?.actor.externalId, "U2", "the turn's intake labels the author from the request");
  assert.deepEqual(
    await built.signals.steerAuthors(liveRunId),
    ["U2"],
    "a live thread reply is a person speaking, mention or not",
  );

  const runs = await built.runs.list();
  assert.equal(runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length, 1, "no second run enqueued");
});

test("spine ON: the steer signal carries the message's real surface ts (so the agent can persist + dedupe it)", async () => {
  const built = freshApp();
  const channel = "C8";
  const root = "800.8";
  const first = await built.app.turn(mention("@bot start", channel, root));
  const liveRunId = first.runId!;

  await built.app.turn({ ...mention("make it blue", channel, root), origin: { kind: "human", messageTs: "800.010" } });
  await built.app.turn({
    ...overheard("and rounded", channel, root),
    origin: { kind: "ambient", live: true, entryTs: "800.011" },
  });

  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 2);
  assert.equal(signals[0]!.ts, "800.010", "addressed steer forwards triggerTs as the persist/dedupe key");
  assert.equal(signals[1]!.ts, "800.011", "unprompted steer forwards entryTs as the persist/dedupe key");
});

test("an un-mentioned bare 'stop' from the person who started the run stops it", async () => {
  const built = freshApp();
  const channel = "C18";
  const root = "1800.8";
  const first = await built.app.turn(mention("@bot do a long thing", channel, root));
  const liveRunId = first.runId!;
  assert.ok(await built.runs.claimById(liveRunId, "worker", 30_000));

  const stop = await built.app.turn({ ...overheard("stop", channel, root), actor });
  assert.equal(stop.stopped, true, "the starter's stop stopped the live run");
  const signals = await built.signals.takePending(liveRunId);
  assert.deepEqual(
    signals.map((signal) => signal.kind),
    ["abort"],
  );
});

test("spine ON: an overheard bare 'stop' folds in as steer text (a bystander does NOT abort)", async () => {
  const built = freshApp();
  const channel = "C7";
  const root = "700.7";
  const first = await built.app.turn(mention("@bot do a long thing", channel, root));
  const liveRunId = first.runId!;

  const stop = await built.app.turn(overheard("stop", channel, root));
  assert.equal(stop.runId, liveRunId);
  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer", "an overheard stop steers, it does not abort");
});

test("an ADDRESSED mention never steers into a live UNPROMPTED run — it enqueues its own turn", async () => {
  const built = freshApp();
  const channel = "C9";
  const root = "900.9";
  const first = await built.app.turn(overheard("hm, interesting", channel, root));
  const liveRunId = first.runId!;

  const second = await built.app.turn(mention("@bot why did you do it wrong?", channel, root));
  assert.notEqual(second.runId, liveRunId, "the mention got its own run, not a steer into the detection turn");
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "no signal was sent to the detection-gated run");
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length,
    2,
    "the mention enqueued behind the live run",
  );
});

test("an overheard follow still steers a live UNPROMPTED run (a stranded one re-imports from the mirror)", async () => {
  const built = freshApp();
  const channel = "C10";
  const root = "1000.1";
  const first = await built.app.turn(overheard("hm, interesting", channel, root));
  const liveRunId = first.runId!;

  const follow = await built.app.turn(overheard("and another thing", channel, root));
  assert.equal(follow.runId, liveRunId);
  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
});

test("an addressed bare 'stop' still ABORTS a live UNPROMPTED run", async () => {
  const built = freshApp();
  const channel = "C11";
  const root = "1100.1";
  const first = await built.app.turn(overheard("hm, interesting", channel, root));
  const liveRunId = first.runId!;
  assert.ok(await built.runs.claimById(liveRunId, "worker", 30_000));

  const stop = await built.app.turn(mention("stop", channel, root));
  assert.equal(stop.stopped, true, "the stop stopped the live run");
  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "abort");
});

function automationRun(channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U-owner" },
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [] },
    deliveryTarget: `slack:${channel}:${root}`,
    text: "check the deploy and report back",
    origin: { kind: "automation" },
    async: true,
  };
}

test("a person's reply never steers into a live AUTOMATION run — it enqueues behind it with its own claims", async () => {
  const built = freshApp();
  const channel = "C12";
  const root = "1200.1";
  const first = await built.app.turn(automationRun(channel, root));
  const liveRunId = first.runId!;

  const second = await built.app.turn(mention("@bot also update the shared skill", channel, root));
  assert.notEqual(second.runId, liveRunId, "the person's message got its own run, not a steer into the cron's");
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "no signal was sent to the automation run");
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length,
    2,
    "the reply enqueued behind the live automation run",
  );
});

test("a Slack bot's mid-turn message never steers into or stops a person's live run — it enqueues its own bot turn", async () => {
  const built = freshApp();
  const channel = "C_BOT";
  const root = "1250.1";
  const first = await built.app.turn(mention("@bot file the ticket", channel, root));
  const liveRunId = first.runId!;
  assert.ok(await built.runs.claimById(liveRunId, "worker", 30_000));

  const fromBot = await built.app.turn({
    ...mention("@bot switch to the priciest model", channel, root),
    actor: { externalId: "B1", displayName: "Release bot" },
    botActor: true,
  });
  assert.notEqual(fromBot.runId, liveRunId, "the bot's message got its own run, not a steer into the person's");
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "no signal was sent to the person's run");
  assert.equal((await built.runs.get(fromBot.runId!))?.request.botActor, true);
  const botStop = await built.app.turn({
    ...mention("stop", channel, root),
    actor: { externalId: "B1", displayName: "Release bot" },
    botActor: true,
  });
  assert.deepEqual(
    {
      stopped: botStop.stopped ?? false,
      signals: (await built.signals.takePending(liveRunId)).map((signal) => signal.kind),
      status: (await built.runs.get(liveRunId))?.status,
    },
    { stopped: false, signals: [], status: "running" },
  );
});

test("a Slack bot's stop on its own live run leaves a person's queued turn and subagents running", async () => {
  const built = freshApp();
  const channel = "C_BOT_STOP";
  const root = "1260.1";
  const threadRef = `ch:${channel}:${root}`;
  const bot = { externalId: "B1", displayName: "Release bot" };
  const person = { id: "U1", type: "internal" as const };
  const fromBot = await built.app.turn({
    ...mention("@bot cut the release", channel, root),
    actor: bot,
    botActor: true,
  });
  assert.ok(await built.runs.claimById(fromBot.runId!, "worker", 30_000));
  const session = await built.sessions.getOrCreateByThread(threadRef, "channel", "personal:U1");
  const personRequest = (sessionThread: string, text: string) => ({
    actor: person,
    conversation: { kind: "channel" as const, threadRef: sessionThread, channelRef: channel, audience: [person] },
    text,
    origin: { kind: "human" as const },
  });
  const queued = await built.app.turn(mention("@bot and then the notes", channel, root));
  const child = await built.sessions.getOrCreateByThread(
    "agent:main:subagent:person-child",
    "channel",
    session.scopeId,
  );
  await built.sessions.setParentSession(child.id, session.id);
  const { run: childRun } = await built.runs.enqueue({
    sessionId: child.threadRef,
    request: personRequest(child.threadRef, "background work"),
  });
  assert.ok(await built.runs.claimById(childRun.id, "worker", 30_000));

  const stop = await built.app.turn({ ...mention("stop", channel, root), actor: bot, botActor: true });
  assert.deepEqual(
    {
      stopped: stop.stopped ?? false,
      bot: (await built.signals.takePending(fromBot.runId!)).map((signal) => signal.kind),
      queued: (await built.runs.get(queued.runId!))?.status,
      child: (await built.signals.takePending(childRun.id)).map((signal) => signal.kind),
    },
    { stopped: true, bot: ["abort"], queued: "pending", child: [] },
  );
});

test("a person's verbatim thread-follow (authored detection) also enqueues behind a live AUTOMATION run", async () => {
  const built = freshApp();
  const channel = "C13";
  const root = "1300.1";
  const first = await built.app.turn(automationRun(channel, root));
  const liveRunId = first.runId!;

  const follow = await built.app.turn(overheard("actually, please change the plan", channel, root));
  assert.notEqual(follow.runId, liveRunId, "the authored follow got its own run");
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "no signal was sent to the automation run");
});

test("an addressed bare 'stop' still ABORTS a live AUTOMATION run", async () => {
  const built = freshApp();
  const channel = "C14";
  const root = "1400.1";
  const first = await built.app.turn(automationRun(channel, root));
  const liveRunId = first.runId!;
  assert.ok(await built.runs.claimById(liveRunId, "worker", 30_000));

  const stop = await built.app.turn(mention("stop", channel, root));
  assert.equal(stop.stopped, true, "the stop stopped the live automation run");
  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "abort");
});

test("a SYNTHETIC detection (no live author) still steers a live AUTOMATION run — screened, no authority", async () => {
  const built = freshApp();
  const channel = "C15";
  const root = "1500.1";
  const first = await built.app.turn(automationRun(channel, root));
  const liveRunId = first.runId!;

  const synthetic: TurnRequest = {
    surface: "slack",
    actor: { externalId: "U2" },
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    deliveryTarget: `slack:${channel}:${root}`,
    text: "bot posted: build finished",
    origin: { kind: "ambient" },
    async: true,
  };
  const follow = await built.app.turn(synthetic);
  assert.equal(follow.runId, liveRunId, "the synthetic detection folded into the live run as context");
  const signals = await built.signals.takePending(liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
});

function spawnedWorker(channel: string, askTs: string): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "jordan@acme.test", displayName: "Jordan" },
    conversation: { kind: "channel", threadRef: `slack:${channel}:ambient:${askTs}`, channelRef: channel },
    deliveryTarget: channel,
    text: "can you check the deploy?",
    origin: { kind: "human", messageTs: askTs },
    surfaceTools: true,
    async: true,
    spawned: true,
    idempotencyKey: `ambient:acme:slack:${channel}:${askTs}`,
  };
}

test("a keyed mid-turn message steers like an unkeyed one, and a resend of it returns the run it steered", async () => {
  const built = freshApp();
  const first = await built.app.turn(mention("@bot start", "C14", "1400.1"));
  const keyed = { ...mention("make it green", "C14", "1400.1"), idempotencyKey: "slack:evt:1400" };
  const steered = await built.app.turn(keyed);
  assert.equal(steered.runId, first.runId, "the keyed live turn folded into the live run");
  const resent = await built.app.turn(keyed);
  assert.equal(resent.runId, first.runId);
  const signals = await built.signals.takePending(first.runId!);
  assert.deepEqual(
    signals.map((signal) => [signal.kind, signal.text]),
    [["steer", "make it green"]],
  );
  assert.equal((await built.runs.list()).filter((r) => r.sessionId === "ch:C14:1400.1").length, 1);
});

test("a keyed send that already queued as its own turn stays that turn when retried as a steer", async () => {
  const built = freshApp();
  const threadRef = "web:U1:keyed-retry";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  assert.ok(await built.runs.claimById(first.runId!, "worker", 30_000));
  const send = { ...web("and the timeline", threadRef), idempotencyKey: "web:U1:send-7" };
  const queued = await built.app.turn({ ...send, midTurn: "queue" });
  assert.notEqual(queued.runId, first.runId);
  const retried = await built.app.turn({ ...send, midTurn: "steer" });
  assert.equal(retried.runId, queued.runId, "the retry returns the queued turn");
  assert.deepEqual(await built.signals.takePending(first.runId!), [], "and never steers a second copy");
});

test("a Slack message that names the agent before a bare stop stops the live run", async () => {
  const built = freshApp();
  const first = await built.app.turn(mention("@bot do a long thing", "C-HALT", "300.3"));
  assert.ok(await built.runs.claimById(first.runId!, "worker", 30_000));
  const stop = await built.app.turn({
    ...mention("@bot stop", "C-HALT", "300.3"),
    gatewayContext: { botHandle: "bot" },
  });
  assert.equal(stop.stopped, true);
  assert.deepEqual(
    (await built.signals.takePending(first.runId!)).map((signal) => signal.kind),
    ["abort"],
  );
});

test("a bare stop stops a conversation's subagents even when its own turn is idle", async () => {
  const built = freshApp();
  const root = await built.sessions.getOrCreateByThread("dm:D-TREE", "dm", "personal:U1");
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:tree-child", "dm", "personal:U1");
  await built.sessions.setParentSession(child.id, root.id);
  const { run: childRun } = await built.runs.enqueue({
    sessionId: child.threadRef,
    request: {
      actor: { id: "U1", type: "internal" },
      conversation: { kind: "dm", threadRef: child.threadRef, audience: [{ id: "U1", type: "internal" }] },
      text: "background work",
      origin: { kind: "direct" },
    },
  });
  assert.ok(await built.runs.claimById(childRun.id, "worker", 30_000));
  const stop = await built.app.turn(dm("stop", "D-TREE"));
  assert.equal(stop.stopped, true);
  assert.deepEqual(
    (await built.signals.takePending(childRun.id)).map((signal) => signal.kind),
    ["abort"],
  );
  assert.equal((await built.runs.list()).filter((r) => r.sessionId === "dm:D-TREE").length, 0, "no turn for the stop");
});

test("the starter's un-mentioned bare stop reaches a conversation's subagents when its own turn is idle", async () => {
  const built = freshApp();
  const channel = "C19";
  const rootTs = "1900.9";
  const threadRef = `ch:${channel}:${rootTs}`;
  const root = await built.sessions.getOrCreateByThread(threadRef, "channel", "personal:U1");
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:starter-child", "dm", "personal:U1");
  await built.sessions.setParentSession(child.id, root.id);
  const { run: childRun } = await built.runs.enqueue({
    sessionId: child.threadRef,
    request: {
      actor: { id: "U1", type: "internal" },
      conversation: { kind: "dm", threadRef: child.threadRef, audience: [{ id: "U1", type: "internal" }] },
      text: "background work",
      origin: { kind: "direct" },
    },
  });
  assert.ok(await built.runs.claimById(childRun.id, "worker", 30_000));

  const starter = await built.app.turn({ ...overheard("stop", channel, rootTs), actor });
  assert.equal(starter.stopped, true);
  assert.deepEqual(
    (await built.signals.takePending(childRun.id)).map((signal) => signal.kind),
    ["abort"],
  );
});

test("a same-key REDELIVERY of a live keyed turn never steers — it dedupes to the existing run", async () => {
  const built = freshApp();
  const channel = "C17";
  const root = "1700.1";
  const keyed = { ...mention("@bot start the task", channel, root), idempotencyKey: "slack:evt:1700" };
  const first = await built.app.turn(keyed);
  const liveRunId = first.runId!;

  const redelivered = await built.app.turn(keyed);
  assert.equal(redelivered.runId, liveRunId, "the redelivery deduped to the existing run");
  assert.equal(
    (await built.signals.takePending(liveRunId)).length,
    0,
    "no steer injected the redelivered text into the live run",
  );
  const runs = await built.runs.list();
  assert.equal(runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length, 1, "one run for the message");
});

test("an approval decision reusing the original send's key is never deduped against that turn", async () => {
  const built = freshApp();
  const keyed = { ...dm("run the risky thing", "D18"), idempotencyKey: "web:U1:gesture-18" };
  const first = await built.app.turn(keyed);
  const approved = await built.app.turn({
    ...keyed,
    approval: { requestId: "req-18", approved: true },
  });
  assert.notEqual(approved.runId, first.runId, "the approval enqueued its own run instead of replaying the old one");
  const replayed = await built.app.turn({
    ...keyed,
    approval: { requestId: "req-18", approved: true },
  });
  assert.equal(replayed.runId, approved.runId, "a redelivered copy of the same decision deduped to its run");
});

test("a spawned worker turn never steers — a duplicate spawn DEDUPES at enqueue", async () => {
  const built = freshApp();
  const channel = "C15";
  const askTs = "1500.1";
  const first = await built.app.turn(spawnedWorker(channel, askTs));
  const dup = await built.app.turn(spawnedWorker(channel, askTs));
  assert.equal(dup.runId, first.runId, "the duplicate spawn deduped to the same run");
  assert.equal(
    (await built.signals.takePending(first.runId!)).length,
    0,
    "no steer folded the duplicate's text into the live first run",
  );
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId === `slack:${channel}:ambient:${askTs}`).length,
    1,
    "one run for the batch",
  );
});

test("reverse race: an addressed mention steers into the live ambient run, not a second reply", async () => {
  const built = freshApp();
  const channel = "C16";
  const askTs = "1600.1";
  const ambientRef = `slack:${channel}:ambient:${askTs}`;
  await built.sessions.getOrCreateByThread(ambientRef, "channel", `channel:${channel}`);
  const ambient = await built.app.turn(spawnedWorker(channel, askTs));

  const second = await built.app.turn({
    ...mention("@bot are you on it?", channel, askTs),
    origin: { kind: "human", messageTs: askTs },
  });
  assert.equal(second.runId, ambient.runId, "the mention steered into the LIVE ambient run, not a second reply");
  assert.equal(second.steered, undefined, "the ambient reverse-race join keeps the addressed caller waiting");
  const signals = await built.signals.takePending(ambient.runId!);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "@bot are you on it?");
});

for (const personalSide of ["ambient", "mention"] as const) {
  test(`reverse race: ${personalSide} personal access cannot share the other run's company account`, async () => {
    const built = freshApp();
    const channel = `C-account-${personalSide}`;
    const askTs = "1600.2";
    const ambientRef = `slack:${channel}:ambient:${askTs}`;
    await built.config.setPersonalModelAuth(personalSide === "ambient" ? "jordan@acme.test" : "U1", true, "openai");
    await built.sessions.getOrCreateByThread(ambientRef, "channel", `channel:${channel}`);
    const ambient = await built.app.turn(spawnedWorker(channel, askTs));
    const second = await built.app.turn({
      ...mention("@bot continue", channel, askTs),
      origin: { kind: "human", messageTs: askTs },
    });
    assert.equal(second.status, "queued");
    assert.notEqual(second.runId, ambient.runId);
    assert.notEqual(second.steered, true);
    assert.deepEqual(await built.signals.takePending(ambient.runId!), []);
    assert.equal(
      (await built.runs.get(second.runId!))?.request.modelAccount,
      personalSide === "mention" ? "openai" : "company",
    );
  });
}

test("spine ON: the FIRST message (no live run) engages normally — no steer", async () => {
  const built = freshApp();
  const channel = "C4";
  const root = "400.4";
  const first = await built.app.turn(mention("@bot hello", channel, root));
  assert.equal(first.status, "queued");
  assert.equal(first.steered, undefined, "an engaged run belongs to its caller — never flagged steered");
  const signals = await built.signals.takePending(first.runId!);
  assert.equal(signals.length, 0);
});

test("web's Queue preference forks a SECOND run mid-turn; its Steer preference folds into the live one", async () => {
  const built = freshApp();
  const threadRef = "web:U1:default";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  const queued = await built.app.turn(web("actually, just the timeline", threadRef));
  assert.notEqual(queued.runId, first.runId!);
  assert.equal((await built.signals.takePending(first.runId!)).length, 0);

  const steered = await built.app.turn(web("and keep it short", threadRef, "steer"));
  assert.equal(steered.runId, first.runId);
  assert.equal(steered.steered, true);
  const [signal] = await built.signals.takePending(first.runId!);
  assert.equal(signal?.text, "and keep it short");
  assert.equal(signal?.ts, steered.steerTs, "the caller learns the steer's ts to match its intake");
  assert.equal((await built.runs.list()).filter((r) => r.sessionId === threadRef).length, 2);
});

test("a bare stop typed on web stops the live run, whatever the Queue preference", async () => {
  const built = freshApp();
  const threadRef = "web:U1:stop";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  assert.ok(await built.runs.claimById(first.runId!, "worker", 30_000));
  const stop = await built.app.turn(web("stop", threadRef));
  assert.equal(stop.stopped, true);
  assert.deepEqual(
    (await built.signals.takePending(first.runId!)).map((signal) => signal.kind),
    ["abort"],
  );
  assert.equal(
    (await built.runs.list()).filter((r) => r.sessionId === threadRef && r.request.text === "stop").length,
    0,
  );
});

test("web's queued second run waits for the lock: not claimable until the live run finishes", async () => {
  const built = freshApp();
  const threadRef = "web:U1:queued";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  const second = await built.app.turn(web("actually, just the timeline", threadRef));
  const queued = [first.runId!, second.runId!];
  assert.equal(
    (await built.runs.list()).filter((r) => r.sessionId === threadRef).length,
    2,
    "both runs are on the queue before any is claimed",
  );

  const live = (await built.runs.claim("w1", 30_000))[0] ?? null;
  assert.ok(live && queued.includes(live.id), "one of the two queued runs is claimed");
  assert.equal(
    (await built.runs.claim("w2", 30_000))[0] ?? null,
    null,
    "the other must NOT be claimable while it runs",
  );

  await built.runs.complete(live!.id, live!.leaseToken!, { status: "ok", reply: "done" });
  const next = (await built.runs.claim("w3", 30_000))[0] ?? null;
  assert.equal(
    next?.id,
    queued.find((id) => id !== live!.id),
    "the waiting run is claimed once the lock frees",
  );
});

test("web's queue is durable and readable: core names the live run, then what waits behind it", async () => {
  const built = freshApp();
  const threadRef = "web:U1:visible";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  await built.runs.claimById(first.runId!, "w1", 30_000);
  const second = await built.app.turn(web("then the timeline", threadRef));
  const third = await built.app.turn(web("and who was paged", threadRef));

  const active = await built.app.activeRunForThread(threadRef);
  assert.equal(active?.runId, first.runId, "the live run is the head, not the newest message");
  assert.deepEqual(
    active?.queued,
    [
      { runId: second.runId!, text: "then the timeline" },
      { runId: third.runId!, text: "and who was paged" },
    ],
    "the queue comes back in send order, with the text — enough for any surface to render it",
  );

  assert.deepEqual(await built.app.withdrawRun(second.runId!), { withdrawn: true });
  assert.deepEqual(
    (await built.app.activeRunForThread(threadRef))?.queued,
    [{ runId: third.runId!, text: "and who was paged" }],
    "the withdrawn turn is off the queue and will never run",
  );
  assert.deepEqual(
    await built.app.withdrawRun(first.runId!),
    { withdrawn: false, reason: "started" },
    "the running turn is not withdrawable — it can only be steered or stopped",
  );
  assert.deepEqual(await built.app.withdrawRun("no-such-run"), { withdrawn: false, reason: "not_found" });
});

test("an automation wake queued behind a live turn stays out of the composer queue", async () => {
  const built = freshApp();
  const threadRef = "web:U1:wake";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  await built.runs.claimById(first.runId!, "w1", 30_000);
  const wake = await built.app.turn({
    surface: "monitor",
    actor,
    conversation: { kind: "dm", threadRef, audience: [actor] },
    text: '<wake reason="monitor" surface="monitor" process-id="p1" at="2026-09-02T00:00:00.000Z">…</wake>',
    origin: { kind: "automation" },
    async: true,
  });
  const typed = await built.app.turn(web("and who was paged", threadRef));

  assert.notEqual(wake.runId, first.runId, "the wake is its own run, waiting behind the live turn");
  assert.deepEqual(
    (await built.app.activeRunForThread(threadRef))?.queued,
    [{ runId: typed.runId!, text: "and who was paged" }],
    "only what a person typed is offered back to them as a steerable, withdrawable queued message",
  );
});

test("a queued web turn runs on its own — the sender's client need never come back", async () => {
  const built = freshApp();
  const threadRef = "web:U1:unattended";
  const first = await built.app.turn(web("the long one", threadRef));
  const live = await built.runs.claimById(first.runId!, "w1", 30_000);
  const queued = await built.app.turn(web("the queued one", threadRef));

  await built.runs.complete(live!.id, live!.leaseToken!, { status: "ok", reply: "done" });
  const next = (await built.runs.claim("w2", 30_000))[0] ?? null;
  assert.equal(next?.id, queued.runId, "the queued turn is claimed by a worker, with no client involved");
  assert.equal(next?.request.text, "the queued one");
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => Promise<T | undefined>, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}

test("orphan replay: a steer unconsumed at run completion replays as a fresh turn (prod 93a5c5ba)", async () => {
  const built = freshApp();
  const channel = "C9";
  const root = "900.9";
  const threadRef = `ch:${channel}:${root}`;
  const first = await built.app.turn(mention("@bot start the task", channel, root));
  const liveRunId = first.runId!;

  await built.app.turn({
    ...mention("@bot why did you do it wrong?", channel, root),
    origin: { kind: "human", messageTs: "900.010" },
  });
  const claimed = (await built.runs.claim("w1", 30_000))[0] ?? null;
  assert.equal(claimed?.id, liveRunId);
  await built.runs.complete(liveRunId, claimed!.leaseToken!, { status: "silent" });

  const replayed = await until(async () =>
    (await built.runs.list()).find((r) => r.sessionId === threadRef && r.id !== liveRunId),
  );
  assert.equal(replayed.status, "pending");
  const text = `${replayed.request.text ?? ""} ${replayed.request.displayText ?? ""}`;
  assert.ok(
    text.includes("why did you do it wrong?"),
    `the replayed turn carries the steered message (got: ${text.slice(0, 120)})`,
  );
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "the orphaned signal was consumed by the drain");
});

test("orphan replay: a stale abort is drained; a request-less steer replays on the run's own request", async () => {
  const built = freshApp();
  const channel = "C10";
  const root = "1000.1";
  const threadRef = `ch:${channel}:${root}`;
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  await built.signals.send(liveRunId, { kind: "abort" });
  await built.signals.send(liveRunId, { kind: "steer", text: "manual web steer" });

  await built.app.replayOrphanedRunSignals(liveRunId);
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "drained");
  const runs = (await built.runs.list()).filter((r) => r.sessionId === threadRef);
  assert.equal(runs.length, 2, "the abort is dropped; the steer text becomes a fresh turn, never lost");
  const fresh = runs.find((r) => r.id !== liveRunId);
  assert.equal(fresh?.request.text, "manual web steer");
});

test("signalRun: a web steer that races the run's end is replayed and reports the fresh run", async () => {
  const built = freshApp();
  const channel = "C14";
  const root = "1400.1";
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  completeOnSend(built);

  const raced = await built.app.signalRun(liveRunId, { kind: "steer", text: "did this make it?" });
  assert.equal(raced.accepted, false);
  assert.equal(raced.reason, "terminal");
  assert.equal(raced.replayed, true, "the caller is told the text now rides a fresh run");
  const fresh = await until(async () =>
    (await built.runs.list()).find((r) => r.sessionId === `ch:${channel}:${root}` && r.id !== liveRunId),
  );
  assert.equal(fresh.request.text, "did this make it?");
});

test("signalRun: a steer already terminal at send is refused up front", async () => {
  const built = freshApp();
  const channel = "C11";
  const root = "1100.1";
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  const claimed = (await built.runs.claim("w1", 30_000))[0] ?? null;
  await built.runs.complete(liveRunId, claimed!.leaseToken!, { status: "ok", reply: "done" });

  const refused = await built.app.signalRun(liveRunId, { kind: "steer", text: "too late" });
  assert.equal(refused.accepted, false);
  assert.equal(refused.reason, "terminal");
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "nothing left rotting in the queue");
});

function completeOnSend(built: ReturnType<typeof freshApp>, sanitize = false): void {
  const origSend = built.signals.send.bind(built.signals);
  built.signals.send = async (runId, signal) => {
    const sent = await origSend(runId, sanitize ? JSON.parse(jsonbStringify(signal)) : signal);
    const claimed = (await built.runs.claim("w1", 30_000))[0] ?? null;
    if (claimed) await built.runs.complete(claimed.id, claimed.leaseToken!, { status: "silent" });
    return sent;
  };
}

test("signalRun: a steer whose run goes terminal mid-send is REFUSED, never a false accept", async () => {
  const built = freshApp();
  const channel = "C12";
  const root = "1200.1";
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  completeOnSend(built);

  const raced = await built.app.signalRun(liveRunId, { kind: "steer", text: "did this make it?" });
  assert.equal(raced.accepted, false, "a signal that raced the run's completion must not report success");
  assert.equal(raced.reason, "terminal");
  assert.equal((await built.signals.takePending(liveRunId)).length, 0, "nothing left rotting in the queue");
});

for (const sanitize of [false, true])
  test(`steer path: a message whose run goes terminal mid-send returns the fresh run (sanitize=${sanitize})`, async () => {
    const built = freshApp();
    const channel = "C13";
    const root = "1300.1";
    const threadRef = `ch:${channel}:${root}`;
    const first = await built.app.turn(mention("@bot go", channel, root));
    const liveRunId = first.runId!;
    completeOnSend(built, sanitize);
    built.app.replayOrphanedRunSignals = async () => {};

    const second = await built.app.turn({
      ...mention("@bot and another thing\u0000\ud800", channel, root),
      origin: { kind: "human", messageTs: "1300.010" },
    });
    assert.equal(second.status, "queued");
    assert.notEqual(second.runId, liveRunId, "the caller follows the replayed run, not the dead one");
    const replayed = (await built.runs.list()).find((r) => r.id === second.runId);
    assert.equal(replayed?.sessionId, threadRef);
    const text = `${replayed?.request.text ?? ""} ${replayed?.request.displayText ?? ""}`;
    assert.ok(
      text.includes("and another thing"),
      `the fresh run carries the raced message (got: ${text.slice(0, 120)})`,
    );
    assert.equal(
      (await built.signals.takePending(liveRunId)).length,
      0,
      "the raced signal was consumed by the inline drain",
    );
  });

test("reverse race: a sanitized mention follows its fresh run after the ambient run ends", async () => {
  const built = freshApp();
  const channel = "C-ambient-unicode";
  const askTs = "1600.2";
  const ambientRef = `slack:${channel}:ambient:${askTs}`;
  await built.sessions.getOrCreateByThread(ambientRef, "channel", `channel:${channel}`);
  const ambient = await built.app.turn(spawnedWorker(channel, askTs));
  completeOnSend(built, true);
  built.app.replayOrphanedRunSignals = async () => {};
  const second = await built.app.turn({
    ...mention("@bot more\u0000 work\ud800", channel, askTs),
    origin: { kind: "human", messageTs: askTs },
  });
  assert.equal(second.status, "queued");
  assert.notEqual(second.runId, ambient.runId);
  const replayed = await built.runs.get(second.runId!);
  assert.ok(`${replayed?.request.text} ${replayed?.request.displayText}`.includes("@bot more work�"));
});

test("screening off delivers ambient updates to the existing run without a classifier", async () => {
  const built = buildApp(testConfig({ securityScreen: "off" }));
  const first = await built.app.turn(mention("start work", "C-off", "100.1"));
  const follow = await built.app.turn(overheard("build finished", "C-off", "100.1"));
  assert.equal(follow.runId, first.runId);
  const signals = await built.signals.takePending(first.runId!);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.match(signals[0]!.text ?? "", /build finished/);
  assert.equal(built.modelCalls.filter((rec) => rec.model === "mock-security").length, 0);
});

test("queued web edits require the author and preserve queue identity", async () => {
  const built = freshApp();
  const threadRef = "web:U1:edit";
  const first = await built.app.turn(web("first", threadRef));
  await built.runs.claimById(first.runId!, "worker", 30000);
  const second = await built.app.turn(web("second", threadRef));
  const owner = (await built.runs.get(second.runId!))!.request.actor.id;
  assert.deepEqual(await built.app.editQueuedRun(second.runId!, "edited", "second", "internal:other"), {
    edited: false,
    reason: "not_found",
  });
  assert.deepEqual(await built.app.editQueuedRun(second.runId!, "", "second", owner), {
    edited: false,
    reason: "empty_text",
  });
  assert.deepEqual(await built.app.editQueuedRun(second.runId!, "edited", "second", owner), { edited: true });
  assert.deepEqual((await built.app.activeRunForThread(threadRef, owner))?.queued, [
    { runId: second.runId, text: "edited" },
  ]);
  assert.deepEqual(await built.app.editQueuedRun(second.runId!, "stale", "second", owner), {
    edited: false,
    reason: "changed_or_started",
  });
  assert.deepEqual(await built.app.editQueuedRun(first.runId!, "late", "first", owner), {
    edited: false,
    reason: "changed_or_started",
  });
});

test("run snapshots expose authorized durable web input with safe attachment metadata", async () => {
  const built = freshApp();
  const turn = await built.app.turn({
    ...web("pending input", "web:U1:pending-input"),
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50, blobId: "private-blob" }],
  });
  const run = (await built.runs.get(turn.runId!))!;
  const snapshot = await built.app.getRun(run.id, run.request.actor.id);
  assert.deepEqual(snapshot?.input, {
    runId: run.id,
    seq: null,
    text: "pending input",
    createdAt: run.createdAt,
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50 }],
  });
  assert.equal(await built.app.getRun(run.id, "internal:other"), null);
  await built.runs.noteTurnUserSeq(run.id, 0);
  assert.equal((await built.app.getRun(run.id, run.request.actor.id))?.input?.seq, 0);
  const slack = await built.app.turn(dm("slack input", "D-no-web-input"));
  assert.equal((await built.app.getRun(slack.runId!))?.input, undefined);
  const replay = await built.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, approval: { requestId: "approval-replay", approved: true } },
  });
  assert.equal((await built.app.getRun(replay.run.id, run.request.actor.id))?.input, undefined);
  for (const text of ["", "   "]) {
    const opener = await built.runs.enqueue({
      sessionId: run.sessionId,
      request: { ...run.request, text, proactiveOpener: true },
    });
    assert.equal((await built.app.getRun(opener.run.id, run.request.actor.id))?.input, undefined);
  }
  const explicit = await built.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, proactiveOpener: true },
  });
  assert.equal((await built.app.getRun(explicit.run.id, run.request.actor.id))?.input?.text, "pending input");
});

test("an addressed stop withdraws queued work before a worker can claim it", async () => {
  const built = freshApp();
  const first = await built.app.turn(mention("start the task", "C_STOP_QUEUED", "100.1"));
  const stop = await built.app.turn(mention("stop", "C_STOP_QUEUED", "100.1"));
  assert.equal(stop.stopped, true);
  assert.equal(await built.runs.get(first.runId!), null);
  assert.equal(await built.runs.claimById(first.runId!, "worker", 30_000), null);
});

function automationWakeRun(
  built: ReturnType<typeof freshApp>,
  threadRef: string,
  modelAccount: ModelAccount = "company",
  botActor = false,
) {
  return built.runs.enqueue({
    sessionId: threadRef,
    request: {
      surface: "web",
      actor: { id: "U1", type: "internal" },
      conversation: { kind: "dm", threadRef, audience: [{ id: "U1", type: "internal" }] },
      text: "Another conversation handed you a task.",
      origin: { kind: "automation" },
      modelAccount,
      ...(botActor ? { botActor } : {}),
    },
  });
}

test("signalRun: a person's Steer on web reaches a live automation turn, such as another conversation's hand-off", async () => {
  const built = freshApp();
  const threadRef = "web:U1:peer-wake";
  const { run } = await automationWakeRun(built, threadRef);
  const steer = { kind: "steer" as const, text: "also check the logs", ts: "t-1", request: web("draft", threadRef) };
  const outcome = await built.app.signalRun(run.id, steer, "U1");
  assert.deepEqual(outcome, { accepted: true }, "steered into the live turn, not queued as its own");
  const signals = await built.signals.takePending(run.id);
  assert.deepEqual(
    signals.map((signal) => [signal.kind, signal.text]),
    [["steer", "also check the logs"]],
  );
  assert.equal((await built.runs.list()).filter((r) => r.sessionId === threadRef).length, 1);
});

test("web's Steer preference folds a typed message into a live automation turn; Queue still waits", async () => {
  const built = freshApp();
  const threadRef = "web:U1:peer-wake-typed";
  const { run } = await automationWakeRun(built, threadRef);
  const queued = await built.app.turn(web("after that, summarize", threadRef));
  assert.notEqual(queued.runId, run.id);
  const steered = await built.app.turn(web("and keep it short", threadRef, "steer"));
  assert.equal(steered.runId, run.id);
  assert.equal(steered.steered, true);
  assert.deepEqual(
    (await built.signals.takePending(run.id)).map((signal) => signal.text),
    ["and keep it short"],
  );
});

test("signalRun: a steer the live turn can't take runs as its own turn instead of vanishing", async () => {
  const built = freshApp();
  const threadRef = "web:U1:other-account";
  const { run } = await automationWakeRun(built, threadRef, "openai");
  const steer = { kind: "steer" as const, text: "also this", ts: "t-1", request: web("stale draft", threadRef) };
  const outcome = await built.app.signalRun(run.id, steer, "U1");
  assert.equal(outcome.accepted, true);
  assert.equal((await built.runs.get(outcome.queuedRunId!))?.request.text, "also this", "the routed text runs");
  assert.equal(
    (await built.app.signalRun(run.id, steer, "U1")).queuedRunId,
    outcome.queuedRunId,
    "a retry is one turn",
  );
  assert.deepEqual(await built.signals.takePending(run.id), []);
});

test("a person's Steer into a bot's hand-off stops the bot's turn and runs their message as their own turn", async () => {
  const built = freshApp();
  const { run } = await automationWakeRun(built, "web:U1:bot", "openai", true);
  assert.ok(await built.runs.claimById(run.id, "worker", 30_000));
  const typed = (await built.app.turn(web("set Beta as the default", "web:U1:bot", "steer"))).runId!;
  const steer = { kind: "steer" as const, queuedRunId: typed, request: web("", "web:U1:bot") };
  assert.deepEqual(await built.app.signalRun(run.id, steer, "U1"), { accepted: false, reason: "queued_started" });
  const direct = { kind: "steer" as const, text: "and the notes", request: web("and the notes", "web:U1:bot") };
  assert.ok(
    (await built.app.signalRun(run.id, direct, "U1")).queuedRunId,
    "a Steer from the canvas runs as their own turn",
  );
  assert.equal((await built.signals.takePending(run.id)).map((s) => s.kind).join(), "abort,abort,abort");
  assert.equal((await built.runs.get(typed))?.status, "pending", "the person's message is kept and runs next");
});

test("signalRun: sending a queued bare stop now stops the live run and spends the queued row", async () => {
  const built = freshApp();
  const threadRef = "web:U1:queued-stop";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  assert.ok(await built.runs.claimById(first.runId!, "worker", 30_000));
  const { run: queued } = await built.runs.enqueue({
    sessionId: threadRef,
    request: {
      actor: { id: "U1", type: "internal" },
      conversation: { kind: "dm", threadRef, audience: [{ id: "U1", type: "internal" }] },
      text: "stop",
      origin: { kind: "human" },
      modelAccount: "company",
    },
  });
  const outcome = await built.app.signalRun(
    first.runId!,
    { kind: "steer", queuedRunId: queued.id, request: web("stop", threadRef) },
    "U1",
  );
  assert.equal(outcome.accepted, true);
  assert.equal(await built.runs.get(queued.id), null);
  assert.deepEqual(
    (await built.signals.takePending(first.runId!)).map((signal) => signal.kind),
    ["abort"],
  );
});
