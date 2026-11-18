import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { type TurnRequest } from "../src/types.ts";
import { freshApp, internalActor, dm, channel } from "./support/orchestrator-app.ts";
import { failedTurnError } from "./support/failed-turn.ts";
import type { SecurityScreener } from "../src/security/security-screener.ts";
import { createTurnHandler } from "../src/slack/turn-handler.ts";
import { createConversationSerializer } from "../src/slack/conversation-view.ts";
import { isUserItem, messageTs, type Item } from "../src/sessions/items.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

test("identity grounding: the roster lists this conversation's participants by their canonical directory name", async () => {
  const { app, directory } = freshApp();
  await directory.replace([
    { principalId: "U1", displayName: "Alice Example", type: "internal" },
    { principalId: "U2", displayName: "Renee Mars", type: "internal" },
    { principalId: "U3", displayName: "taylor", type: "internal" },
    { principalId: "U9", displayName: "Outsider Olive", type: "internal" },
  ]);
  const prompt = await app.turn({
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster:t1",
      channelRef: "C-roster",
      audience: [internalActor, { externalId: "U2" }, { externalId: "U3" }],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(sp, /## Who's in this conversation/);
  assert.match(sp, /Alice Example \(U1\)/);
  assert.match(sp, /Renee Mars \(U2\)/);
  assert.match(sp, /taylor \(U3\)/);
  assert.doesNotMatch(sp, /Outsider Olive/);
});

test("identity grounding: the roster is bounded (caps at ROSTER_CAP and reports the overflow)", async () => {
  const { app, directory } = freshApp();
  const many = Array.from({ length: 30 }, (_, i) => ({
    principalId: `U${i}`,
    displayName: `Person ${i}`,
    type: "internal" as const,
  }));
  await directory.replace(many);
  const prompt = await app.turn({
    surface: "slack",
    actor: { externalId: "U0" },
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-big:t1",
      channelRef: "C-roster-big",
      audience: many.map((m) => ({ externalId: m.principalId })),
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  const listed = (sp.match(/- Person \d+ \(U\d+\)/g) ?? []).length;
  assert.equal(listed, 20, "the roster caps the number of people listed");
  assert.match(sp, /…and 10 more in this conversation\./);
});

test("identity grounding: a participant who hasn't synced into the directory still grounds from the surface name", async () => {
  const { app, directory } = freshApp();
  await directory.replace([{ principalId: "U1", displayName: "Alice Example", type: "internal" }]);
  const prompt = await app.turn({
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-partial:t1",
      channelRef: "C-roster-partial",
      audience: [internalActor, { externalId: "U7", displayName: "Newcomer Nat" }],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(sp, /Alice Example \(U1\)/);
  assert.match(sp, /Newcomer Nat \(U7\)/);
});

test("identity grounding: a cased-vs-lowercase duplicate participant resolves to the single real directory member", async () => {
  const { app, directory } = freshApp();
  await directory.replace([
    { principalId: "U1", displayName: "Jordan Lee", type: "internal" },
    { principalId: "alice@acme.com", displayName: "Alice Wonderland", type: "internal" },
  ]);
  const prompt = await app.turn({
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-case:t1",
      channelRef: "C-roster-case",
      audience: [
        internalActor,
        { externalId: "Alice@acme.com", displayName: "Cased Alias" },
        { externalId: "alice@acme.com" },
      ],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(
    sp,
    /Alice Wonderland \(alice@acme\.com\)/,
    "the cased participant grounds as the canonical directory member",
  );
  assert.doesNotMatch(sp, /Cased Alias/, "no synthetic fallback entry when the person is in the directory");
  assert.equal((sp.match(/Alice/g) ?? []).length, 1, "the duplicate is listed exactly once");
});

test("an unexpected turn fault is recorded to the error log and fails the turn", async () => {
  const built = freshApp({ maxAttempts: 1 });
  const { errors } = built;
  await failedTurnError(built, dm("!boom"));
  const turnError = (await errors.list(tenant)).find((e) => e.category === "turn" && e.code === "error");
  assert.ok(turnError, "the turn fault should be recorded in the error log");
  assert.match(turnError!.message, /boom/);
  assert.ok(turnError!.sessionId, "the recorded error carries the session id for triage");
});

test("an unprompted thread message the colleague wouldn't answer is silent (no run, no writes)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("ok sounds good to me", { origin: { kind: "ambient" } }));
  assert.equal(res.status, "silent");
  assert.ok(res.sessionId);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("a poll fire that ends with no message resolves to silent, not a delivered empty reply", async () => {
  const { app } = freshApp();
  const cron = {
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm" as const, threadRef: "dm:U1:cron" },
    text: "!silent",
    origin: { kind: "automation" as const },
  };
  const res = await app.turn(cron);
  assert.equal(res.status, "silent", "the agent had nothing to add, so the turn is silent");
  assert.ok(res.sessionId, "the turn still ran — it's silent, not skipped");
});

test("a poll fire whose reply is a bracketed token is an ordinary reply; only finish_silently silences it", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron2" },
    text: "!run printf %s 'Nothing changed.\n\n[no-update]'",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "ok");
  assert.equal(res.reply, "Nothing changed.\n\n[no-update]");
  const silenced = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron2b" },
    text: "!finish-silent",
    origin: { kind: "automation" },
  });
  assert.equal(silenced.status, "silent");
});

test("a poll fire with a real reply still delivers (status ok), and a non-triggered empty reply is not silenced", async () => {
  const { app } = freshApp();
  const real = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron3" },
    text: "!run printf %s 'PTO is due today'",
    origin: { kind: "automation" },
  });
  assert.equal(real.status, "ok");
  assert.match(real.reply ?? "", /PTO is due today/);
  const interactive = await app.turn(dm("!silent"));
  assert.notEqual(interactive.status, "silent");
});

test("a poll fire whose only output is an attached file delivers it — files, not silence", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron6" },
    text: "!writeattach digest.png PNG",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "ok", "files are a real update — the empty reply must not silence the fire");
  assert.equal(res.reply, "");
  assert.deepEqual(
    (res.attachments ?? []).map((a) => a.name),
    ["digest.png"],
  );
});

test("a poll fire that attaches a file and then finishes silently still delivers the file", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron7" },
    text: "!attachsilent digest.png PNG",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "ok", "the file was confirmed to the model, so silence must not discard it");
  assert.deepEqual(
    (res.attachments ?? []).map((a) => a.name),
    ["digest.png"],
  );
});

test("a poll fire that calls finish_silently ends the turn with an empty reply and resolves to silent", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron4" },
    text: "!finish-silent",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "silent", "the tool terminates the turn — the empty closing reply is the silence");
  assert.equal(res.reply, undefined, "nothing is delivered — the model never gets a step to narrate its silence");
});

test("finish_silently is a no-op off a poll fire — the agent's reply still delivers", async () => {
  const { app } = freshApp();
  const interactive = await app.turn(dm("!finish-silent"));
  assert.notEqual(interactive.status, "silent", "a person is waiting, so the turn is never silenced");
  assert.match(interactive.reply ?? "", /ending silently/);
});

test("a subagent's wake of its web parent may finish silently; a sidebar session's turn may not", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const threadRef = "dm:U1:child-wake";
    const opened = await built.app.turn({ ...dm("hello"), conversation: { kind: "dm", threadRef } });
    assert.equal(opened.status, "ok");
    const [source] = await built.runs.list({ threadRef });
    const parent = (await built.sessions.getByThread(threadRef))!;
    const session = async (ref: string) =>
      built.sessions.getOrCreateByThread(ref, "dm", parent.scopeId, undefined, "web");
    const child = await session("agent:main:subagent:child-wake");
    await built.sessions.setParentSession(child.id, parent.id);
    const sidebar = await session("dm:U1:child-wake:sidebar");
    await built.sessions.setParentSession(sidebar.id, parent.id);
    const turnFrom = async (sessionSenderId: string) => {
      const { run } = await built.runs.enqueue({
        sessionId: threadRef,
        request: { ...source!.request, sessionSenderId, text: "!finish-silent", envelopeWrapped: true },
      });
      return (await built.runs.waitFor(run.id, 20_000)).result;
    };
    const wake = await turnFrom(child.id);
    assert.equal(wake?.status, "silent", "nothing new, so the wake ends without a reply");
    assert.equal(wake?.reply, undefined);
    const other = await turnFrom(sidebar.id);
    assert.equal(other?.status, "ok");
    assert.match(other?.reply ?? "", /ending silently/);
  } finally {
    await built.runtime.stop();
  }
});

test("finish_silently on a poll fire wins over a coexisting collected approval", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron5" },
    text: "!finish-silent-approval",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "silent", "explicit silence must win over the pending-approval branch");
  assert.equal(res.reply, undefined, "no narration leaks");
  assert.equal(res.pendingApprovals, undefined, "no approval prompt is surfaced on a silenced poll fire");
});

test("a poll fire that PAUSED on a gated command is never silenced — the approval persists", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron7" },
    text: "!finish-silent-paused",
    origin: { kind: "automation" },
  });
  assert.equal(
    res.status,
    "pending_approval",
    "a paused turn outranks explicit silence — silencing it would starve the cron with no trace",
  );
  assert.ok(res.pendingApprovals?.length, "the approval stays durable so it can be approved and the run resumed");
});

test("an unprompted acknowledgement gets an emoji reaction, not a reply (no run, no writes)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("thanks, that's perfect", { origin: { kind: "ambient" } }));
  assert.equal(res.status, "react");
  assert.ok((res.reactions ?? []).length > 0);
  assert.ok(res.sessionId);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("on a surface without reactions, the same acknowledgement just stays silent (no REACT leaks)", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("thanks, that's perfect", { origin: { kind: "ambient" }, gatewayContext: undefined }),
  );
  assert.equal(res.status, "silent");
  assert.equal((res.reactions ?? []).length, 0);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("turn detection books its model call to the conversation's scope, whether or not the agent replies", async () => {
  const { app, sessions } = freshApp();
  const silent = await app.turn(channel("ok sounds good to me", { origin: { kind: "ambient" } }));
  assert.equal(silent.status, "silent");
  const answered = await app.turn(
    channel("what does everyone think about the rollout?", { origin: { kind: "ambient" } }),
  );
  assert.equal(answered.status, "ok");
  assert.equal(answered.sessionId, silent.sessionId);

  const requests = await sessions.listLlmRequests(answered.sessionId!);
  const detections = requests.filter((request) => request.model === "mock-detect");
  const turn = requests.find((request) => request.model === "mock");
  assert.equal(detections.length, 2);
  assert.ok(turn);
  for (const detection of detections) {
    assert.equal(detection.turnSeq, null);
    assert.equal(detection.scopeLabel, turn.scopeLabel);
    assert.ok(detection.usage && detection.usage.input > 0);
  }
});

test("an unprompted thread question gets a reply (turn detection chimes in)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("what does everyone think about the rollout?", { origin: { kind: "ambient" } }));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /You said: what does everyone think/);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
  );
});

test("priorTurns are routed to the agent as structured roled turns (PR3)", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("!priorturns", {
      origin: { kind: "ambient" },
      priorTurns: [
        { role: "user", name: "U2", text: "I think we ship Friday" },
        { role: "user", name: "U3", text: "I'd wait for QA" },
        { role: "assistant", text: "let me check the dashboard" },
      ],
    }),
  );
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /user\/U2: I think we ship Friday/);
  assert.match(res.reply ?? "", /user\/U3: I'd wait for QA/);
  assert.match(res.reply ?? "", /assistant: let me check the dashboard/);
});

test("overheard messages are imported ONCE into the durable log, author-labeled, and handed to the agent", async () => {
  const { app, sessions } = freshApp();
  const entryBatches: number[] = [];
  const appendMany = sessions.appendMany.bind(sessions);
  sessions.appendMany = async (writer, items) => {
    if (items.some((item) => item.body?.overheard)) entryBatches.push(items.length);
    return appendMany(writer, items);
  };
  const overheardItems = (items: Item[]) => items.filter((e) => isUserItem(e) && e.body.overheard === true);

  const r1 = await app.turn(
    channel("!overheard", {
      overheard: [
        { ts: "100.001", role: "user", name: "Alice", text: "I posted a cat photo", files: ["cat.jpg"] },
        { ts: "100.002", role: "self", text: "nice cat" },
        { ts: "100.003", role: "user", name: "Bob", text: "love it" },
      ],
    }),
  );
  assert.equal(r1.status, "ok");
  assert.match(r1.reply ?? "", /Alice@100\.001: I posted a cat photo \[cat\.jpg\]/);
  assert.match(r1.reply ?? "", /Bob@100\.003: love it/);
  assert.match(r1.reply ?? "", /nice cat/);

  const s1 = await app.getSession(r1.sessionId!);
  const ov1 = overheardItems(s1!.items);
  assert.deepEqual(ov1.map(messageTs), ["100.001", "100.002", "100.003"]);
  assert.equal(ov1[1]!.body.sourceRole, "agent");
  assert.equal(ov1[0]!.body.name, "Alice");
  assert.ok(ov1.every((item) => item.body.speakerId === undefined));
  assert.deepEqual(ov1[0]!.body.files, ["cat.jpg"]);

  const r2 = await app.turn(
    channel("!overheard", {
      overheard: [
        { ts: "100.001", role: "user", name: "Alice", text: "I posted a cat photo", files: ["cat.jpg"] },
        { ts: "100.002", role: "self", text: "nice cat" },
        { ts: "100.003", role: "user", name: "Bob", text: "love it" },
        { ts: "100.004", role: "user", name: "Carol", text: "me too" },
      ],
    }),
  );
  assert.equal(r2.status, "ok");
  assert.match(r2.reply ?? "", /Carol@100\.004: me too/);
  assert.doesNotMatch(r2.reply ?? "", /Alice@100\.001/);

  const s2 = await app.getSession(r2.sessionId!);
  const ov2 = overheardItems(s2!.items);
  assert.deepEqual(
    ov2.map(messageTs),
    ["100.001", "100.002", "100.003", "100.004"],
    "append-only: each message recorded exactly once",
  );
  assert.deepEqual(entryBatches, [3, 1]);
});

test("a message answered on one turn is not re-imported as overheard on the next (full-stack dedupe)", async () => {
  const { app } = freshApp();
  const overheardItems = (items: Item[]) => items.filter((e) => isUserItem(e) && e.body.overheard === true);

  const r1 = await app.turn(
    channel("run it now on the first 20 emails", { origin: { kind: "human", messageTs: "200.001" } }),
  );
  assert.equal(r1.status, "ok");
  const s1 = await app.getSession(r1.sessionId!);
  const trigger = s1!.items.find((e) => isUserItem(e) && messageTs(e) === "200.001");
  assert.ok(trigger, "the trigger entry carries its surface ts");
  assert.match(
    trigger!.text ?? "",
    /run it now on the first 20 emails/,
    "the addressed message rides the recorded entry",
  );

  const r2 = await app.turn(
    channel("did that work?", {
      origin: { kind: "human", messageTs: "200.002" },
      overheard: [{ ts: "200.001", role: "user", name: "Avery", text: "run it now on the first 20 emails" }],
    }),
  );
  assert.equal(r2.status, "ok");
  const s2 = await app.getSession(r2.sessionId!);
  assert.deepEqual(
    overheardItems(s2!.items).map(messageTs),
    [],
    "the just-answered message is not doubled as overheard",
  );
  const withText = s2!.items.filter(
    (e) => isUserItem(e) && (e.text ?? "").includes("run it now on the first 20 emails"),
  );
  assert.equal(withText.length, 1, "recorded exactly once");
});

test("an unprompted thread-follow (no triggerTs) is stamped via entryTs and not re-imported as overheard", async () => {
  const { app } = freshApp();
  const overheardItems = (items: Item[]) => items.filter((e) => isUserItem(e) && e.body.overheard === true);

  const followText = "should I actually skip the last one?";
  const r1 = await app.turn(channel(followText, { origin: { kind: "ambient", entryTs: "300.001" } }));
  assert.equal(r1.status, "ok");
  const s1 = await app.getSession(r1.sessionId!);
  const trigger = s1!.items.find((e) => isUserItem(e) && messageTs(e) === "300.001");
  assert.ok(trigger, "the unprompted-follow entry carries its surface ts via entryTs");

  const r2 = await app.turn(
    channel("ok done?", {
      origin: { kind: "human", messageTs: "300.002" },
      overheard: [{ ts: "300.001", role: "user", name: "Avery", text: followText }],
    }),
  );
  assert.equal(r2.status, "ok");
  const s2 = await app.getSession(r2.sessionId!);
  assert.deepEqual(overheardItems(s2!.items).map(messageTs), [], "the unprompted follow is not doubled as overheard");
  const withText = s2!.items.filter((e) => isUserItem(e) && (e.text ?? "").includes(followText));
  assert.equal(withText.length, 1, "recorded exactly once");
});

test("turn file context leads the environment block before the conversation header", async () => {
  const { app, blobTransfer } = freshApp();
  const blob = await blobTransfer.put(Buffer.from("notes"));

  const res = await app.turn(
    channel("what should I do with this?", {
      conversationHeader: "You are in #eng. You are replying to a top-level message.",
      attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
    }),
  );

  assert.equal(res.status, "ok");
  const reply = res.reply ?? "";
  const requestAt = reply.indexOf("what should I do with this?");
  const envAt = reply.indexOf("<environment>");
  const inboxAt = reply.indexOf("shared notes.txt (");
  const headerAt = reply.indexOf("You are in #eng");
  const envEndAt = reply.indexOf("</environment>");
  assert.notEqual(requestAt, -1, "expected live user request");
  assert.notEqual(envAt, -1, "expected environment block");
  assert.notEqual(inboxAt, -1, "expected inbound attachment manifest");
  assert.notEqual(headerAt, -1, "expected conversation header");
  assert.notEqual(envEndAt, -1, "expected environment block close");
  assert.ok(requestAt < envAt, "live user request remains the leading turn content");
  assert.ok(envAt < inboxAt, "file manifest should be inside the environment block");
  assert.ok(inboxAt < headerAt, "file manifest should precede the conversation header");
  assert.ok(headerAt < envEndAt, "conversation header should remain inside the environment block");
});

test("the situational conversationHeader rides in the <environment> block, not as a message list", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("@agent is this possible?", {
      conversationHeader: "You are in #design. You are replying in a thread @U2 started.",
      priorTurns: [{ role: "user", name: "U2", text: "here's the original idea that started this thread" }],
    }),
  );
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /<environment>/);
  assert.match(res.reply ?? "", /You are replying in a thread @U2 started\./);
  const found = await app.getSession(res.sessionId!);
  const userText = found!.items.find(isUserItem)!.text ?? "";
  assert.doesNotMatch(userText, /original idea that started this thread/);
  assert.equal(userText, "@agent is this possible?");
  assert.doesNotMatch(userText, /<environment>/);
});

test("Slack names people set reach the screen as data, never in the trusted conversation header", async () => {
  const parts: Array<{ source: string; content: string }> = [];
  const screener: SecurityScreener = {
    provider: "spy",
    classify: async ({ payload }) => {
      parts.push(...(JSON.parse(payload) as typeof parts));
      return { verdict: { decision: "auto" }, score: 0, threshold: 0.7 };
    },
  };
  const { app } = freshApp({ securityPosture: "auto" }, screener);
  const directory = { classifyUserCached: async () => ({ actor: { displayName: "Starter Name" } }) };
  const ids = { botUserId: "UBOT", ownBotId: "BBOT" };
  const raw = [{ ts: "1.000", thread_ts: "1.000", user: "U2", text: "kickoff" }];
  const serializer = createConversationSerializer({ ids, directory, readHistory: async () => ({ raw }) } as never);
  const callCore = (turn: Omit<TurnRequest, "surface">) => app.turn({ ...turn, surface: "slack" });
  const deps = { flow: { callCore }, directory, mirror: {}, serializer, ids, threads: { mark() {} } };
  const files = [{ id: "F1", name: "Upload Name.key", size: 2e9, url_private: "https://files.slack.com/F1" }];
  const prefetched = { actor: internalActor, info: { name: "channel-name" }, audience: [internalActor] };
  const inc = { kind: "channel", channel: "C1", userId: "U1", rawText: "recap?", threadTs: "1.000", ts: "2.000" };
  const run = (extra: object) =>
    createTurnHandler(deps as never).handleIncoming({ ...inc, unprompted: true, prefetched, ...extra } as never, {});
  await run({ files });
  for (const name of ["channel-name", "Starter Name", "Upload Name.key"]) {
    const holders = parts.filter((part) => part.content.includes(name)).map((part) => part.source);
    assert.ok(holders.length && !holders.includes("conversation-header"), `${name} screened as ${holders}`);
  }
  await run({ kind: "dm", channel: "D1", threadTs: undefined, rawText: "hi", files: [] });
  assert.equal(parts.filter((part) => part.source === "conversation-metadata").length, 1);
});

test("a reply in a thread the agent STARTED chimes in, even as a bare statement (deploy-notification-reply bug)", async () => {
  const { app } = freshApp();
  const bare = await app.turn(channel("looks good to me", { origin: { kind: "ambient" } }));
  assert.equal(bare.status, "silent");
  const withOpener = await app.turn(
    channel("looks good to me", { origin: { kind: "ambient" }, detectOpener: "deploy abc123 — auth refactor (#125)" }),
  );
  assert.equal(withOpener.status, "ok");
});

test("detectOpener drives turn detection but is NOT rendered into the prompt", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("looks good to me", { origin: { kind: "ambient" }, detectOpener: "deploy abc123 — auth refactor (#125)" }),
  );
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /auth refactor/);
});

test("an explicit (prompted) thread message always runs, even as a plain statement", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("ok sounds good to me"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /You said: ok sounds good/);
});

test("a turn carries its surface name to the agent, DM or not", async () => {
  const built = freshApp();
  assert.equal((await built.app.turn(dm("!surfacename", { surface: "web" }))).reply, "surface:web");
  assert.equal((await built.app.turn(dm("!surfacename", { surface: "slack" }))).reply, "surface:slack");
});

test("only a conversation where several people can speak names the sender of each message", async () => {
  const { app } = freshApp();
  const ada = { externalId: "U1", displayName: "Ada" };
  const environmentOf = (reply?: string) => (reply ?? "").split("<environment>")[1] ?? "";
  const direct = await app.turn(dm("!sysprompt", { actor: ada }));
  assert.doesNotMatch(environmentOf(direct.reply), /This message is from/);
  const room = await app.turn(
    channel("!sysprompt", {
      actor: ada,
      conversation: { kind: "channel", threadRef: "ch:C1:sender", channelRef: "C1", audience: [ada] },
    }),
  );
  assert.match(environmentOf(room.reply), /This message is from @Ada\./);
});

test("inventories ride a byte-stable system prompt; a warm turn's environment carries only the clock", async () => {
  const { app } = freshApp();
  const first = await app.turn(dm("!sysprompt", { timezone: "America/Los_Angeles" }));
  const second = await app.turn(dm("!sysprompt", { timezone: "America/Los_Angeles" }));
  const [system1, environment1] = (first.reply ?? "").split("<environment>");
  const [system2, environment2] = (second.reply ?? "").split("<environment>");
  assert.equal(system2, system1);
  assert.match(environment2!, /^\nLocal time: \S+ \d\d:\d\d P[SD]T \(America\/Los_Angeles\)\n<\/environment>$/);
  assert.doesNotMatch(environment1!, /## /);
});
