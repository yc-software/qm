import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitLinks, splitMentions } from "../src/linkify.ts";

test("plain text stays a single text segment", () => {
  assert.deepEqual(splitLinks("no links here"), [{ kind: "text", text: "no links here" }]);
});

test("a bare https URL becomes a link segment", () => {
  assert.deepEqual(splitLinks("Project × QM task board: https://tasks.apps.example.com/"), [
    { kind: "text", text: "Project × QM task board: " },
    { kind: "link", href: "https://tasks.apps.example.com/" },
  ]);
});

test("trailing prose punctuation is not swallowed into the URL", () => {
  assert.deepEqual(splitLinks("see https://example.com/x."), [
    { kind: "text", text: "see " },
    { kind: "link", href: "https://example.com/x" },
    { kind: "text", text: "." },
  ]);
});

test("a closing paren stays when the URL itself contains the opener", () => {
  assert.deepEqual(splitLinks("https://en.wikipedia.org/wiki/QM_(disambiguation)"), [
    { kind: "link", href: "https://en.wikipedia.org/wiki/QM_(disambiguation)" },
  ]);
  assert.deepEqual(splitLinks("(see https://example.com)"), [
    { kind: "text", text: "(see " },
    { kind: "link", href: "https://example.com" },
    { kind: "text", text: ")" },
  ]);
});

test("multiple URLs each become their own segment", () => {
  const segs = splitLinks("a https://one.test b http://two.test c");
  assert.deepEqual(
    segs.map((s) => s.kind),
    ["text", "link", "text", "link", "text"],
  );
});

test("a bare @handle becomes a mention segment", () => {
  assert.deepEqual(splitMentions("Fair. @eve can you review before standup?"), [
    { kind: "text", text: "Fair. " },
    { kind: "mention", handle: "eve" },
    { kind: "text", text: " can you review before standup?" },
  ]);
});

test("an email address is not a mention", () => {
  assert.deepEqual(splitMentions("ping first.last@example.com about it"), [
    { kind: "text", text: "ping first.last@example.com about it" },
  ]);
});

test("trailing prose punctuation is not swallowed into the handle", () => {
  assert.deepEqual(splitMentions("thanks @tess.okafor, sending now"), [
    { kind: "text", text: "thanks " },
    { kind: "mention", handle: "tess.okafor" },
    { kind: "text", text: ", sending now" },
  ]);
  assert.deepEqual(splitMentions("over to @ravi."), [
    { kind: "text", text: "over to " },
    { kind: "mention", handle: "ravi" },
    { kind: "text", text: "." },
  ]);
});

test("several mentions each become their own segment", () => {
  assert.deepEqual(
    splitMentions("@eve @ravi ship it").map((s) => s.kind),
    ["mention", "text", "mention", "text"],
  );
});

test("a lone @ is left as text", () => {
  assert.deepEqual(splitMentions("meet @ 3pm"), [{ kind: "text", text: "meet @ 3pm" }]);
});

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("expanded pinned items render text and preview through the linkifier", () => {
  assert.match(
    chat,
    /pinned-item-text">\$\{linkifiedText\(p\.text \?\? p\.preview \?\? `entry #\$\{p\.entrySeq\}`\)\}/,
  );
  assert.match(chat, /pinned-item-preview">\$\{linkifiedText\(p\.preview\)\}/);
});

test("pinned links open in a new tab without an opener", () => {
  assert.match(chat, /target="_blank"\s+rel="noreferrer noopener"/);
});

test("the collapsed peek is linkified and lives outside the toggle button", () => {
  assert.match(chat, /pinned-strip-peek"\s*>\$\{linkifiedText\(first\.text \?\? first\.preview/);
  assert.match(chat, /<div class="pinned-strip-head" @click=\$\{togglePins\}>/);
  assert.match(chat, /class="pinned-strip-toggle"/);
});

test("pin links stop propagation so a click follows the link instead of toggling", () => {
  assert.match(chat, /@click=\$\{\(e: Event\) => e\.stopPropagation\(\)\}/);
});

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("pinned strip links are styled as links (colored + underlined)", () => {
  const rule = css.match(/\.pinned-strip a \{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /color: var\(--primary\)/);
  assert.match(rule, /text-decoration: underline/);
});
