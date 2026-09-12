import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
test("the transcript clips at its own edges — no fade at the topbar or the composer", () => {
  assert.doesNotMatch(css, /\.chat-scroll::(before|after)/);
});

test("transcript containers and assistant responses remain unmasked", () => {
  const surfaces = /\.(?:chat-scroll|message-stack|assistant-row|assistant-body)(?:[.:][\w-]+)*\s*(?:,|$)/;
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((rule) => surfaces.test(rule[1]));
  assert.ok(rules.length > 0);
  for (const [, selector, declarations] of rules) {
    assert.doesNotMatch(declarations, /(?:mask-image|backdrop-filter):/, selector.trim());
    assert.doesNotMatch(declarations, /linear-gradient\(\s*to (top|bottom),\s*var\(--background\)/s, selector.trim());
  }
});
