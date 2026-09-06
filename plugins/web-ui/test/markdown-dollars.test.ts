import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeLoneDollars } from "../src/markdown-dollars.ts";

test("currency pairs no longer form a math span", () => {
  const out = escapeLoneDollars("SPCX priced at $135, opened $150, closed around $161");
  assert.ok(!out.includes("$"));
  assert.equal(out, "SPCX priced at &#36;135, opened &#36;150, closed around &#36;161");
});

test("double-dollar block math is left intact", () => {
  assert.equal(escapeLoneDollars("$$x^2$$"), "$$x^2$$");
});

test("latex paren delimiters are untouched", () => {
  assert.equal(escapeLoneDollars("\\(x^2\\) and \\[y\\]"), "\\(x^2\\) and \\[y\\]");
});

test("dollars inside inline code stay literal", () => {
  assert.equal(escapeLoneDollars("run `echo $HOME` for $5"), "run `echo $HOME` for &#36;5");
});

test("dollars inside fenced code blocks stay literal", () => {
  const text = "price is $9\n```sh\necho $PATH\n```\nand $10";
  assert.equal(escapeLoneDollars(text), "price is &#36;9\n```sh\necho $PATH\n```\nand &#36;10");
});

test("plain text without dollars passes through", () => {
  assert.equal(escapeLoneDollars("hello world"), "hello world");
});

test("dollars inside tilde-fenced code blocks stay literal", () => {
  const text = "price is $9\n~~~sh\necho $PATH\n~~~\nand $10";
  assert.equal(escapeLoneDollars(text), "price is &#36;9\n~~~sh\necho $PATH\n~~~\nand &#36;10");
});

test("a tilde line inside a backtick fence is code, not a closer", () => {
  const text = "```\n~~~\necho $PATH\n```\nafter $1";
  assert.equal(escapeLoneDollars(text), "```\n~~~\necho $PATH\n```\nafter &#36;1");
});

test("fences indented up to three spaces still count", () => {
  const text = "   ```\n$PATH\n   ```\nafter $1";
  assert.equal(escapeLoneDollars(text), "   ```\n$PATH\n   ```\nafter &#36;1");
});

test("dollars inside indented code blocks stay literal", () => {
  const text = "prose $1\n\n    echo $HOME\n    pay $2\n\nafter $3";
  assert.equal(escapeLoneDollars(text), "prose &#36;1\n\n    echo $HOME\n    pay $2\n\nafter &#36;3");
});

test("a blank line inside an indented code block does not end it", () => {
  const text = "prose\n\n\techo $A\n\n\techo $B\nafter $1";
  assert.equal(escapeLoneDollars(text), "prose\n\n\techo $A\n\n\techo $B\nafter &#36;1");
});

test("an indented list continuation is prose, so its dollars are escaped", () => {
  const text = "- item\n    costs $5 though";
  assert.equal(escapeLoneDollars(text), "- item\n    costs &#36;5 though");
});

test("an indented paragraph continuing a list item is prose, so its dollars are still escaped", () => {
  assert.equal(escapeLoneDollars("- item\n\n    costs $5 to $6 though"), "- item\n\n    costs &#36;5 to &#36;6 though");
  assert.equal(escapeLoneDollars("text\n\n    real $code"), "text\n\n    real $code");
});

test("code indented inside a list item keeps its dollars, while a continuation paragraph does not", () => {
  assert.equal(escapeLoneDollars("- item\n\n      echo $HOME"), "- item\n\n      echo $HOME");
  assert.equal(escapeLoneDollars("1. run\n\n       echo $HOME"), "1. run\n\n       echo $HOME");
  assert.equal(escapeLoneDollars("- item\n\n    costs $5"), "- item\n\n    costs &#36;5");
  assert.equal(escapeLoneDollars("- item\n\nplain $5\n\n    code $x"), "- item\n\nplain &#36;5\n\n    code $x");
});

test("tabs count as columns and a shallow continuation does not close the list", () => {
  assert.equal(escapeLoneDollars("- item\n\n\tcosts $5 or $6"), "- item\n\n\tcosts &#36;5 or &#36;6");
  assert.equal(
    escapeLoneDollars("- item\n\n  second $1 para\n\n    third $5 or $6"),
    "- item\n\n  second &#36;1 para\n\n    third &#36;5 or &#36;6",
  );
  assert.equal(escapeLoneDollars("- item\n\n\t\tcode $x"), "- item\n\n\t\tcode $x");
});

test("a nested list item indented past three columns still counts as a list item", () => {
  assert.equal(
    escapeLoneDollars("- a\n\t- b $1\n\n\t\tpara $2 or $3"),
    "- a\n\t- b &#36;1\n\n\t\tpara &#36;2 or &#36;3",
  );
  assert.equal(
    escapeLoneDollars("- a\n    - b $1\n\n      para $2 or $3"),
    "- a\n    - b &#36;1\n\n      para &#36;2 or &#36;3",
  );
});

test("a marker followed by five or more columns starts a code block, so its dollars survive", () => {
  assert.equal(escapeLoneDollars("-     code $x"), "-     code $x");
  assert.equal(escapeLoneDollars("- text $5"), "- text &#36;5");
});

test("a marker followed by two to four spaces keeps its content indent, and a tab after the marker counts to the next stop", () => {
  assert.equal(escapeLoneDollars("-  a $1\n\n      x $2"), "-  a &#36;1\n\n      x &#36;2");
  assert.equal(escapeLoneDollars("1.  two spaces $x\n\n       y $z"), "1.  two spaces &#36;x\n\n       y &#36;z");
  assert.equal(escapeLoneDollars("-\tfoo $x\n\n     bar $y"), "-\tfoo &#36;x\n\n     bar &#36;y");
  assert.equal(escapeLoneDollars("1.\tfoo $x\n\n     bar $y"), "1.\tfoo &#36;x\n\n     bar &#36;y");
  assert.equal(escapeLoneDollars("- \t code $a"), "- \t code &#36;a");
});

test("a shallow line after code inside a list item closes the item, so top-level code after it keeps its dollars", () => {
  assert.equal(
    escapeLoneDollars("- a $1\n\n      code $2\n\nafter $3\n\n    code $4"),
    "- a &#36;1\n\n      code $2\n\nafter &#36;3\n\n    code $4",
  );
});
