import { test } from "node:test";
import assert from "node:assert/strict";
import {
  entrySearchAuthor,
  entrySearchText,
  matchesSearchTerms,
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

test("matchesSearchTerms mirrors prefix semantics", () => {
  assert.ok(matchesSearchTerms("Refreshed the memo board data", ["memo", "boar"]));
  assert.ok(!matchesSearchTerms("Refreshed the memo board data", ["memo", "missing"]));
  assert.ok(!matchesSearchTerms("emoboard", ["memo"]), "prefix, not substring");
  assert.ok(!matchesSearchTerms("anything", []));
});

test("entrySearchText reads string payloads and payload.text", () => {
  assert.equal(entrySearchText("plain"), "plain");
  assert.equal(entrySearchText({ text: "hello" }), "hello");
  assert.equal(entrySearchText({ other: 1 }), null);
  assert.equal(entrySearchText(null), null);
});

test("entrySearchAuthor only reads user entries", () => {
  assert.equal(entrySearchAuthor({ type: "user", payload: { name: "josh" } }), "josh");
  assert.equal(entrySearchAuthor({ type: "assistant", payload: { name: "x" } }), undefined);
  assert.equal(entrySearchAuthor({ type: "user", payload: {} }), undefined);
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
