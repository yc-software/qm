import { test } from "node:test";
import assert from "node:assert/strict";
import { EMOJI_NAME_BY_CHAR } from "../src/slack/emoji-map.ts";
import {
  normalizeReaction,
  normalizeReactions,
  applyReactions,
  summarizeReactions,
  shouldSurfaceReaction,
  buildReactionTurnText,
  extractReactions,
  stripReactionDirectives,
  parseReactionGroup,
  resolveReactionTargets,
  encodeTs,
  decodeTs,
  MAX_REACTIONS_PER_TURN,
  CURATED_ACK_EMOJI,
} from "../src/slack/lib.ts";

test("normalizeReaction accepts a bare name, strips colons, and lowercases", () => {
  assert.equal(normalizeReaction("eyes"), "eyes");
  assert.equal(normalizeReaction(":eyes:"), "eyes");
  assert.equal(normalizeReaction("  :White_Check_Mark:  "), "white_check_mark");
  assert.equal(normalizeReaction("+1"), "+1");
  assert.equal(normalizeReaction("thumbsup::skin-tone-3"), "thumbsup::skin-tone-3");
});

test("normalizeReaction maps a literal unicode emoji to its Slack short-name", () => {
  assert.equal(normalizeReaction("👀"), "eyes");
  assert.equal(normalizeReaction("✅"), "white_check_mark");
  assert.equal(normalizeReaction("👍"), "+1");
  assert.equal(normalizeReaction("🫡"), "saluting_face");
});

test("normalizeReaction covers the FULL Slack emoji set, not just a hand-picked few", () => {
  assert.equal(normalizeReaction("🦄"), "unicorn_face");
  assert.equal(normalizeReaction("🥺"), "pleading_face");
  assert.equal(normalizeReaction("🫶"), "heart_hands");
  assert.equal(normalizeReaction("🧑‍💻"), "technologist");
  assert.equal(normalizeReaction("🤷‍♀️"), "woman-shrugging");
});

test("normalizeReaction strips the VS16 variation selector (❤️ and ❤ both → heart)", () => {
  assert.equal(normalizeReaction("❤️"), "heart");
  assert.equal(normalizeReaction("❤"), "heart");
  assert.equal(normalizeReaction("⚠️"), "warning");
});

test("normalizeReaction lifts a skin-tone modifier into Slack's ::skin-tone-N suffix", () => {
  assert.equal(normalizeReaction("👍🏽"), "+1::skin-tone-4");
  assert.equal(normalizeReaction("👋🏻"), "wave::skin-tone-2");
  assert.equal(normalizeReaction("🙏🏿"), "pray::skin-tone-6");
});

test("EMOJI_NAME_BY_CHAR is the full generated set (guards against a botched regeneration)", () => {
  assert.ok(Object.keys(EMOJI_NAME_BY_CHAR).length > 1800, "expected the full emoji table");
  assert.equal(EMOJI_NAME_BY_CHAR["🫡"], "saluting_face");
});

test("CURATED_ACK_EMOJI are all canonical Slack shortcodes (a bad name silently produces no reaction)", () => {
  const canonical = new Set(Object.values(EMOJI_NAME_BY_CHAR));
  const bad = CURATED_ACK_EMOJI.filter((name) => !canonical.has(name));
  assert.deepEqual(bad, [], `not canonical Slack shortcodes: ${bad.join(", ")}`);
});
test("normalizeReaction passes through a described emoji's Slack short-name (e.g. salute)", () => {
  assert.equal(normalizeReaction("saluting_face"), "saluting_face");
  assert.equal(normalizeReaction(":saluting_face:"), "saluting_face");
});

test("normalizeReaction rejects names with spaces or illegal chars", () => {
  assert.equal(normalizeReaction("not a name"), null);
  assert.equal(normalizeReaction(""), null);
  assert.equal(normalizeReaction(":"), null);
  assert.equal(normalizeReaction("bad/name"), null);
});

test("normalizeReactions dedupes (post-normalization) and caps the count", () => {
  assert.deepEqual(normalizeReactions([":eyes:", "eyes", "EYES"]), ["eyes"]);
  const many = Array.from({ length: MAX_REACTIONS_PER_TURN + 3 }, (_, i) => `emoji_${i}`);
  assert.equal(normalizeReactions(many).length, MAX_REACTIONS_PER_TURN);
  assert.deepEqual(normalizeReactions(["eyes", "bad name", "tada"]), ["eyes", "tada"]);
});

test("applyReactions calls reactions.add per normalized emoji on the triggering message", async () => {
  const calls: Array<{ channel: string; timestamp: string; name: string }> = [];
  const client = {
    reactions: { add: async (a: { channel: string; timestamp: string; name: string }) => void calls.push(a) },
  };
  const r = await applyReactions(client, "C1", "111.222", [":eyes:", "bad name", "eyes"]);
  assert.deepEqual(r.added, ["eyes"]);
  assert.deepEqual(r.failed, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { channel: "C1", timestamp: "111.222", name: "eyes" });
});

test("applyReactions treats already_reacted as success and collects other failures", async () => {
  const realSetTimeout = global.setTimeout;
  (global as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof realSetTimeout>;
  }) as typeof setTimeout;
  try {
    const client = {
      reactions: {
        add: async (a: { name: string }) => {
          if (a.name === "eyes") throw { data: { error: "already_reacted" } };
          if (a.name === "tada") throw { data: { error: "invalid_name" } };
          return {};
        },
      },
    };
    const r = await applyReactions(client, "C1", "1.2", ["eyes", "tada", "rocket"]);
    assert.deepEqual(r.added.sort(), ["eyes", "rocket"]);
    assert.deepEqual(r.failed, ["tada"]);
  } finally {
    (global as { setTimeout: unknown }).setTimeout = realSetTimeout;
  }
});

test("applyReactions retries a just-created custom emoji past Slack's propagation lag", async () => {
  const realSetTimeout = global.setTimeout;
  (global as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof realSetTimeout>;
  }) as typeof setTimeout;
  try {
    let attempts = 0;
    const client = {
      reactions: {
        add: async () => {
          attempts++;
          if (attempts <= 2) throw { data: { error: "invalid_name" } };
          return {};
        },
      },
    };
    const r = await applyReactions(client, "C1", "1.2", ["galaxybrain"]);
    assert.deepEqual(r.added, ["galaxybrain"]);
    assert.deepEqual(r.failed, []);
    assert.equal(attempts, 3);
  } finally {
    (global as { setTimeout: unknown }).setTimeout = realSetTimeout;
  }
});

test("applyReactions fails fast on a non-propagation error (no retry loop)", async () => {
  const realSetTimeout = global.setTimeout;
  let slept = 0;
  (global as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    slept++;
    fn();
    return 0 as unknown as ReturnType<typeof realSetTimeout>;
  }) as typeof setTimeout;
  try {
    let attempts = 0;
    const client = {
      reactions: {
        add: async () => {
          attempts++;
          throw { data: { error: "channel_not_found" } };
        },
      },
    };
    const r = await applyReactions(client, "C1", "1.2", ["rocket"]);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.failed, ["rocket"]);
    assert.equal(attempts, 1);
    assert.equal(slept, 0);
  } finally {
    (global as { setTimeout: unknown }).setTimeout = realSetTimeout;
  }
});

test("extractReactions pulls a [[react: …]] directive out and strips it from the reply", () => {
  const r = extractReactions("On it!\n\n[[react: eyes white_check_mark]]\n\nLooking now.");
  assert.deepEqual(r.reactions, [{ names: ["eyes", "white_check_mark"] }]);
  assert.equal(r.text, "On it!\n\nLooking now.");
});

test("extractReactions handles an inline directive, commas, and multiple directives", () => {
  const r = extractReactions("Done [[react: white_check_mark]] and [[react: tada, rocket]] shipping.");
  assert.deepEqual(r.reactions, [{ names: ["white_check_mark"] }, { names: ["tada", "rocket"] }]);
  assert.equal(r.text, "Done  and  shipping.");
});

test("extractReactions is a no-op when there's no directive (reply unchanged)", () => {
  const r = extractReactions("just a normal reply");
  assert.deepEqual(r.reactions, []);
  assert.equal(r.text, "just a normal reply");
});

test("extractReactions on a react-only reply yields empty text + the emoji", () => {
  const r = extractReactions("[[react: eyes]]");
  assert.deepEqual(r.reactions, [{ names: ["eyes"] }]);
  assert.equal(r.text, "");
});

test("stripReactionDirectives hides complete AND half-typed directives from streamed partials", () => {
  assert.equal(stripReactionDirectives("hello [[react: eyes]] world"), "hello  world");
  assert.equal(stripReactionDirectives("working on it [[react: ey"), "working on it ");
});

test("extractReactions leaves a directive-free reply byte-for-byte unchanged (no whitespace rewrite)", () => {
  const reply = "```\nline1   \n\n\n\nline2\n```\n";
  const r = extractReactions(reply);
  assert.deepEqual(r.reactions, []);
  assert.equal(r.text, reply);
});

test("extractReactions strips an unclosed [[react: directive from the final reply (no leaked markup)", () => {
  const r = extractReactions("on it [[react: eyes");
  assert.deepEqual(r.reactions, []);
  assert.equal(r.text, "on it");
});

test("extractReactions drops an empty/malformed [[react:]] directive (no emoji, removed from text)", () => {
  const r = extractReactions("hi [[react:]] there");
  assert.deepEqual(r.reactions, []);
  assert.equal(r.text, "hi  there");
});

test("extractReactions handles a directive split across a newline", () => {
  const r = extractReactions("done\n[[react: eyes\nwhite_check_mark]]\n");
  assert.deepEqual(r.reactions, [{ names: ["eyes", "white_check_mark"] }]);
  assert.equal(r.text, "done");
});

test("extractReactions / stripReactionDirectives handle empty input", () => {
  assert.deepEqual(extractReactions(""), { text: "", reactions: [] });
  assert.equal(stripReactionDirectives(""), "");
});

test("extractReactions leaves a directive inside code literal (self-referential feature)", () => {
  const inline = extractReactions("Use `[[react: eyes]]` to react.");
  assert.deepEqual(inline.reactions, []);
  assert.equal(inline.text, "Use `[[react: eyes]]` to react.");
  const fenced = extractReactions("Example:\n```\n[[react: eyes white_check_mark]]\n```");
  assert.deepEqual(fenced.reactions, []);
  assert.equal(fenced.text, "Example:\n```\n[[react: eyes white_check_mark]]\n```");
  const mixed = extractReactions("done [[react: tada]] see `[[react: eyes]]`");
  assert.deepEqual(mixed.reactions, [{ names: ["tada"] }]);
  assert.equal(mixed.text, "done  see `[[react: eyes]]`");
});

test("summarizeReactions renders a compact list, showing a count only when >1", () => {
  assert.equal(
    summarizeReactions([
      { name: "white_check_mark", count: 2 },
      { name: "eyes", count: 1 },
    ]),
    ":white_check_mark:×2 :eyes:",
  );
  assert.equal(summarizeReactions([]), "");
  assert.equal(summarizeReactions(undefined), "");
  assert.equal(
    summarizeReactions([
      { name: "", count: 3 },
      { name: "tada", count: 0 },
      { name: "rocket", count: 1 },
    ]),
    ":rocket:",
  );
});

test("shouldSurfaceReaction wakes the agent ONLY when it has a stake (DM / own message / followed root)", () => {
  const base = {
    itemType: "message",
    reactorId: "U1",
    botUserId: "BOT",
    isDM: false,
    onBotMessage: false,
    onFollowedRoot: false,
  };
  assert.equal(shouldSurfaceReaction({ ...base }), false);
  assert.equal(shouldSurfaceReaction({ ...base, isDM: true }), true);
  assert.equal(shouldSurfaceReaction({ ...base, onBotMessage: true }), true);
  assert.equal(shouldSurfaceReaction({ ...base, onFollowedRoot: true }), true);
});

test("shouldSurfaceReaction drops the bot's OWN reactions (no loop) and non-message items", () => {
  const base = {
    itemType: "message",
    reactorId: "U1",
    botUserId: "BOT",
    isDM: true,
    onBotMessage: true,
    onFollowedRoot: true,
  };
  assert.equal(shouldSurfaceReaction({ ...base, reactorId: "BOT" }), false);
  assert.equal(shouldSurfaceReaction({ ...base, reactorId: undefined }), false);
  assert.equal(shouldSurfaceReaction({ ...base, itemType: "file" }), false);
  assert.equal(shouldSurfaceReaction({ ...base, itemType: undefined }), false);
});

test("buildReactionTurnText: a reaction on the bot's message quotes it and lists the current emoji", () => {
  const text = buildReactionTurnText({
    reactorName: "Alice",
    emoji: "white_check_mark",
    added: true,
    onBotMessage: true,
    messageText: "Shall I deploy now?",
    reactions: [
      { name: "white_check_mark", count: 1 },
      { name: "eyes", count: 1 },
    ],
  });
  assert.match(text, /^\[Slack reaction\]/);
  assert.match(text, /Alice reacted with :white_check_mark: on your message: "Shall I deploy now\?"/);
  assert.match(text, /it now has :white_check_mark: :eyes:/);
});

test("buildReactionTurnText: another author's message uses their name; no text → no quote", () => {
  const text = buildReactionTurnText({
    reactorName: "Carol",
    emoji: "tada",
    added: true,
    onBotMessage: false,
    authorName: "project-alpha",
  });
  assert.match(text, /Carol reacted with :tada: on project-alpha's message\.$/);
  assert.ok(!text.includes('"'));
  assert.match(
    buildReactionTurnText({ reactorName: "Carol", emoji: "tada", added: true, onBotMessage: false }),
    /on a message\.$/,
  );
});

test("buildReactionTurnText: a removal reads as 'removed their … reaction from' (and never lists current emoji)", () => {
  const text = buildReactionTurnText({
    reactorName: "Alice",
    emoji: "white_check_mark",
    added: false,
    onBotMessage: true,
    messageText: "Shall I deploy now?",
    reactions: [{ name: "eyes", count: 1 }],
  });
  assert.match(text, /Alice removed their :white_check_mark: reaction from your message: "Shall I deploy now\?"\.$/);
  assert.ok(!text.includes("it now has"));
});

test("buildReactionTurnText clips a long quoted message", () => {
  const long = "x".repeat(500);
  const text = buildReactionTurnText({
    reactorName: "U",
    emoji: "eyes",
    added: true,
    onBotMessage: true,
    messageText: long,
  });
  assert.ok(text.includes("…"));
  assert.ok(text.length < 400);
});

test("parseReactionGroup splits names from an optional @ <ts> target", () => {
  assert.deepEqual(parseReactionGroup("eyes white_check_mark"), { names: ["eyes", "white_check_mark"] });
  assert.deepEqual(parseReactionGroup("saluting_face @ 1717360800.000100"), {
    names: ["saluting_face"],
    target: "1717360800.000100",
  });
  assert.deepEqual(parseReactionGroup("tada,rocket@1717360800.000200"), {
    names: ["tada", "rocket"],
    target: "1717360800.000200",
  });
});

test("parseReactionGroup ignores a non-timestamp/non-id after @ (treats it as a name, not a target)", () => {
  const g = parseReactionGroup("tada @ not-a-ts");
  assert.equal(g.target, undefined);
  assert.equal(g.targetId, undefined);
  assert.ok(g.names.includes("tada"));
});

test("parseReactionGroup reads a short stable ~id after @ (the common targeting path)", () => {
  const id = encodeTs("1717360800.000100");
  assert.deepEqual(parseReactionGroup(`white_check_mark @ ${id}`), { names: ["white_check_mark"], targetId: id });
  assert.deepEqual(parseReactionGroup(`tada@${id}`), { names: ["tada"], targetId: id });
  assert.deepEqual(parseReactionGroup("100"), { names: ["100"] });
  assert.deepEqual(parseReactionGroup("100 @ 2"), { names: ["100", "@", "2"] });
});

test("extractReactions carries a per-directive target ts, and defaults the rest", () => {
  const r = extractReactions("On it [[react: tada @ 1717360800.000100]] and [[react: eyes]]");
  assert.deepEqual(r.reactions, [{ names: ["tada"], target: "1717360800.000100" }, { names: ["eyes"] }]);
  assert.equal(r.text, "On it  and");
});

test("extractReactions drops a target-only directive (no emoji names → no reaction)", () => {
  const r = extractReactions("hmm [[react: @ 1717360800.000100]] ok");
  assert.deepEqual(r.reactions, []);
  assert.equal(r.text, "hmm  ok");
});

test("resolveReactionTargets decodes an id to its ts; passes an id-less directive through", () => {
  const ts1 = "1717360800.000100";
  const allowed = new Set([ts1, "1717360800.000200"]);
  const id1 = encodeTs(ts1);
  const { directives, dropped } = resolveReactionTargets(
    [{ names: ["white_check_mark"], targetId: id1 }, { names: ["eyes"] }],
    allowed,
  );
  assert.deepEqual(directives, [{ names: ["white_check_mark"], target: ts1 }, { names: ["eyes"] }]);
  assert.equal(dropped, 0);
});

test("resolveReactionTargets DROPS a directive whose decoded ts was never shown (stale/forged → no wrong-message react)", () => {
  const id = encodeTs("1717360800.000999");
  const { directives, dropped } = resolveReactionTargets(
    [{ names: ["tada"], targetId: id }],
    new Set(["1717360800.000100"]),
  );
  assert.deepEqual(directives, []);
  assert.equal(dropped, 1);
});

test("resolveReactionTargets DROPS a directive whose id is malformed (cannot decode)", () => {
  const { directives, dropped } = resolveReactionTargets(
    [{ names: ["tada"], targetId: "~not-base36!!" }],
    new Set(["1717360800.000100"]),
  );
  assert.deepEqual(directives, []);
  assert.equal(dropped, 1);
});

test("resolveReactionTargets prefers the id over a manually-typed ts", () => {
  const ts2 = "1717360800.000200";
  const id2 = encodeTs(ts2);
  const { directives } = resolveReactionTargets(
    [{ names: ["eyes"], target: "9999999999.000000", targetId: id2 }],
    new Set([ts2]),
  );
  assert.deepEqual(directives, [{ names: ["eyes"], target: ts2 }]);
});

test("resolveReactionTargets holds a RAW-ts target to the same allowed-message check as an id", () => {
  const shown = "1717360800.000100";
  const { directives, dropped } = resolveReactionTargets(
    [
      { names: ["eyes"], target: shown },
      { names: ["tada"], target: "9999999999.000000" },
    ],
    new Set([shown]),
  );
  assert.deepEqual(directives, [{ names: ["eyes"], target: shown }]);
  assert.equal(dropped, 1, "a raw ts that was never shown is dropped, not reacted to");
});

test("encodeTs/decodeTs round-trip a range of Slack ts exactly, and the id is short + ~-prefixed", () => {
  for (const ts of [
    "1717360800.000100",
    "1700000000.000001",
    "1717360800.123456",
    "1799999999.999999",
    "1700000000.000000",
  ]) {
    const id = encodeTs(ts);
    assert.ok(id.startsWith("~"), `id is ~-prefixed: ${id}`);
    assert.ok(id.length <= 12, `id stays short (~10 chars): ${id} (${id.length})`);
    assert.equal(decodeTs(id), ts, `round-trips exactly for ${ts}`);
  }
});

test("encodeTs pads a short microseconds fraction so decode restores the canonical 6-digit ts", () => {
  assert.equal(decodeTs(encodeTs("1717360800.123")), "1717360800.123000");
});

test("encodeTs returns '' for a non-Slack-shaped ts (caller then emits no id)", () => {
  assert.equal(encodeTs("not-a-ts"), "");
  assert.equal(encodeTs("12345.000000"), "");
  assert.equal(encodeTs(""), "");
});

test("decodeTs rejects a malformed id (no ~, bad base36, zero) → null, never a wrong ts", () => {
  assert.equal(decodeTs("abc123"), null);
  assert.equal(decodeTs("~not-base36!!"), null);
  assert.equal(decodeTs("~0"), null);
  assert.equal(decodeTs("~"), null);
  assert.equal(decodeTs("1717360800.000100"), null);
});

test("a given message's encoded id is STABLE — the same ts always encodes to the same id (no drift)", () => {
  const ts = "1717360800.000100";
  assert.equal(encodeTs(ts), encodeTs(ts));
});
