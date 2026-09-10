import assert from "node:assert/strict";
import { test } from "node:test";
import { emailHtml, emailPlainText } from "../plugins/chassis/src/email-markdown.ts";

const BODY = [
  "Hi Dana,",
  "",
  "Short answer: **no**. The uplift applies only to *new* seats, see [the sheet](https://acme.co/q3) or https://acme.co/faq.",
  "",
  "- existing seats: unchanged",
  "- new seats: +12%",
  "",
  "1. review",
  "2. reply <soon> & confirm",
  "",
  "Run `qm status` if unsure.",
].join("\n");

test("the HTML mirror renders the light markdown subset and escapes everything else", () => {
  const html = emailHtml(BODY);
  assert.match(
    html,
    /^<div dir="auto"><div>Hi Dana,<\/div><br><div>Short answer: <b>no<\/b>\. The uplift applies only to <i>new<\/i> seats, see <a href="https:\/\/acme\.co\/q3">the sheet<\/a> or <a href="https:\/\/acme\.co\/faq">https:\/\/acme\.co\/faq<\/a>\.<\/div>/,
  );
  assert.match(html, /<ul><li>existing seats: unchanged<\/li><li>new seats: \+12%<\/li><\/ul>/);
  assert.match(html, /<ol><li>review<\/li><li>reply &lt;soon&gt; &amp; confirm<\/li><\/ol>/);
  assert.match(html, /<div>Run <code>qm status<\/code> if unsure\.<\/div><\/div>$/);
  assert.doesNotMatch(html, /\*\*|`/);
});

test("the plain text part drops the markers but keeps the words and the links", () => {
  assert.equal(
    emailPlainText(BODY),
    [
      "Hi Dana,",
      "",
      "Short answer: no. The uplift applies only to new seats, see the sheet (https://acme.co/q3) or https://acme.co/faq.",
      "",
      "- existing seats: unchanged",
      "- new seats: +12%",
      "",
      "1. review",
      "2. reply <soon> & confirm",
      "",
      "Run qm status if unsure.",
    ].join("\n"),
  );
});

test("held fragments cannot be forged from the body and code is literal in both parts", () => {
  assert.equal(emailHtml("see \uE0000\uE001 and `x`"), '<div dir="auto"><div>see 0 and <code>x</code></div></div>');
  assert.equal(
    emailHtml("`[a](https://x.io)` and `**b**`"),
    '<div dir="auto"><div><code>[a](https://x.io)</code> and <code>**b**</code></div></div>',
  );
  assert.equal(emailPlainText("`[a](https://x.io)` and `**b**`"), "[a](https://x.io) and **b**");
  assert.equal(
    emailHtml("**https://x.io**"),
    '<div dir="auto"><div><b><a href="https://x.io">https://x.io</a></b></div></div>',
  );
});

test("list and heading rewrites apply to whole blocks in both parts, never to a stray line", () => {
  assert.equal(emailPlainText("Thanks,\n* Sina\n+ Co"), "Thanks,\n* Sina\n+ Co");
  assert.equal(emailPlainText("## Sub\nmore"), "## Sub\nmore");
  assert.equal(emailHtml("## Sub\nmore"), '<div dir="auto"><div>## Sub<br>more</div></div>');
  assert.equal(emailPlainText("# Title"), "Title");
});

test("prose that merely contains asterisks, underscores, or angle brackets is left alone", () => {
  assert.equal(emailPlainText("5 * 3 = 15 and snake_case_names stay"), "5 * 3 = 15 and snake_case_names stay");
  assert.equal(emailHtml("a <b> tag & co"), '<div dir="auto"><div>a &lt;b&gt; tag &amp; co</div></div>');
  assert.equal(
    emailHtml("(see https://x.io/a)."),
    '<div dir="auto"><div>(see <a href="https://x.io/a">https://x.io/a</a>).</div></div>',
  );
});
