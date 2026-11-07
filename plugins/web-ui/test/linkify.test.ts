import { test } from "node:test";
import assert from "node:assert/strict";
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

test("unmatched URL closers stay in prose while balanced brackets stay linked", () => {
  const cases = [
    ["[https://example.com/guide]", "https://example.com/guide"],
    ["{https://example.com/api}", "https://example.com/api"],
    ["https://example.com/docs[latest]", "https://example.com/docs[latest]"],
    ["https://example.com/object{key}", "https://example.com/object{key}"],
    ["http://[2001:db8::1]/status", "http://[2001:db8::1]/status"],
    ["https://example.com/a(b)[c]{d})]}.", "https://example.com/a(b)[c]{d}"],
  ];
  for (const [input, href] of cases) {
    const segments = splitLinks(input);
    assert.equal(segments.find((segment) => segment.kind === "link")?.href, href, input);
    assert.equal(segments.map((segment) => (segment.kind === "link" ? segment.href : segment.text)).join(""), input);
  }
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
