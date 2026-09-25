import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { splitMentions } from "../src/linkify.ts";

import {
  decodeSlackEntities,
  safeHttpHref,
  slackWireToPlain,
  splitSlackWire,
  stripSlackDirectives,
} from "../src/slack-text.ts";

test("slack entities decode in order (&lt; &gt; last-wins &amp;)", () => {
  assert.equal(decodeSlackEntities("a &lt;b&gt; &amp; c"), "a <b> & c");
  assert.equal(decodeSlackEntities("&amp;lt;"), "&lt;");
});

test("bare user mentions render as @id chips", () => {
  assert.deepEqual(splitSlackWire("hey <@U0AGENT01> hi"), [
    { kind: "text", text: "hey " },
    { kind: "mention", handle: "U0AGENT01" },
    { kind: "text", text: " hi" },
  ]);
});

test("a labeled mention uses the label", () => {
  assert.deepEqual(splitSlackWire("<@U123|alice>"), [{ kind: "mention", handle: "alice" }]);
});

test("labeled links show the label, bare links show the url", () => {
  assert.deepEqual(splitSlackWire("see <https://x.co/a|the doc> or <https://x.co/b>"), [
    { kind: "text", text: "see " },
    { kind: "link", href: "https://x.co/a", label: "the doc" },
    { kind: "text", text: " or " },
    { kind: "link", href: "https://x.co/b", label: "https://x.co/b" },
  ]);
});

test("a label containing a pipe keeps its whole remainder", () => {
  assert.deepEqual(splitSlackWire("<https://x/doc|Roadmap | Q3 plan>"), [
    { kind: "link", href: "https://x/doc", label: "Roadmap | Q3 plan" },
  ]);
  assert.deepEqual(splitSlackWire("<@U1|first | last>"), [{ kind: "mention", handle: "first | last" }]);
});

test("channel refs, broadcasts, and subteams decode readably", () => {
  assert.deepEqual(splitSlackWire("<#C1|general> <!here> <!subteam^S1|@eng>"), [
    { kind: "text", text: "#general" },
    { kind: "text", text: " " },
    { kind: "mention", handle: "here" },
    { kind: "text", text: " " },
    { kind: "mention", handle: "eng" },
  ]);
});

test("entities decode in prose and labels (tokenize first, then unescape)", () => {
  assert.deepEqual(splitSlackWire("R&amp;D <https://x.co?a=1&amp;b=2|A &amp; B>"), [
    { kind: "text", text: "R&D " },
    { kind: "link", href: "https://x.co?a=1&b=2", label: "A & B" },
  ]);
});

test("escaped angle brackets a user typed stay literal text, not a live token", () => {
  assert.deepEqual(splitSlackWire("ping &lt;@U123&gt; please"), [{ kind: "text", text: "ping <@U123> please" }]);
  assert.deepEqual(splitSlackWire("&lt;https://evil|https://bank&gt;"), [
    { kind: "text", text: "<https://evil|https://bank>" },
  ]);
});

test("an unrecognized angle token stays literal (its inside decoded), never dropped", () => {
  assert.deepEqual(splitSlackWire("a <b&gt;c> d"), [
    { kind: "text", text: "a " },
    { kind: "text", text: "<b>c>" },
    { kind: "text", text: " d" },
  ]);
});

test("only http(s) and mailto become links; other schemes stay literal text", () => {
  assert.equal(safeHttpHref("javascript:alert(1)"), null);
  assert.equal(safeHttpHref("data:text/html,x"), null);
  assert.equal(safeHttpHref("HTTPS://x.co"), "HTTPS://x.co");
  assert.equal(safeHttpHref("mailto:a@b.co"), "mailto:a@b.co");
  assert.deepEqual(splitSlackWire("<javascript:alert(1)|click>"), [
    { kind: "text", text: "<javascript:alert(1)|click>" },
  ]);
});

test("slackWireToPlain flattens tokens for copy and search", () => {
  assert.equal(slackWireToPlain("hi <@U9|alice> see <https://x|doc> and <#C1|eng>"), "hi @alice see doc and #eng");
});

test("reaction and ask-agent directives are stripped, whitespace tidied", () => {
  assert.equal(stripSlackDirectives("thanks! [[react: tada eyes]]"), "thanks!");
  assert.equal(stripSlackDirectives("done [[ask-agent: <@U9> | file the report]]\n\n\nnext"), "done\n\nnext");
});

test("a trailing unclosed directive is cut, matching the Slack plugin", () => {
  assert.equal(stripSlackDirectives("all set [[react: ta"), "all set");
});

test("directives quoted in code stay visible", () => {
  assert.equal(stripSlackDirectives("use `[[react: eyes]]` to react"), "use `[[react: eyes]]` to react");
  const fenced = "```\n[[ask-agent: <@U9> | x]]\n```";
  assert.equal(stripSlackDirectives(fenced), fenced);
});

test("text without directives is returned as-is", () => {
  const text = "nothing to strip [[ordinary brackets]]";
  assert.equal(stripSlackDirectives(text), text);
});

test("the bounded ask-agent grammar resists catastrophic backtracking", () => {
  const pad = " ".repeat(100000);
  for (const input of [
    "[[ask-agent:" + pad,
    "[[ask-agent: <@U9> |" + pad,
    "thanks [[react:" + pad + "]x",
    "[[react: eyes]] tail" + pad + "no newline",
    "[[ask-agent: <@U9> | do it ]] tail" + pad + "x",
  ]) {
    const start = process.hrtime.bigint();
    stripSlackDirectives(input);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 200, `strip took ${ms}ms on a ${input.length}-char pathological input`);
  }
});

test("the local grammar mirrors the Slack plugin, ReDoS-hardened in lockstep with core", () => {
  const reactions = readFileSync(new URL("../../../src/slack/reactions.ts", import.meta.url), "utf8");
  const requests = readFileSync(new URL("../../../src/slack/agent-requests.ts", import.meta.url), "utf8");
  const directives = readFileSync(new URL("../../../src/slack/directives.ts", import.meta.url), "utf8");
  const local = readFileSync(new URL("../src/slack-text.ts", import.meta.url), "utf8");
  assert.ok(reactions.includes("/\\[\\[react:([^\\]]*)\\]\\]/gi"));
  assert.ok(local.includes("/\\[\\[react:[^\\]]*\\]\\]/gi"));
  assert.ok(requests.includes("/\\[\\[ask-agent:([^|\\]]{0,400})\\|([\\s\\S]*?)\\]\\]/gi"));
  assert.ok(local.includes("/\\[\\[ask-agent:[^|\\]]{0,400}\\|[\\s\\S]*?\\]\\]/gi"));
  const leftover = /function stripLeftoverAgentRequests\(text: string\): string \{[\s\S]*?\n\}/;
  const serverBody = requests.match(leftover)?.[0];
  assert.ok(
    serverBody && local.match(leftover)?.[0] === serverBody,
    "the positional leftover strip is byte-identical on both sides",
  );
  assert.ok(
    requests.includes("/\\[\\[ask-agent:/gi") && local.includes("/\\[\\[ask-agent:/gi"),
    "the opener regex keeps both flags on both sides",
  );
  assert.ok(
    !directives.includes("[ \\t]+\\n") && !local.includes("[ \\t]+\\n"),
    "the tidy step is linear on both sides",
  );
  assert.ok(directives.includes("/```[\\s\\S]*?```|`[^`\\n]*`/g"));
  assert.ok(local.includes("/```[\\s\\S]*?```|`[^`\\n]*`/g"));
});

test("the local entity decode matches core's decodeSlackEntities", () => {
  const mrkdwn = readFileSync(new URL("../../../src/slack/mrkdwn.ts", import.meta.url), "utf8");
  const decode = 'text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")';
  assert.ok(mrkdwn.includes(decode));
  const local = readFileSync(new URL("../src/slack-text.ts", import.meta.url), "utf8");
  assert.ok(local.includes(decode));
});

test("a closed directive with a newline or a long id is stripped whole, never truncating the reply", () => {
  assert.match(stripSlackDirectives("hi [[ask-agent:\n<@U2> | task]] tail text"), /^hi\s+tail text$/);
  const longId = "<@U2>" + " ".repeat(500);
  assert.match(
    stripSlackDirectives(`hi [[ask-agent:${longId}| task]] tail text`),
    /^hi\s+tail text$/,
    "an id past the bound is stripped without eating the rest of the reply",
  );
  assert.match(
    stripSlackDirectives("I'll ask [[ask-agent: <@U2> no pipe here]] and also [[ask-agent: <@U3> | real]] done"),
    /^I'll ask\s+and also\s+done$/,
    "a malformed closed directive never leaks its syntax",
  );
  assert.equal(stripSlackDirectives("[[ask-agent: <@U2> | x]] then [docs](y)]] fine"), "then [docs](y)]] fine");
  assert.equal(stripSlackDirectives("hi [[ask-agent: <@U2> | unterminated"), "hi");
});

test("a labeled user mention never doubles its at-sign", () => {
  assert.deepEqual(splitSlackWire("<@U1|@ada>"), [{ kind: "mention", handle: "ada" }]);
  assert.deepEqual(splitSlackWire("<@U1|@@ada>"), [{ kind: "mention", handle: "ada" }]);
});

test("a literally typed, escaped mention stays text even where plain @names are chipped", () => {
  assert.deepEqual(splitMentions("<@U123> and @ada"), [
    { kind: "text", text: "<@U123> and " },
    { kind: "mention", handle: "ada" },
  ]);
});

test("the leftover strip finds openers case-insensitively without shifting indices on non-ASCII text", () => {
  const turkish = "İstanbul plan: İİİ ok [[ask-agent: <@U2> | never closed";
  assert.equal(stripSlackDirectives(turkish), "İstanbul plan: İİİ ok");
  assert.match(stripSlackDirectives("x [[ASK-AGENT: <@U2> no pipe]] y"), /^x\s+y$/);
});

test("many directive openers with no close strip in linear time", () => {
  const input = ("[[ask-agent:" + "x".repeat(88)).repeat(10000);
  const start = process.hrtime.bigint();
  stripSlackDirectives(input);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 100);
});
