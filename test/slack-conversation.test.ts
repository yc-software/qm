import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextWindow,
  recentWindow,
  formatSlackTs,
  MAX_RECENT_MESSAGES,
  mergeConsecutiveTurns,
  resolveMentions,
  renderConversationView,
  type ConversationView,
  type ConversationTurn,
  type RecentMessage,
  encodeTs,
} from "../src/slack/lib.ts";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ctxMsg = (ts: string, name: string, text: string, extra: Partial<RecentMessage> = {}): RecentMessage => ({
  ts,
  name,
  text,
  ...extra,
});

test("buildContextWindow keeps the most-recent `count` messages and maps them to wire shape", () => {
  const scanned = Array.from({ length: 8 }, (_, i) => ctxMsg(`170000000${i}.000100`, `User${i}`, `message ${i}`));
  const w = buildContextWindow(scanned, { count: 3 });
  assert.equal(w.messages.length, 3);
  assert.deepEqual(
    w.messages.map((m) => m.text),
    ["message 5", "message 6", "message 7"],
  );
  assert.equal(w.messages[0]!.author, "User5");
  assert.ok(w.messages[0]!.time, "carries a human-readable timestamp");
  assert.equal(w.hasMore, true, "older scanned messages are pageable");
  assert.equal(w.nextBefore, w.messages[0]!.ts, "cursor continues from the oldest returned message");

  const all = buildContextWindow(scanned, { count: 50 });
  assert.equal(all.messages.length, 8);
  assert.equal(all.hasMore, false, "everything scanned fit");
  assert.equal(all.nextBefore, undefined);
});

test("buildContextWindow filters by case-insensitive match and pages dropped matches from the oldest kept", () => {
  const scanned = [
    ctxMsg("1700000001.000100", "Alice", "we should DEPLOY tonight"),
    ctxMsg("1700000002.000100", "Bob", "unrelated chatter"),
    ctxMsg("1700000003.000100", "Carol", "deploy is blocked on CI"),
    ctxMsg("1700000004.000100", "Dave", "ship it"),
    ctxMsg("1700000005.000100", "Erin", "deploy went out"),
  ];
  const w = buildContextWindow(scanned, { count: 2, match: "deploy" });
  assert.deepEqual(
    w.messages.map((m) => m.author),
    ["Carol", "Erin"],
  );
  assert.equal(w.hasMore, true, "one match was dropped by count");
  assert.equal(
    w.nextBefore,
    "1700000003.000100",
    "cursor continues from the oldest KEPT match, not the oldest scanned",
  );
});

test("buildContextWindow pages the scan onward when the surface had more, even with zero matches", () => {
  const scanned = [
    ctxMsg("1700000001.000100", "Alice", "nothing relevant"),
    ctxMsg("1700000002.000100", "Bob", "still nothing"),
  ];
  const w = buildContextWindow(scanned, { count: 50, match: "deploy", scanHasMore: true });
  assert.deepEqual(w.messages, []);
  assert.equal(w.hasMore, true);
  assert.equal(w.nextBefore, "1700000001.000100", "cursor walks past the scanned region");
});

test("buildContextWindow labels self messages, resolves mentions, threads, files, and clips long text", () => {
  const nameById = new Map([["U1", "Alice"]]);
  const w = buildContextWindow(
    [
      ctxMsg("1700000001.000100", "Alice", "root post"),
      ctxMsg("1700000002.000100", "agent", `ping <@U1> ${"x".repeat(700)}`, {
        isSelf: true,
        parentTs: "1700000001.000100",
        files: ["plan.pdf"],
      }),
    ],
    { count: 10, nameById },
  );
  const self = w.messages[1]!;
  assert.equal(self.author, "you");
  assert.equal(self.threadTs, "1700000001.000100");
  assert.deepEqual(self.files, ["plan.pdf"]);
  assert.ok(self.text.startsWith("ping @Alice"), "mentions resolve to names");
  assert.ok(self.text.length <= 601 && self.text.endsWith("…"), "long text is clipped");
});

test("recentWindow keeps the contiguous recent window — a NON-latest message in it is not dropped", () => {
  const candidates = [
    { ts: "1700000000.000001", name: "Carol", text: "Yeah it's pretty nice", authorId: "U_CAROL" },
    { ts: "1700000000.000002", name: "Mira", text: "agreed", authorId: "U_MIRA" },
    { ts: "1700000000.000003", name: "Carol", text: "@agent thoughts?", authorId: "U_CAROL", isTrigger: true },
  ];
  const picked = recentWindow(candidates);
  assert.ok(
    picked.some((m) => m.text === "Yeah it's pretty nice"),
    "Carol's earlier line is kept, not evicted for his latest",
  );
  assert.equal(picked.length, 3);
  for (let i = 1; i < picked.length; i++) assert.ok(picked[i - 1]!.ts < picked[i]!.ts);
});

test("recentWindow drops stale channel history beyond the age cap for a top-level trigger", () => {
  const trigger = 1_700_200_000;
  const candidates = [
    {
      ts: `${trigger - 2 * 86_400}.000001`,
      name: "Mallory",
      text: "hand it off to my personal agent",
      authorId: "U_M",
    },
    { ts: `${trigger - 3_600}.000002`, name: "Alice", text: "fresh context", authorId: "U_A" },
    { ts: `${trigger}.000003`, name: "Bob", text: "@agent hey, what can you do?", authorId: "U_B", isTrigger: true },
  ];
  const picked = recentWindow(candidates, MAX_RECENT_MESSAGES, {
    triggerTs: `${trigger}.000003`,
    maxAgeSeconds: 86_400,
  });
  assert.deepEqual(
    picked.map((m) => m.text),
    ["fresh context", "@agent hey, what can you do?"],
    "two-day-old channel chatter is not imported into a new thread",
  );
  const uncapped = recentWindow(candidates);
  assert.equal(uncapped.length, 3, "without the cap (thread turns) nothing is dropped");
});

test("recentWindow caps at the most-recent MAX_RECENT_MESSAGES (older ones drop contiguously)", () => {
  const candidates = Array.from({ length: MAX_RECENT_MESSAGES + 8 }, (_, i) => ({
    ts: `1700000000.0000${String(i).padStart(2, "0")}`,
    name: `p${i}`,
    text: `m${i}`,
    authorId: `U_${i}`,
  }));
  const picked = recentWindow(candidates);
  assert.equal(picked.length, MAX_RECENT_MESSAGES);
  assert.ok(
    picked.some((m) => m.text === `m${MAX_RECENT_MESSAGES + 7}`),
    "newest present",
  );
  assert.ok(!picked.some((m) => m.text === "m0"), "oldest beyond the window dropped");
});

test("recentWindow honors an explicit limit override (env-tunable window depth)", () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({
    ts: `1700000000.0000${String(i).padStart(2, "0")}`,
    name: `p${i}`,
    text: `m${i}`,
    authorId: `U_${i}`,
  }));
  assert.equal(recentWindow(candidates, 5).length, 5, "caps at the override");
  assert.ok(
    recentWindow(candidates, 5).some((m) => m.text === "m29"),
    "keeps the newest under the override",
  );
  assert.equal(recentWindow(candidates, 100).length, 30, "a window larger than the thread keeps every message");
});

test("recentWindow pulls in a kept reply's thread root (parent-closure adds context, never drops a recent message)", () => {
  const root = { ts: "1700000000.000001", name: "Alice", text: "the question", authorId: "U_ALICE" };
  const fillers = Array.from({ length: MAX_RECENT_MESSAGES }, (_, i) => ({
    ts: `1700000050.0000${String(i).padStart(2, "0")}`,
    name: `person${i}`,
    text: `f${i}`,
    authorId: `U_${i}`,
  }));
  const reply = { ts: "1700000099.000000", name: "Carol", text: "the answer", authorId: "U_CAROL", parentTs: root.ts };
  const picked = recentWindow([root, ...fillers, reply]);
  assert.ok(
    picked.some((m) => m.ts === reply.ts),
    "the recent reply is in the window",
  );
  assert.ok(
    picked.some((m) => m.ts === root.ts),
    "its parent is pulled in so the thread reads whole",
  );
});

test("formatSlackTs renders a Slack epoch ts as a compact UTC datetime; junk → empty", () => {
  assert.match(formatSlackTs("1717360800.000100"), /^\d{4}-\d\d-\d\d \d\d:\d\dZ$/);
  assert.equal(formatSlackTs("0"), "");
  assert.equal(formatSlackTs("nope"), "");
});

test("mergeConsecutiveTurns merges consecutive user speakers into one, names inline", () => {
  const merged = mergeConsecutiveTurns([
    { role: "user", name: "alice", text: "hi" },
    { role: "user", name: "carol", text: "hey" },
    { role: "assistant", text: "hello both" },
    { role: "user", name: "alice", text: "one more thing" },
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0]!.role, "user");
  assert.equal(merged[0]!.name, undefined);
  assert.equal(merged[0]!.text, "alice: hi\ncarol: hey");
  assert.equal(merged[1]!.role, "assistant");
  assert.equal(merged[2]!.role, "user");
  assert.equal(merged[2]!.name, "alice");
  assert.equal(merged[2]!.text, "one more thing");
});

test("mergeConsecutiveTurns merges consecutive assistant turns plainly (one speaker)", () => {
  const merged = mergeConsecutiveTurns([
    { role: "assistant", text: "part one" },
    { role: "assistant", text: "part two" },
  ]);
  assert.deepEqual(merged, [{ role: "assistant", text: "part one\npart two" }]);
});

test("mergeConsecutiveTurns leaves a strictly-alternating sequence untouched", () => {
  const turns: ConversationTurn[] = [
    { role: "user", name: "alice", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", name: "alice", text: "q2" },
  ];
  const merged = mergeConsecutiveTurns(turns);
  assert.deepEqual(merged, turns);
});

test("resolveMentions rewrites <@U…> to @Name from the map; unknown ids stay raw", () => {
  const names = new Map([
    ["U1", "Alice"],
    ["U2", "Bob"],
  ]);
  assert.equal(resolveMentions("hey <@U1> and <@U2|bob>", names), "hey @Alice and @Bob");
  assert.equal(resolveMentions("ping <@U9>", names), "ping <@U9>");
  assert.equal(resolveMentions("no mentions here", names), "no mentions here");
});

const baseView = (over: Partial<ConversationView> = {}): ConversationView => ({
  channel: { name: "eng", kind: "channel", isPrivate: true },
  members: [
    { id: "U1", name: "Alice" },
    { id: "U2", name: "Bob" },
    { id: "UME", name: "Agent", isYou: true },
  ],
  messages: [],
  here: { kind: "top-level" },
  files: [],
  omittedFiles: [],
  nameById: new Map([
    ["U1", "Alice"],
    ["U2", "Bob"],
  ]),
  ...over,
});

test("renderConversationView: header shows channel, members (you), and the you-are-here marker", () => {
  const { header, priorTurns } = renderConversationView(
    baseView({
      messages: [{ ts: "1717360800.000003", name: "Alice", text: "ship it", authorId: "U1", isTrigger: true }],
    }),
  );
  assert.match(header, /You are in #eng \(private\)\./);
  assert.match(header, /People here: @Alice \(<@U1>\), @Bob \(<@U2>\), you\./);
  assert.match(header, /You are replying to a top-level message/);
  assert.equal(priorTurns.length, 0);
});

test("renderConversationView: a bot member is tagged `agent` so the agent @mentions it instead of asking its personal agent", () => {
  const { header } = renderConversationView(
    baseView({
      members: [
        { id: "U1", name: "Alice" },
        { id: "UBOT", name: "Finance", isBot: true },
        { id: "UME", name: "Agent", isYou: true },
      ],
    }),
  );
  assert.match(header, /@Alice \(<@U1>\), @Finance \(<@UBOT>, agent\), you\./);
});

test("renderConversationView: email principals still show real Slack mention ids", () => {
  const { header } = renderConversationView(
    baseView({
      members: [
        { id: "alice@acme.com", mentionId: "U1", name: "Alice" },
        { id: "bob@acme.com", mentionId: "U2", name: "Bob" },
      ],
    }),
  );
  assert.match(header, /@Alice \(<@U1>\), @Bob \(<@U2>\)/);
  assert.doesNotMatch(header, /<@alice@acme\.com>/);
});

test("renderConversationView: header names a group DM distinctly from a channel", () => {
  const { header } = renderConversationView(baseView({ channel: { kind: "group" } }));
  assert.match(header, /This is a group direct message\./);
  assert.doesNotMatch(header, /channel/);
});

test("renderConversationView: a DM thread renders a 1:1 header + prior turns (seeds the new per-thread DM session)", () => {
  const parentTs = "1717360800.000001";
  const { header, priorTurns } = renderConversationView(
    baseView({
      channel: { kind: "dm" },
      here: { kind: "thread", youOpenedIt: false, starterName: "Alice" },
      messages: [
        { ts: parentTs, name: "Alice", text: "can you summarize the incident?", authorId: "U1", isTrigger: false },
        {
          ts: "1717360800.000009",
          name: "Alice",
          text: "now in the thread: which alert fired first?",
          authorId: "U1",
          isTrigger: true,
        },
      ],
    }),
  );
  assert.match(header, /direct message/i);
  assert.match(header, /thread/i);
  assert.equal(priorTurns.length, 1);
  assert.match(priorTurns[0]!.text, /can you summarize the incident\?/);
  assert.doesNotMatch(priorTurns[0]!.text, /which alert fired first/);
});

test("renderConversationView: others → name-tagged user turns, own → assistant; trigger excluded; ids inline", () => {
  const tsA = "1717360800.000001";
  const tsBot = "1717360800.000002";
  const tsTrigger = "1717360800.000003";
  const { priorTurns, allowedTs } = renderConversationView(
    baseView({
      here: { kind: "thread", youOpenedIt: false, starterName: "Alice" },
      messages: [
        { ts: tsA, name: "Alice", text: "can someone deploy?", authorId: "U1" },
        { ts: tsBot, name: "Bob", text: "on it", authorId: "U2", parentTs: tsA },
        { ts: tsTrigger, name: "Alice", text: "thanks <@U2>", authorId: "U1", parentTs: tsA, isTrigger: true },
      ],
    }),
  );
  assert.equal(priorTurns.length, 1);
  assert.equal(priorTurns[0]!.role, "user");
  assert.match(priorTurns[0]!.text, new RegExp(`\\[${escapeRe(encodeTs(tsA))}\\]`));
  assert.match(priorTurns[0]!.text, /Alice: .*can someone deploy\?/);
  assert.match(priorTurns[0]!.text, /Bob: .*\(reply\).*on it/);
  assert.doesNotMatch(priorTurns[0]!.text, /thanks/);
  assert.ok(allowedTs.has(tsA) && allowedTs.has(tsBot) && allowedTs.has(tsTrigger));
});

test("renderConversationView: overheard is one un-merged entry per non-trigger message, ts-keyed, raw text", () => {
  const tsA = "1717360800.000001";
  const tsB = "1717360800.000002";
  const tsBot = "1717360800.000004";
  const tsTrigger = "1717360800.000005";
  const { overheard } = renderConversationView(
    baseView({
      here: { kind: "thread", youOpenedIt: false, starterName: "Alice" },
      messages: [
        { ts: tsA, name: "Alice", text: "can someone deploy?", authorId: "U1" },
        { ts: tsB, name: "Bob", text: "on it <@U1>", authorId: "U2", parentTs: tsA, files: ["plan.png"] },
        { ts: tsBot, name: "Agent", text: "deployed", authorId: "UME", isSelf: true, isBot: true, parentTs: tsA },
        { ts: tsTrigger, name: "Alice", text: "thanks", authorId: "U1", parentTs: tsA, isTrigger: true },
      ],
    }),
  );
  assert.deepEqual(
    overheard.map((m) => m.ts),
    [tsA, tsB, tsBot],
  );
  assert.equal(overheard[0]!.role, "user");
  assert.equal(overheard[0]!.name, "Alice");
  assert.equal(overheard[0]!.text, "can someone deploy?");
  assert.deepEqual(overheard[1]!.files, ["plan.png"]);
  assert.match(overheard[1]!.text, /@Alice/);
  assert.equal(overheard[2]!.role, "self");
  assert.equal(overheard[2]!.name, undefined);
});

test("renderConversationView: the agent's own reply becomes an assistant turn but is dropped from detection", () => {
  const tsA = "1717360800.000001";
  const tsSelf = "1717360800.000002";
  const tsTrigger = "1717360800.000003";
  const { priorTurns, detectContext } = renderConversationView(
    baseView({
      here: { kind: "thread", youOpenedIt: false, starterName: "Alice" },
      messages: [
        { ts: tsA, name: "Alice", text: "how are you?", authorId: "U1" },
        {
          ts: tsSelf,
          name: "Agent",
          text: "doing great, thanks!",
          authorId: "UME",
          isSelf: true,
          isBot: true,
          parentTs: tsA,
        },
        { ts: tsTrigger, name: "Alice", text: "browse HN for me?", authorId: "U1", parentTs: tsA, isTrigger: true },
      ],
    }),
  );
  assert.equal(priorTurns.length, 2);
  assert.equal(priorTurns[0]!.role, "user");
  assert.equal(priorTurns[0]!.name, "Alice");
  assert.equal(priorTurns[1]!.role, "assistant");
  assert.equal(priorTurns[1]!.name, undefined);
  assert.match(priorTurns[1]!.text, /doing great, thanks!/);
  assert.doesNotMatch(detectContext, /doing great/);
  assert.match(detectContext, /Alice: how are you\?/);
});

test("renderConversationView: detectContext is human-only (drops bot posts + the trigger); detectOpener set when you opened", () => {
  const { detectContext, detectOpener } = renderConversationView(
    baseView({
      here: { kind: "thread", youOpenedIt: true, openerText: "deploy shipped v4" },
      messages: [
        { ts: "2", name: "Deploybot", text: "build green", authorId: "B1", isBot: true, parentTs: "1" },
        { ts: "3", name: "Alice", text: "nice", authorId: "U1", parentTs: "1" },
        { ts: "4", name: "Bob", text: "ship the next one?", authorId: "U2", parentTs: "1", isTrigger: true },
      ],
    }),
  );
  assert.match(detectContext, /Alice: nice/);
  assert.doesNotMatch(detectContext, /Deploybot/);
  assert.doesNotMatch(detectContext, /ship the next one/);
  assert.equal(detectOpener, "deploy shipped v4");
});

test("renderConversationView: long messages survive into model turns up to a generous cap (credential-loss regression)", () => {
  const tsSelf = "1717360800.000001";
  const tsTrigger = "1717360800.000002";
  const secret = "USERNAME=project-alpha_org PASSWORD=hunter2-correct";
  const longReply = "Created the HN account. " + "context ".repeat(80) + secret;
  const { priorTurns } = renderConversationView(
    baseView({
      here: { kind: "thread", youOpenedIt: false, starterName: "Alice" },
      messages: [
        { ts: tsSelf, name: "Agent", text: longReply, authorId: "UME", isSelf: true, isBot: true },
        { ts: tsTrigger, name: "Alice", text: "use that login", authorId: "U1", parentTs: tsSelf, isTrigger: true },
      ],
    }),
  );
  assert.equal(priorTurns.length, 1);
  assert.equal(priorTurns[0]!.role, "assistant");
  assert.match(priorTurns[0]!.text, /PASSWORD=hunter2-correct/);
  assert.doesNotMatch(priorTurns[0]!.text, /…/);
});

test("renderConversationView: the generous model cap still bounds a pathological paste", () => {
  const tsA = "1717360800.000001";
  const tsTrigger = "1717360800.000002";
  const huge = "x".repeat(10_000);
  const { priorTurns } = renderConversationView(
    baseView({
      messages: [
        { ts: tsA, name: "Alice", text: huge, authorId: "U1" },
        { ts: tsTrigger, name: "Bob", text: "ok", authorId: "U2", isTrigger: true },
      ],
    }),
  );
  assert.equal(priorTurns.length, 1);
  assert.ok(priorTurns[0]!.text.includes("…"));
  assert.ok(priorTurns[0]!.text.length < huge.length);
});

test("renderConversationView: detection preview still clips long human messages to a short gist", () => {
  const tsA = "1717360800.000001";
  const tsTrigger = "1717360800.000002";
  const longHuman = "please " + "deploy ".repeat(100);
  const { detectContext } = renderConversationView(
    baseView({
      here: { kind: "thread", youOpenedIt: false, starterName: "Alice" },
      messages: [
        { ts: tsA, name: "Alice", text: longHuman, authorId: "U1" },
        { ts: tsTrigger, name: "Bob", text: "ok", authorId: "U2", parentTs: tsA, isTrigger: true },
      ],
    }),
  );
  assert.ok(detectContext.includes("…"));
  assert.ok(detectContext.length < longHuman.length);
});

test("renderConversationView: a message's files render inline, too-big files are flagged, empty view → empty turns", () => {
  const tsA = "1717360800.000001";
  const withFiles = renderConversationView(
    baseView({
      files: [{ name: "graph.png" }],
      messages: [
        { ts: tsA, name: "Alice", text: "see graph", authorId: "U1", files: ["graph.png"] },
        { ts: "1717360800.000002", name: "Bob", text: "looking", authorId: "U2", isTrigger: true },
      ],
      omittedFiles: [{ name: "dump.sql", reason: "too-big" }],
    }),
  );
  assert.match(withFiles.priorTurns[0]!.text, /\(files: graph\.png\)/);
  assert.match(withFiles.header, /Files referenced in this conversation: graph\.png\./);
  assert.match(withFiles.header, /Files too big to view this turn: dump\.sql\./);
  assert.ok(
    withFiles.header.indexOf("Files referenced in this conversation") < withFiles.header.indexOf("You are in #eng"),
  );
  assert.ok(withFiles.header.indexOf("Files too big to view this turn") < withFiles.header.indexOf("You are in #eng"));

  const empty = renderConversationView({
    channel: { kind: "channel" },
    members: [],
    messages: [],
    here: { kind: "top-level" },
    files: [],
    omittedFiles: [],
  });
  assert.equal(empty.priorTurns.length, 0);
  assert.equal(empty.detectContext, "");
});
