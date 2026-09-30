import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Built = ReturnType<typeof buildApp>;

function freshApp(): Built {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-spine-"));
  return buildApp(testConfig({ dataDir }));
}

async function withApp(fn: (built: Built) => Promise<void>, built: Built = freshApp()): Promise<void> {
  built.runtime.start();
  try {
    await fn(built);
  } finally {
    await built.runtime.stop();
  }
}

const actor = { externalId: "U1" };
function mention(text: string, channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    deliveryTarget: `slack:${channel}:${root}`,
    text,
    liveActor: true,
    async: true,
  };
}

function follow(text: string, channel: string, root: string, deliveryTarget = `slack:${channel}:${root}`): TurnRequest {
  const { liveActor: _liveActor, ...request } = mention(text, channel, root);
  return { ...request, deliveryTarget, unprompted: true };
}

function monitorTurn(text: string, channel: string, root: string): TurnRequest {
  const target = `slack:${channel}:${root}`;
  return {
    surface: "monitor",
    actor,
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    text,
    triggered: true,
    surfaceTools: true,
    addressed: true,
    triggerDestination: { type: "slack", target, audienceScopeId: scopeId("channel", channel) },
    async: true,
  };
}

const pending = async (built: Built): Promise<any[]> => (await built.deliveries.pending("slack")) as any[];

async function pollDeliveries(built: Built, deadlineMs = 5_000): Promise<any[]> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const all = await pending(built);
    if (all.length) return all;
    await sleep(50);
  }
  return [];
}

async function pollFor(built: Built, match: (d: any) => boolean, deadlineMs = 5_000): Promise<any> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const hit = (await pending(built)).find(match);
    if (hit) return hit;
    await sleep(50);
  }
  return undefined;
}

async function lastPrompt(built: Built, threadRef: string) {
  const session = await built.sessions.getByThread(threadRef);
  return (await built.sessions.listLlmRequests(session!.id)).at(-1)!.promptEnvelope as {
    messages?: Array<{ role?: string; content?: string }>;
    images?: Array<{ mimeType?: string; dataBase64?: string }>;
  };
}

async function firstUserText(built: Built, threadRef: string): Promise<string> {
  const sub = await built.sessions.getByThread(threadRef);
  const entries = await built.sessions.getEntries(sub!.id);
  return String((entries.find((e) => e.type === "user")?.payload as any)?.text ?? "");
}

const SHED = "worklog: did the thing but never posted";

test("spine ON: react/edit/delete route through the SAME reach chokepoint to the current conversation", () =>
  withApp(async (built) => {
    const channel = "C5";
    const target = `slack:${channel}:`;

    await built.app.turn(mention("!react 500.5 eyes", channel, "500.5"));
    const reactD = await pollFor(built, (d) => d.destination.react);
    assert.ok(reactD, "react enqueued a reaction delivery");
    assert.equal(reactD.text, "", "a reaction carries no composed text");
    assert.deepEqual(reactD.destination.react, { messageTs: "500.5", emoji: "eyes" });
    assert.equal(reactD.destination.target, `${target}500.5`, "reacted in the current conversation");

    await built.app.turn(mention("!edit 501.5 the corrected line", channel, "501.5"));
    const editD = await pollFor(built, (d) => d.destination.editRef);
    assert.ok(editD, "edit enqueued an editRef delivery");
    assert.equal(editD.destination.editRef, "501.5");
    assert.equal(editD.text, "the corrected line", "the edit carries the new text");

    await built.app.turn(mention("!delete 502.5", channel, "502.5"));
    const delD = await pollFor(built, (d) => d.destination.delete);
    assert.ok(delD, "delete enqueued a deletion delivery");
    assert.deepEqual(delD.destination.delete, { messageTs: "502.5" });
    assert.equal(delD.text, "", "a deletion carries no composed text");
  }));

test("spine ON: an @mention engages a sub-conversation session that posts inside a wake envelope", () =>
  withApp(async (built) => {
    const channel = "C1";
    const root = "100.1";
    const res = await built.app.turn(mention("!post hello team", channel, root));
    assert.equal(res.status, "queued", "the addressed turn is routed (queued as a sub-conversation run)");

    const all = await pollDeliveries(built);
    assert.equal(all.length, 1, "exactly one delivery — the post, not a double-post");
    assert.equal(all[0].text, "hello team");
    assert.equal(all[0].destination.target, `slack:${channel}:${root}`);
    const sub = await built.sessions.getByThread(`ch:${channel}:${root}`);
    assert.equal(all[0].provenance?.trigger, "conversation", "a live turn's post is marked conversation, not a wake");
    assert.equal(all[0].provenance?.sourceSessionId, sub!.id);
    assert.equal(all[0].provenance?.sourceThreadRef, `ch:${channel}:${root}`);

    assert.ok(sub, "the sub-conversation session is the surface's own threadRef");
    assert.equal(sub!.surface, "slack");
    assert.equal(
      await built.sessions.getByThread(`slack/${channel}`),
      null,
      "no per-container ambient session is created",
    );

    const subEntries = await built.sessions.getEntries(sub!.id);
    assert.ok(
      subEntries.some((e) => e.type === "assistant"),
      "the sub-conversation session did the work + reply",
    );
    const userText = await firstUserText(built, `ch:${channel}:${root}`);
    assert.match(userText, /^<wake reason="addressed"/, "the addressed turn opens with a wake envelope");
    assert.match(
      userText,
      /<addressed-messages[^>]*>[\s\S]*!post hello team[\s\S]*<\/addressed-messages>/,
      "the trigger rides the addressed block",
    );
  }));

test("spine ON: a re-delivered @mention (same idempotencyKey) spawns ONE sub-conversation run, not two", async () => {
  const built = freshApp();
  const channel = "C3";
  const root = "300.3";
  const key = "evt-abc";
  const first = await built.app.turn({ ...mention("!post once", channel, root), idempotencyKey: key });
  const second = await built.app.turn({ ...mention("!post once", channel, root), idempotencyKey: key });
  assert.equal(first.runId, second.runId, "the second delivery dedups to the same sub run");
  assert.equal(
    await built.sessions.getByThread(`slack/${channel}`),
    null,
    "no per-container ambient session is created",
  );
});

test("a replayed/resumed request carries surfaceTools through app.turn (approval-continuation path)", () =>
  withApp(async (built) => {
    const channel = "C4";
    const root = "400.4";
    await built.app.turn({ ...mention("!post resumed", channel, root), surfaceTools: true });
    const all = await pollDeliveries(built);
    assert.equal(all.length, 1, "the resumed turn replied via post");
    assert.equal(all[0].text, "resumed");
    assert.equal(all[0].destination.target, `slack:${channel}:${root}`);
  }));

test("response debt: a turn that DID post keeps its monologue shed (no double reply)", () =>
  withApp(async (built) => {
    await built.app.turn(mention("!post the actual reply", "C9", "900.1"));
    const d = await pollFor(built, (x) => x.text === "the actual reply");
    assert.ok(d, "the posted reply landed");
    await sleep(400);
    const extras = (await pending(built)).filter(
      (x) => x.destination.target?.includes("C9") && x.text !== "the actual reply",
    );
    assert.deepEqual(
      extras.map((x) => x.text),
      [],
      "no monologue rode out as a second delivery",
    );
  }));

test("a trigger turn (surfaceTools + triggerDestination, no deliveryTarget) posts to the trigger destination", () =>
  withApp(async (built) => {
    const target = "slack:C7:700.7";
    const res = await built.app.turn(monitorTurn("!post the build passed", "C7", "700.7"));
    assert.equal(res.status, "queued");
    const d = await pollFor(built, (x) => x.text === "the build passed");
    assert.ok(d, "the reply reached the surface via post");
    assert.equal(d.destination.target, target, "the post aimed at the trigger destination (the arming thread)");
    assert.equal(
      (await pending(built)).filter((x) => x.text === "the build passed").length,
      1,
      "exactly one delivery — no duplicate",
    );
  }));

test("a monitor (addressed poll fire) that finishes silently is NOT nudged into a forced reply", () =>
  withApp(async (built) => {
    await built.app.turn({ ...monitorTurn("!finish-silent", "C8", "800.8"), async: false });
    await sleep(300);
    assert.deepEqual(
      (await pending(built)).filter((x) => x.destination.target?.includes("C8")).map((x) => x.text),
      [],
      "silence is the poll success case — nothing is delivered",
    );
  }));

test("surfaceTools with NO resolvable destination falls back to the normal auto-reply (never silences into the void)", () =>
  withApp(async (built) => {
    const principal = { externalId: "U9" };
    const res = await built.app.turn({
      surface: "slack",
      actor: principal,
      conversation: { kind: "dm", threadRef: "dm:U9:x", audience: [principal] },
      text: "hello",
      liveActor: true,
      surfaceTools: true,
      async: false,
    });
    assert.equal(res.status, "ok");
    assert.match(res.reply ?? "", /You said/);
  }));

test("spine ON: an unprompted thread-follow routes to a sub-conversation with surface tools and raw text", () =>
  withApp(async (built) => {
    const channel = "C-follow";
    const root = "700.1";
    const res = await built.app.turn(follow("!post following up", channel, root));
    assert.equal(res.status, "queued");
    const posted = await pollFor(
      built,
      (d) => d.destination.target === `slack:${channel}:${root}` && d.text === "following up",
    );
    assert.ok(posted, "the thread-follow ran with surface tools and posted via the post tool");
    assert.equal(
      await built.sessions.getByThread(`slack/${channel}`),
      null,
      "no per-container ambient session is created",
    );
    assert.doesNotMatch(
      await firstUserText(built, `ch:${channel}:${root}`),
      /^<wake/,
      "a thread-follow keeps the raw-text path (wake envelope deferred to a follow-up)",
    );
  }));

test("addressed + no post → exactly one nudge → the agent posts on the continuation turn", () =>
  withApp(async (built) => {
    await built.app.turn(mention("!silent", "C-nudge", "700.1"));
    const posted = await pollFor(built, (d) => d.text === "nudged reply");
    assert.ok(posted, "the agent posted after the reply-or-decline nudge");
    await sleep(300);
    assert.equal(
      (await pending(built)).filter((d) => d.text === "nudged reply").length,
      1,
      "the nudge fires at most once",
    );
    const session = await built.sessions.getByThread("ch:C-nudge:700.1");
    const entries = await built.sessions.getEntries(session!.id);
    assert.equal(
      await built.sessions.tapeCoverage(session!.id),
      entries.at(-1)!.seq,
      "the watermark is a write-completeness claim: no append failed, so a nudged turn still advances it",
    );
  }));

test("addressed + no post but a final text reply → the reply is delivered directly, no nudge", () =>
  withApp(async (built) => {
    await built.app.turn(mention("!shed", "C-shed", "710.1"));
    const direct = await pollFor(built, (d) => d.text === SHED);
    assert.ok(direct, "the final text reply was delivered directly");
    assert.equal(direct.destination.target, "slack:C-shed:710.1", "delivered to the addressed conversation");
    const session = await built.sessions.getByThread("ch:C-shed:710.1");
    const requests = await built.sessions.listLlmRequests(session!.id);
    assert.ok(
      !requests.some((r) => JSON.stringify(r.promptEnvelope).includes("[system] You were addressed directly")),
      "no nudge model call — the existing reply text is delivered as-is",
    );
    await sleep(300);
    assert.equal((await pending(built)).filter((d) => d.text === SHED).length, 1, "the reply delivers once");
  }));

test("addressed + STILL no post after the nudge → the nudge turn's text is delivered as the fallback", () =>
  withApp(async (built) => {
    await built.app.turn(mention("!shedmute", "C-shedmute", "710.3"));
    const fallback = await pollFor(built, (d) => d.text === SHED);
    assert.ok(fallback, "the shed reply was delivered as the fallback");
    assert.equal(fallback.destination.target, "slack:C-shedmute:710.3", "delivered to the addressed conversation");
    const nudgeRequest = await lastPrompt(built, "ch:C-shedmute:710.3");
    assert.ok(
      nudgeRequest.messages?.some((message) => message.role === "assistant" && message.content === SHED),
      "the stateless nudge rebuild includes the first sub-turn's assistant message",
    );
    await sleep(300);
    assert.equal((await pending(built)).filter((d) => d.text === SHED).length, 1, "the fallback delivers once");
  }));

test("reply-or-decline nudge preserves the trigger image and environment", () =>
  withApp(
    async (built) => {
      const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const { blobId } = await built.blobTransfer.put(image);
      await built.app.turn({
        ...mention("!shedmute", "C-nudge-image", "710.2"),
        conversationHeader: "QA-IMAGE-ENVIRONMENT",
        attachments: [{ name: "qa.png", mimetype: "image/png", sizeBytes: image.length, blobId }],
      });
      assert.ok(await pollFor(built, (d) => d.text.startsWith(SHED), 15_000));
      const request = await lastPrompt(built, "ch:C-nudge-image:710.2");
      assert.equal(request.images?.length, 1);
      assert.equal(request.images?.[0]?.mimeType, "image/png");
      assert.equal(request.images?.[0]?.dataBase64, image.toString("base64"));
      assert.match(request.messages?.at(-1)?.content ?? "", /QA-IMAGE-ENVIRONMENT/);
      const session = await built.sessions.getByThread("ch:C-nudge-image:710.2");
      const entries = await built.sessions.getEntries(session!.id);
      assert.equal(
        entries.filter((entry) => Array.isArray((entry.payload as { attachments?: unknown[] }).attachments)).length,
        1,
      );
    },
    buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-spine-image-")), securityPosture: "dangerous" })),
  ));

test("nudge tape reread failure falls back to refreshed history, never the stale pre-turn fold", () =>
  withApp(async (built) => {
    await built.app.turn(mention("!post prior", "C-nudge-read", "711.1"));
    assert.ok(await pollFor(built, (d) => d.text === "prior"));

    const originalGetTape = built.sessions.getTape.bind(built.sessions);
    let reads = 0;
    built.sessions.getTape = async (sessionId) => {
      reads++;
      if (reads >= 2) throw new Error("nudge tape read failed");
      return originalGetTape(sessionId);
    };

    await built.app.turn(mention("!shedmute", "C-nudge-read", "711.1"));
    assert.ok(await pollFor(built, (d) => d.text === SHED));
    const nudgeRequest = await lastPrompt(built, "ch:C-nudge-read:711.1");
    assert.ok(
      nudgeRequest.messages?.some((message) => message.role === "assistant" && message.content === SHED),
      "a failed reread reconstructs from history containing the first sub-turn",
    );
    assert.ok(reads >= 2, "the nudge attempted a fresh tape read");
  }));

test("addressed spine turn: the first text block posts immediately as the ack when real work follows", () =>
  withApp(async (built) => {
    await built.app.turn(mention("!preamble On it — checking the deploy logs.", "C-ack", "720.1"));
    const ack = await pollFor(built, (d) => d.text === "On it — checking the deploy logs.");
    assert.ok(ack, "the first block was harvested and enqueued while the tool ran");
    assert.equal(ack.destination.target, "slack:C-ack:720.1", "the ack lands in the addressed conversation");
    const posted = await pollFor(built, (d) => d.text === "All clear — nothing broke.");
    assert.ok(posted, "the trailing reply text is delivered (the ack alone did not satisfy the reply contract)");
  }));

test("first action is `post` (speaking deliberately) → the opening text is NOT harvested as an ack", () =>
  withApp(async (built) => {
    await built.app.turn(mention("!speakpost the direct answer", "C-nopreharvest", "730.1"));
    const posted = await pollFor(built, (d) => d.text === "the direct answer");
    assert.ok(posted, "the deliberate post went out");
    await sleep(300);
    assert.equal((await pending(built)).length, 1, "exactly one delivery — the streamed opening text never posted");
  }));

test("addressed + finish_silently → no nudge (explicit decline is accepted)", () =>
  withApp(async (built) => {
    const res = await built.app.turn({ ...mention("!finish-silent", "C-decline", "700.2"), async: false });
    assert.equal(res.status, "silent", "an explicit finish_silently ends the turn silently");
    await sleep(300);
    assert.equal((await pending(built)).length, 0, "finish_silently suppresses the nudge and closing reply");
  }));

test("ambient (unaddressed) silence → no nudge (silence stays free)", () =>
  withApp(async (built) => {
    const res = await built.app.turn({ ...follow("!silent", "C-amb", "700.3", "C-amb:700.3"), async: false });
    assert.equal(res.status, "silent", "an unaddressed silent turn stays silent, no nudge");
    await sleep(300);
    assert.equal(
      (await pending(built)).filter((d) => d.text === "nudged reply").length,
      0,
      "no nudge on an unaddressed turn",
    );
  }));

test("post broadcast:true posts at the channel top level, not in the current thread", () =>
  withApp(async (built) => {
    await built.app.turn(mention("!broadcast ahoy channel", "C-top", "800.1"));
    const posted = await pollFor(built, (d) => d.text === "ahoy channel");
    assert.ok(posted, "the top-level post landed");
    assert.equal(posted.destination.target, "C-top", "broadcast posts to the bare channel, not the thread");
  }));

test("post with an explicit ts to the current channel targets exactly <channel>:<ts>", () =>
  withApp(async (built) => {
    await built.app.turn({
      ...mention("!postthread 800.5 threaded reply", "C-top", "800.1"),
      deliveryTarget: "C-top:800.1",
    });
    const posted = await pollFor(built, (d) => d.text === "threaded reply");
    assert.ok(posted, "the threaded post landed");
    assert.equal(posted.destination.target, "C-top:800.5", "explicit ts replaces only the thread segment");
  }));

test("reach to a named channel resolves it, posts at that channel's top level, and echoes the match", () =>
  withApp(async (built) => {
    const request = mention("!reachchan C-top elsewhere", "C-top", "800.1");
    const res = await built.app.turn({
      ...request,
      conversation: { ...request.conversation, channelName: "top" },
      deliveryTarget: "C-top:800.1",
    });
    assert.equal(res.status, "queued");
    const posted = await pollFor(built, (d) => d.text === "elsewhere");
    assert.ok(posted, "the reach post landed");
    assert.equal(posted.destination.target, "C-top", "reach to a channel posts at its top level (bare container)");
  }));

for (const command of ["!finish-silent-approval", "!finish-silent-paused"]) {
  test(`surface silence preserves pending approval: ${command}`, async () => {
    const built = freshApp();
    const result = await built.app.turn({ ...mention(command, "C-approval", command), async: false });
    assert.equal(result.status, "pending_approval");
    assert.equal(result.pendingApprovals?.length, 1);
    assert.equal((await built.deliveries.pending("slack")).length, 0);
  });
}

test("a shared web project turn answers with its final text, not surface tools", () =>
  withApp(async (built) => {
    const project = await built.app.createProject("U1", "Launch");
    assert.ok(project);
    const ref = project.scopeId.slice("group:".length);
    const result = await built.app.turn({
      surface: "web",
      actor,
      conversation: { kind: "group", threadRef: `web:U1:${crypto.randomUUID()}`, channelRef: ref, audience: [actor] },
      text: "hello project",
      liveActor: true,
    });
    assert.equal(result.status, "ok", result.reason);
    assert.ok(result.reply, "the final text is the reply");
    const run = (await built.runs.list()).find((r) => r.request.text === "hello project");
    assert.ok(run);
    assert.notEqual(run.request.surfaceTools, true, "web project turns do not get the Slack surface-tools protocol");
    assert.equal((await pending(built)).length, 0);
  }));
