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
