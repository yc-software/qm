import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesSearchTerms,
  searchAuthor,
  searchSnippet,
  searchTerms,
  tsPrefixQuery,
} from "../src/sessions/entry-search.ts";

test("searchTerms tokenizes to lowercase alphanumerics", () => {
  assert.deepEqual(searchTerms("Memo-Board  refresh!"), ["memo", "board", "refresh"]);
  assert.deepEqual(searchTerms("  "), []);
  assert.equal(searchTerms("a b c d e f g h i j").length, 8, "terms are capped");
});

test("tsPrefixQuery builds an AND-of-prefixes tsquery", () => {
  assert.equal(tsPrefixQuery("memo board"), "memo:* & board:*");
  assert.equal(tsPrefixQuery("!!!"), null);
});

test("tsPrefixQuery keeps short terms exact — tiny prefixes are too expensive to expand", () => {
  assert.equal(tsPrefixQuery("qm deploy"), "qm & deploy:*");
  assert.equal(tsPrefixQuery("de"), "de");
});

test("matchesSearchTerms mirrors prefix semantics", () => {
  assert.ok(matchesSearchTerms("Refreshed the memo board data", ["memo", "boar"]));
  assert.ok(!matchesSearchTerms("Refreshed the memo board data", ["memo", "missing"]));
  assert.ok(!matchesSearchTerms("emoboard", ["memo"]), "prefix, not substring");
  assert.ok(!matchesSearchTerms("anything", []));
  assert.ok(matchesSearchTerms("the qm deployment", ["qm"]), "short terms match whole words");
  assert.ok(!matchesSearchTerms("the deployment", ["de"]), "short terms do not prefix-match");
});

test("searchAuthor only reads user messages", () => {
  assert.equal(searchAuthor({ kind: "UserMessage", body: { name: "josh" } }), "josh");
  assert.equal(searchAuthor({ kind: "AgentMessage", body: { name: "x" } }), undefined);
  assert.equal(searchAuthor({ kind: "UserMessage", body: {} }), undefined);
});

test("searchSnippet clips long text around the first match", () => {
  const text = `${"a ".repeat(300)}needle in the middle ${"b ".repeat(300)}`;
  const snip = searchSnippet(text, ["needle"]);
  assert.ok(snip.includes("needle"), "match survives the clip");
  assert.ok(snip.length <= 244, "snippet is bounded");
  assert.ok(snip.startsWith("…") && snip.endsWith("…"));
  assert.equal(searchSnippet("short text", ["short"]), "short text");
});

test("searchSnippet anchors on a word-prefix match, not a mid-word substring", () => {
  // "art" appears mid-word ("smart") long before the real word-prefix hit ("artichoke").
  const filler = "x".repeat(300);
  const text = `a smart plan ${filler} we planted artichoke rows ${filler}`;
  const snip = searchSnippet(text, ["art"]);
  assert.ok(snip.includes("artichoke"), `snippet should contain the prefix hit: ${snip}`);
});
