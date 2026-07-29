import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeSlackEntities,
  stripMention,
  toSlackMrkdwn,
  slackSectionBlocks,
  resolveMentionsInText,
  neutralizeMassMentions,
  setMentionIndex,
  inlineCode,
} from "../src/slack/lib.ts";

test("inlineCode clamps long text and neutralizes backticks", () => {
  const clamped = inlineCode("`echo hi`" + "y".repeat(60000));
  assert.ok(clamped.length <= 2005, `clamped to ${clamped.length} chars`);
  assert.match(clamped, /^`'echo hi'/);
  assert.match(clamped, /\.\.\.`$/);
});

test("decodeSlackEntities / stripMention", () => {
  assert.equal(decodeSlackEntities("echo a &gt; b &amp;&amp; c"), "echo a > b && c");
  assert.equal(stripMention("<@BOT> hello", "BOT"), "hello");
  assert.equal(stripMention("<@BOT>", "BOT"), "");
});

test("toSlackMrkdwn: bold uses single * (the screenshot bug: **x** rendered literally)", () => {
  assert.equal(toSlackMrkdwn("**Git commands**"), "*Git commands*");
  assert.equal(toSlackMrkdwn("__also bold__"), "*also bold*");
  assert.equal(toSlackMrkdwn("**a** and **b**"), "*a* and *b*");
});

test("toSlackMrkdwn: italic uses _ ; bold-inside-text doesn't get mangled by the italic pass", () => {
  assert.equal(toSlackMrkdwn("*italic*"), "_italic_");
  assert.equal(toSlackMrkdwn("_already_"), "_already_");
  assert.equal(toSlackMrkdwn("use **bold** not *thin*"), "use *bold* not _thin_");
});

test("toSlackMrkdwn: strikethrough ~~x~~ → ~x~", () => {
  assert.equal(toSlackMrkdwn("~~gone~~"), "~gone~");
});

test("toSlackMrkdwn: links [text](url) → <url|text>, images too", () => {
  assert.equal(toSlackMrkdwn("see [GitHub](https://github.com)"), "see <https://github.com|GitHub>");
  assert.equal(toSlackMrkdwn("[plain](https://x.io)"), "<https://x.io|plain>");
  assert.equal(toSlackMrkdwn("![alt](https://x.io/a.png)"), "<https://x.io/a.png|alt>");
});

test("toSlackMrkdwn: bold-wrapped bare URL keeps the * outside the link (the device-code bug)", () => {
  assert.equal(
    toSlackMrkdwn("**https://example.awsapps.com/start/#/device**"),
    "*<https://example.awsapps.com/start/#/device>*",
  );
  assert.equal(toSlackMrkdwn("*https://x.io/#/y*"), "_<https://x.io/#/y>_");
  assert.equal(toSlackMrkdwn("__https://x.io/a__"), "*<https://x.io/a>*");
});

test("toSlackMrkdwn: bare URLs get explicit <> boundaries; trailing punctuation stays outside", () => {
  assert.equal(toSlackMrkdwn("see https://x.io/a."), "see <https://x.io/a>.");
  assert.equal(toSlackMrkdwn("(see https://x.io/a)"), "(see <https://x.io/a>)");
  assert.equal(toSlackMrkdwn("https://en.wikipedia.org/wiki/Foo_(bar)"), "<https://en.wikipedia.org/wiki/Foo_(bar)>");
  assert.equal(toSlackMrkdwn("https://x.io/a_b_c and *more*"), "<https://x.io/a_b_c> and _more_");
});

test("toSlackMrkdwn: already-explicit <url> tokens and URLs in code pass through untouched", () => {
  assert.equal(toSlackMrkdwn("<https://x.io|label> stays"), "<https://x.io|label> stays");
  assert.equal(toSlackMrkdwn("<https://x.io> stays"), "<https://x.io> stays");
  assert.equal(toSlackMrkdwn("run `curl https://x.io/raw**` now"), "run `curl https://x.io/raw**` now");
});

test("toSlackMrkdwn: headers become bold (mrkdwn has no headers in a text field)", () => {
  assert.equal(toSlackMrkdwn("# Title"), "*Title*");
  assert.equal(toSlackMrkdwn("### Deep\nbody"), "*Deep*\nbody");
  assert.equal(toSlackMrkdwn("## **Summary**"), "*Summary*");
  assert.equal(toSlackMrkdwn("# Hello **World**"), "*Hello World*");
});

test("toSlackMrkdwn: -, *, + bullets → •  ; ordered 1. lists are left alone", () => {
  assert.equal(toSlackMrkdwn("- one\n- two"), "• one\n• two");
  assert.equal(toSlackMrkdwn("* star\n+ plus"), "• star\n• plus");
  assert.equal(toSlackMrkdwn("1. first\n2. second"), "1. first\n2. second");
  assert.equal(toSlackMrkdwn("- **Auth** creds"), "• *Auth* creds");
});

test("toSlackMrkdwn: code spans and fenced blocks pass through untouched", () => {
  assert.equal(toSlackMrkdwn("run `git **status**` now"), "run `git **status**` now");
  const fenced = "```\n# not a header\n- not a bullet\n**not bold**\n```";
  assert.equal(toSlackMrkdwn(fenced), fenced);
  assert.equal(toSlackMrkdwn("**bold** then `code` then *it*"), "*bold* then `code` then _it_");
});

test("toSlackMrkdwn: leaves plain text, stray asterisks, and word_underscores alone", () => {
  assert.equal(toSlackMrkdwn("hello world"), "hello world");
  assert.equal(toSlackMrkdwn("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(toSlackMrkdwn("file_name_here"), "file_name_here");
  assert.equal(toSlackMrkdwn(""), "");
});

test("toSlackMrkdwn: horizontal rule line → a divider", () => {
  assert.equal(toSlackMrkdwn("above\n---\nbelow"), "above\n──────────\nbelow");
});

test("toSlackMrkdwn: GFM tables → aligned monospace block (Slack has no table syntax)", () => {
  assert.equal(
    toSlackMrkdwn("| Name | Score |\n|------|-------|\n| Alice | 91 |\n| Bo | 7 |"),
    "```\nName  | Score\n------+------\nAlice | 91\nBo    | 7\n```",
  );
  assert.equal(toSlackMrkdwn("use a | b here"), "use a | b here");
  assert.equal(toSlackMrkdwn("```\n| x | y |\n```"), "```\n| x | y |\n```");
});

test("toSlackMrkdwn: a full agent reply (the screenshot) converts end-to-end", () => {
  const md = [
    "# GitHub access",
    "",
    "1. **Git commands** — I can run `git` directly.",
    "2. **GitHub API** — HTTP requests via [the REST API](https://api.github.com).",
    "",
    "- You provide *authentication*",
    "- Or repo URLs",
  ].join("\n");
  const out = toSlackMrkdwn(md);
  assert.ok(!out.includes("**"), "no leftover ** bold markers");
  assert.ok(!/^#/m.test(out), "no leftover # headers");
  assert.ok(!/\]\(/.test(out), "no leftover [text](url) links");
  assert.ok(out.includes("*Git commands*"), "bold converted");
  assert.ok(out.includes("<https://api.github.com|the REST API>"), "link converted");
  assert.ok(out.includes("`git`"), "inline code preserved");
  assert.ok(out.includes("• You provide _authentication_"), "bullet + italic converted");
});

test("slackSectionBlocks splits long replies below Slack's section limit", () => {
  const blocks = slackSectionBlocks("x".repeat(7_000));
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((block) => (block.text as { text: string }).text.length <= 2_900));
});

test("resolveMentionsInText: plain, labeled, unknown, multiple", () => {
  const lookup = (id: string): string | undefined => ({ U1: "jordan", U2: "avery" })[id];
  assert.equal(resolveMentionsInText("hey <@U1>", lookup), "hey @jordan");
  assert.equal(resolveMentionsInText("hey <@U1|Jordan Label>", lookup), "hey @Jordan Label");
  assert.equal(resolveMentionsInText("ping <@U9>", lookup), "ping @U9");
  assert.equal(resolveMentionsInText("ping <@U9|Nobody>", lookup), "ping @Nobody");
  assert.equal(resolveMentionsInText("<@U1> and <@U2> and <@U3>", lookup), "@jordan and @avery and @U3");
  assert.equal(resolveMentionsInText("no mentions", lookup), "no mentions");
});

test("toSlackMrkdwn disarms encoded mass mentions outside code, leaves real mentions alone", () => {
  assert.equal(
    toSlackMrkdwn("ping <!here> and <!channel|channel> and <!EVERYONE>"),
    "ping @\u200bhere and @\u200bchannel and @\u200beveryone",
  );
  assert.equal(
    toSlackMrkdwn("hey <@U123>, <!subteam^S0B123> and @team — typed @here is inert"),
    "hey <@U123>, <!subteam^S0B123> and @team — typed @here is inert",
  );
  assert.equal(
    toSlackMrkdwn("code stays verbatim: `<!here>` and\n```\nnotify '<!channel>'\n```"),
    "code stays verbatim: `<!here>` and\n```\nnotify '<!channel>'\n```",
  );
});

test("neutralizeMassMentions only touches the encoded broadcast forms", () => {
  assert.equal(neutralizeMassMentions("<!here> <!here|here> <!Channel>"), "@\u200bhere @\u200bhere @\u200bchannel");
  assert.equal(
    neutralizeMassMentions("@here @channel me@here.com <!date^1234^{ago}|then>"),
    "@here @channel me@here.com <!date^1234^{ago}|then>",
  );
});

test("armUserMentions: plain @name arms to <@id> via toSlackMrkdwn", () => {
  setMentionIndex(
    new Map([
      ["ankit", "U111"],
      ["regan", "U222"],
      ["regan bell", "U222"],
      ["ren", "U888"],
      ["renée", "U999"],
    ]),
  );
  try {
    assert.equal(toSlackMrkdwn("thanks @ankit!"), "thanks <@U111>!");
    assert.equal(toSlackMrkdwn("@Regan Bell said so"), "<@U222> said so");
    assert.equal(toSlackMrkdwn("cc @regan can you look"), "cc <@U222> can you look");
    assert.equal(toSlackMrkdwn("ping @unknown-person"), "ping @unknown-person");
    assert.equal(toSlackMrkdwn("email me a@ankit.com"), "email me a@ankit.com");
    assert.equal(toSlackMrkdwn("`@ankit` and ```\n@ankit\n```"), "`@ankit` and ```\n@ankit\n```");
    assert.equal(toSlackMrkdwn("already <@U111> encoded"), "already <@U111> encoded");
    assert.equal(toSlackMrkdwn("see https://medium.com/@ankit/post"), "see <https://medium.com/@ankit/post>");
    assert.equal(toSlackMrkdwn("install @ankit/shared please"), "install @ankit/shared please");
    assert.equal(toSlackMrkdwn("[ping @ankit](https://x.com)"), "<https://x.com|ping @ankit>");
    assert.equal(toSlackMrkdwn("**@ankit** owns it"), "*<@U111>* owns it");
    assert.equal(toSlackMrkdwn("_@ankit_ too"), "_<@U111>_ too");
    assert.equal(toSlackMrkdwn("ping @Renée about it"), "ping <@U999> about it");
    assert.equal(toSlackMrkdwn("hi @Ankit Gupta Sharma Rao"), "hi @Ankit Gupta Sharma Rao");
    assert.equal(toSlackMrkdwn("hi @Ankit Torres"), "hi @Ankit Torres");
  } finally {
    setMentionIndex(new Map());
  }
});

test("armUserMentions: reserved broadcast names never arm", () => {
  setMentionIndex(new Map([["here", "U911"]]));
  try {
    assert.equal(toSlackMrkdwn("hey @here look"), "hey @here look");
    assert.equal(toSlackMrkdwn("<!here> look"), "@​here look");
  } finally {
    setMentionIndex(new Map());
  }
});
