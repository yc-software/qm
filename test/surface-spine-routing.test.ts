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

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-spine-"));
  return buildApp(testConfig({ dataDir }));
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

async function pollDeliveries(
  deliveries: { pending(type: string): Promise<unknown[]> },
  deadlineMs = 5_000,
): Promise<any[]> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const pending = (await deliveries.pending("slack")) as any[];
    if (pending.length) return pending;
    await sleep(50);
  }
  return [];
}

async function pollFor(
  deliveries: { pending(type: string): Promise<unknown[]> },
  match: (d: any) => boolean,
  deadlineMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const hit = ((await deliveries.pending("slack")) as any[]).find(match);
    if (hit) return hit;
    await sleep(50);
  }
  return undefined;
}

test("spine ON: react/edit/delete route through the SAME reach chokepoint to the current conversation", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C5";
    const target = `slack:${channel}:`;

    await built.app.turn(mention("!react 500.5 eyes", channel, "500.5"));
    const reactD = await pollFor(built.deliveries, (d) => d.destination.react);
    assert.ok(reactD, "react enqueued a reaction delivery");
    assert.equal(reactD.text, "", "a reaction carries no composed text");
    assert.deepEqual(reactD.destination.react, { messageTs: "500.5", emoji: "eyes" });
    assert.equal(reactD.destination.target, `${target}500.5`, "reacted in the current conversation");

    await built.app.turn(mention("!edit 501.5 the corrected line", channel, "501.5"));
    const editD = await pollFor(built.deliveries, (d) => d.destination.editRef);
    assert.ok(editD, "edit enqueued an editRef delivery");
    assert.equal(editD.destination.editRef, "501.5");
    assert.equal(editD.text, "the corrected line", "the edit carries the new text");

    await built.app.turn(mention("!delete 502.5", channel, "502.5"));
    const delD = await pollFor(built.deliveries, (d) => d.destination.delete);
    assert.ok(delD, "delete enqueued a deletion delivery");
    assert.deepEqual(delD.destination.delete, { messageTs: "502.5" });
    assert.equal(delD.text, "", "a deletion carries no composed text");
  } finally {
    await built.runtime.stop();
  }
});

test("spine ON: an @mention engages a sub-conversation session that posts (no separate ambient session)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C1";
    const root = "100.1";
    const res = await built.app.turn(mention("!post hello team", channel, root));
    assert.equal(res.status, "queued", "the addressed turn is routed (queued as a sub-conversation run)");

    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "exactly one delivery — the post, not a double-post");
    assert.equal(pending[0].text, "hello team");
    assert.equal(pending[0].destination.target, `slack:${channel}:${root}`);
    const sourceSession = await built.sessions.getByThread(`ch:${channel}:${root}`);
    assert.equal(
      pending[0].provenance?.trigger,
      "conversation",
      "a live turn's post is marked conversation, not a wake",
    );
    assert.equal(pending[0].provenance?.sourceSessionId, sourceSession!.id);
    assert.equal(pending[0].provenance?.sourceThreadRef, `ch:${channel}:${root}`);

    const sub = await built.sessions.getByThread(`ch:${channel}:${root}`);
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
  } finally {
    await built.runtime.stop();
  }
});

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

test("a replayed/resumed request carries surfaceTools through app.turn (approval-continuation path)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C4";
    const root = "400.4";
    await built.app.turn({ ...mention("!post resumed", channel, root), surfaceTools: true });
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "the resumed turn replied via post");
    assert.equal(pending[0].text, "resumed");
    assert.equal(pending[0].destination.target, `slack:${channel}:${root}`);
  } finally {
    await built.runtime.stop();
  }
});

test("response debt: a turn that DID post keeps its monologue shed (no double reply)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn(mention("!post the actual reply", "C9", "900.1"));
    const d = await pollFor(built.deliveries, (x) => x.text === "the actual reply");
    assert.ok(d, "the posted reply landed");
    await sleep(400);
    const all = (await built.deliveries.pending("slack")) as any[];
    const extras = all.filter((x) => x.destination.target?.includes("C9") && x.text !== "the actual reply");
    assert.deepEqual(
      extras.map((x) => x.text),
      [],
      "no monologue rode out as a second delivery",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a trigger turn (surfaceTools + triggerDestination, no deliveryTarget) posts to the trigger destination", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const target = "slack:C7:700.7";
    const res = await built.app.turn({
      surface: "monitor",
      actor,
      conversation: { kind: "channel", threadRef: "ch:C7:700.7", channelRef: "C7", audience: [actor] },
      text: "!post the build passed",
      triggered: true,
      surfaceTools: true,
      addressed: true,
      triggerDestination: { type: "slack", target, audienceScopeId: scopeId("channel", "C7") },
      async: true,
    });
    assert.equal(res.status, "queued");
    const d = await pollFor(built.deliveries, (x) => x.text === "the build passed");
    assert.ok(d, "the reply reached the surface via post");
    assert.equal(d.destination.target, target, "the post aimed at the trigger destination (the arming thread)");
    const all = (await built.deliveries.pending("slack")) as any[];
    assert.equal(all.filter((x) => x.text === "the build passed").length, 1, "exactly one delivery — no duplicate");
  } finally {
    await built.runtime.stop();
  }
});

test("a monitor (addressed poll fire) that finishes silently is NOT nudged into a forced reply", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn({
      surface: "monitor",
      actor,
      conversation: { kind: "channel", threadRef: "ch:C8:800.8", channelRef: "C8", audience: [actor] },
      text: "!finish-silent",
      triggered: true,
      surfaceTools: true,
      addressed: true,
      triggerDestination: { type: "slack", target: "slack:C8:800.8", audienceScopeId: scopeId("channel", "C8") },
      async: false,
    });
    await sleep(300);
    const all = (await built.deliveries.pending("slack")) as any[];
    assert.deepEqual(
      all.filter((x) => x.destination.target?.includes("C8")).map((x) => x.text),
      [],
      "silence is the poll success case — nothing is delivered",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("surfaceTools with NO resolvable destination falls back to the normal auto-reply (never silences into the void)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
  } finally {
    await built.runtime.stop();
  }
});

test("spine ON: an unprompted thread-follow ALSO routes to a sub-conversation with surface tools", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C-follow";
    const root = "700.1";
    await built.app.turn({
      surface: "slack",
      actor,
      conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
      deliveryTarget: `slack:${channel}:${root}`,
      text: "!post following up",
      unprompted: true,
      async: true,
    });
    const posted = await pollFor(
      built.deliveries,
      (d) => d.destination.target === `slack:${channel}:${root}` && d.text === "following up",
    );
    assert.ok(posted, "the thread-follow ran with surface tools and posted via the post tool");
    assert.equal(
      await built.sessions.getByThread(`slack/${channel}`),
      null,
      "no per-container ambient session is created",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("addressed + no post → exactly one nudge → the agent posts on the continuation turn", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn(mention("!silent", "C-nudge", "700.1"));
    const posted = await pollFor(built.deliveries, (d) => d.text === "nudged reply");
    assert.ok(posted, "the agent posted after the reply-or-decline nudge");
    await sleep(300);
    const all = (await built.deliveries.pending("slack")) as any[];
    assert.equal(all.filter((d) => d.text === "nudged reply").length, 1, "the nudge fires at most once");
    const session = await built.sessions.getByThread("ch:C-nudge:700.1");
    const entries = await built.sessions.getEntries(session!.id);
    assert.equal(
      await built.sessions.tapeCoverage(session!.id),
      entries.at(-1)!.seq,
      "the watermark is a write-completeness claim: no append failed, so a nudged turn still advances it",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("addressed + no post but a final text reply → the reply is delivered directly, no nudge", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn(mention("!shed", "C-shed", "710.1"));
    const direct = await pollFor(built.deliveries, (d) => d.text === "worklog: did the thing but never posted");
    assert.ok(direct, "the final text reply was delivered directly");
    assert.equal(direct.destination.target, "slack:C-shed:710.1", "delivered to the addressed conversation");
    const session = await built.sessions.getByThread("ch:C-shed:710.1");
    const requests = await built.sessions.listLlmRequests(session!.id);
    assert.ok(
      !requests.some((r) => JSON.stringify(r.promptEnvelope).includes("[system] You were addressed directly")),
      "no nudge model call — the existing reply text is delivered as-is",
    );
    await sleep(300);
    const all = (await built.deliveries.pending("slack")) as any[];
    assert.equal(
      all.filter((d) => d.text === "worklog: did the thing but never posted").length,
      1,
      "the reply delivers once",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("addressed + STILL no post after the nudge → the nudge turn's text is delivered as the fallback", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn(mention("!shedmute", "C-shedmute", "710.3"));
    const fallback = await pollFor(built.deliveries, (d) => d.text === "worklog: did the thing but never posted");
    assert.ok(fallback, "the shed reply was delivered as the fallback");
    assert.equal(fallback.destination.target, "slack:C-shedmute:710.3", "delivered to the addressed conversation");
    const session = await built.sessions.getByThread("ch:C-shedmute:710.3");
    const nudgeRequest = (await built.sessions.listLlmRequests(session!.id)).at(-1)!.promptEnvelope as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    assert.ok(
      nudgeRequest.messages?.some(
        (message) => message.role === "assistant" && message.content === "worklog: did the thing but never posted",
      ),
      "the stateless nudge rebuild includes the first sub-turn's assistant message",
    );
    await sleep(300);
    const all = (await built.deliveries.pending("slack")) as any[];
    assert.equal(
      all.filter((d) => d.text === "worklog: did the thing but never posted").length,
      1,
      "the fallback delivers once",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("reply-or-decline nudge preserves the trigger image and environment", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-spine-image-"));
  const built = buildApp(testConfig({ dataDir, securityPosture: "dangerous" }));
  built.runtime.start();
  try {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { blobId } = await built.blobTransfer.put(image);
    await built.app.turn({
      ...mention("!shedmute", "C-nudge-image", "710.2"),
      conversationHeader: "QA-IMAGE-ENVIRONMENT",
      attachments: [{ name: "qa.png", mimetype: "image/png", sizeBytes: image.length, blobId }],
    });
    assert.ok(
      await pollFor(built.deliveries, (d) => d.text.startsWith("worklog: did the thing but never posted"), 15_000),
    );
    const session = await built.sessions.getByThread("ch:C-nudge-image:710.2");
    const request = (await built.sessions.listLlmRequests(session!.id)).at(-1)!.promptEnvelope as {
      messages?: Array<{ role?: string; content?: string }>;
      images?: Array<{ mimeType?: string; dataBase64?: string }>;
    };
    assert.equal(request.images?.length, 1);
    assert.equal(request.images?.[0]?.mimeType, "image/png");
    assert.equal(request.images?.[0]?.dataBase64, image.toString("base64"));
    assert.match(request.messages?.at(-1)?.content ?? "", /QA-IMAGE-ENVIRONMENT/);
    const entries = await built.sessions.getEntries(session!.id);
    assert.equal(
      entries.filter((entry) => Array.isArray((entry.payload as { attachments?: unknown[] }).attachments)).length,
      1,
    );
  } finally {
    await built.runtime.stop();
  }
});

test("nudge tape reread failure falls back to refreshed history, never the stale pre-turn fold", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn(mention("!post prior", "C-nudge-read", "711.1"));
    assert.ok(await pollFor(built.deliveries, (d) => d.text === "prior"));

    const originalGetTape = built.sessions.getTape.bind(built.sessions);
    let reads = 0;
    built.sessions.getTape = async (sessionId) => {
      reads++;
      if (reads === 2) throw new Error("nudge tape read failed");
      return originalGetTape(sessionId);
    };

    await built.app.turn(mention("!shedmute", "C-nudge-read", "711.1"));
    assert.ok(await pollFor(built.deliveries, (d) => d.text === "worklog: did the thing but never posted"));
    const session = await built.sessions.getByThread("ch:C-nudge-read:711.1");
    const nudgeRequest = (await built.sessions.listLlmRequests(session!.id)).at(-1)!.promptEnvelope as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    assert.ok(
      nudgeRequest.messages?.some(
        (message) => message.role === "assistant" && message.content === "worklog: did the thing but never posted",
      ),
      "a failed reread reconstructs from history containing the first sub-turn",
    );
    assert.equal(reads, 2, "the nudge attempted a fresh tape read");
  } finally {
    await built.runtime.stop();
  }
});

test("addressed spine turn: the first text block posts immediately as the ack when real work follows", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn(mention("!preamble On it — checking the deploy logs.", "C-ack", "720.1"));
    const ack = await pollFor(built.deliveries, (d) => d.text === "On it — checking the deploy logs.");
    assert.ok(ack, "the first block was harvested and enqueued while the tool ran");
    assert.equal(ack.destination.target, "slack:C-ack:720.1", "the ack lands in the addressed conversation");
    const posted = await pollFor(built.deliveries, (d) => d.text === "All clear — nothing broke.");
    assert.ok(posted, "the trailing reply text is delivered (the ack alone did not satisfy the reply contract)");
  } finally {
    await built.runtime.stop();
  }
});

test("first action is `post` (speaking deliberately) → the opening text is NOT harvested as an ack", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn(mention("!speakpost the direct answer", "C-nopreharvest", "730.1"));
    const posted = await pollFor(built.deliveries, (d) => d.text === "the direct answer");
    assert.ok(posted, "the deliberate post went out");
    await sleep(300);
    const all = (await built.deliveries.pending("slack")) as any[];
    assert.equal(all.length, 1, "exactly one delivery — the streamed opening text never posted");
  } finally {
    await built.runtime.stop();
  }
});

test("addressed + stay_silent → no nudge (explicit decline is accepted)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const res = await built.app.turn({ ...mention("!staysilent no comment", "C-decline", "700.2"), async: false });
    assert.equal(res.status, "silent", "an explicit stay_silent ends the turn silently");
    await sleep(300);
    const all = (await built.deliveries.pending("slack")) as any[];
    assert.equal(all.filter((d) => d.text === "nudged reply").length, 0, "stay_silent suppresses the nudge");
  } finally {
    await built.runtime.stop();
  }
});

test("ambient (unaddressed) silence → no nudge (silence stays free)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const res = await built.app.turn({
      surface: "slack",
      actor,
      conversation: { kind: "channel", threadRef: `ch:C-amb:700.3`, channelRef: "C-amb", audience: [actor] },
      deliveryTarget: `C-amb:700.3`,
      text: "!silent",
      unprompted: true,
      async: false,
    });
    assert.equal(res.status, "silent", "an unaddressed silent turn stays silent, no nudge");
    await sleep(300);
    const all = (await built.deliveries.pending("slack")) as any[];
    assert.equal(all.filter((d) => d.text === "nudged reply").length, 0, "no nudge on an unaddressed turn");
  } finally {
    await built.runtime.stop();
  }
});

test("post broadcast:true posts at the channel top level, not in the current thread", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C-top";
    const root = "800.1";
    await built.app.turn({
      surface: "slack",
      actor,
      conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
      deliveryTarget: `slack:${channel}:${root}`,
      text: `!broadcast ahoy channel`,
      liveActor: true,
      async: true,
    });
    const posted = await pollFor(built.deliveries, (d) => d.text === "ahoy channel");
    assert.ok(posted, "the top-level post landed");
    assert.equal(posted.destination.target, channel, "broadcast posts to the bare channel, not the thread");
  } finally {
    await built.runtime.stop();
  }
});

test("post with an explicit ts to the current channel targets exactly <channel>:<ts>", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C-top";
    const root = "800.1";
    const ts = "800.5";
    await built.app.turn({
      surface: "slack",
      actor,
      conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
      deliveryTarget: `${channel}:${root}`,
      text: `!postthread ${ts} threaded reply`,
      liveActor: true,
      async: true,
    });
    const posted = await pollFor(built.deliveries, (d) => d.text === "threaded reply");
    assert.ok(posted, "the threaded post landed");
    assert.equal(posted.destination.target, `${channel}:${ts}`, "explicit ts replaces only the thread segment");
  } finally {
    await built.runtime.stop();
  }
});

test("reach to a named channel resolves it, posts at that channel's top level, and echoes the match", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C-top";
    const root = "800.1";
    const res = await built.app.turn({
      surface: "slack",
      actor,
      conversation: {
        kind: "channel",
        threadRef: `ch:${channel}:${root}`,
        channelRef: channel,
        channelName: "top",
        audience: [actor],
      },
      deliveryTarget: `${channel}:${root}`,
      text: `!reachchan ${channel} elsewhere`,
      liveActor: true,
      async: true,
    });
    assert.equal(res.status, "queued");
    const posted = await pollFor(built.deliveries, (d) => d.text === "elsewhere");
    assert.ok(posted, "the reach post landed");
    assert.equal(posted.destination.target, channel, "reach to a channel posts at its top level (bare container)");
  } finally {
    await built.runtime.stop();
  }
});

test('Door 2: an addressed @mention opens the sub-conversation with a <wake reason="addressed"> envelope', async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C-door2";
    const root = "700.1";
    const res = await built.app.turn(mention("!post ahoy", channel, root));
    assert.equal(res.status, "queued");
    const posted = await pollFor(built.deliveries, (d) => d.destination.target === `slack:${channel}:${root}`);
    assert.ok(posted, "the addressed turn still replies via post");
    assert.equal(posted.text, "ahoy");

    const sub = await built.sessions.getByThread(`ch:${channel}:${root}`);
    const entries = await built.sessions.getEntries(sub!.id);
    const userText = String((entries.find((e) => e.type === "user")?.payload as any)?.text ?? "");
    assert.match(userText, /^<wake reason="addressed"/, "the addressed turn opens with a wake envelope");
    assert.match(
      userText,
      /<addressed-messages[^>]*>[\s\S]*!post ahoy[\s\S]*<\/addressed-messages>/,
      "the trigger rides the addressed block",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("Door 2: an unprompted thread-follow is NOT envelope-wrapped (its detection gate reads raw text)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const channel = "C-follow2";
    const root = "810.1";
    const res = await built.app.turn({
      surface: "slack",
      actor,
      conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
      deliveryTarget: `slack:${channel}:${root}`,
      text: "!post following up",
      unprompted: true,
      async: true,
    });
    assert.equal(res.status, "queued");
    const posted = await pollFor(
      built.deliveries,
      (d) => d.destination.target === `slack:${channel}:${root}` && d.text === "following up",
    );
    assert.ok(posted, "the thread-follow still routes + posts");
    const sub = await built.sessions.getByThread(`ch:${channel}:${root}`);
    const entries = await built.sessions.getEntries(sub!.id);
    const userText = String((entries.find((e) => e.type === "user")?.payload as any)?.text ?? "");
    assert.doesNotMatch(
      userText,
      /^<wake/,
      "a thread-follow keeps the raw-text path (wake envelope deferred to a follow-up)",
    );
  } finally {
    await built.runtime.stop();
  }
});
