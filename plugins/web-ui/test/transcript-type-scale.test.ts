import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);
const fontSizes = (selector: string): string[] =>
  rules
    .filter(([sel]) => sel === selector)
    .flatMap(([, body]) => [...body.matchAll(/font-size: ([^;]+);/g)].map((m) => m[1]));

test("every chat context sets one transcript base size on the chat shell", () => {
  const bases = rules.flatMap(([sel, body]) =>
    [...body.matchAll(/--chat-font-size: (\d+)px/g)].map((m) => [sel, Number(m[1])]),
  );
  assert.deepEqual(bases, [
    [".custom-chat-shell", 15],
    [".split-canvas:not(.single-pane) .split-pane-chat .custom-chat-shell", 12],
    ["body.app-edit-embed .custom-chat-shell", 13],
  ]);
  assert.doesNotMatch(css, /\.split-pane-chat \.(?:assistant-body|message-bubble|message-stack) \{[^}]*font-size:/);
  assert.doesNotMatch(
    css,
    /body\.app-edit-embed \.assistant-body,\s*body\.app-edit-embed \.user-bubble \{[^}]*font-size:/,
  );
});

test("desktop text scales with the chat base, including thinking and work messages", () => {
  for (const selector of [".assistant-body", ".message-bubble", ".work-head", ".work-said", ".live-work-line"]) {
    assert.deepEqual(
      fontSizes(selector),
      ["max(min(12px, var(--chat-font-size)), calc(var(--chat-font-size) * var(--text-scale)))"],
      selector,
    );
  }
  for (const selector of [
    ".activity-group > .work-head",
    ".tool-row,\n.tool-row .tool-summary",
    ".stopped-head",
    ".thinking-summary",
    ".thinking-body",
    ".work-message",
  ]) {
    assert.deepEqual(
      fontSizes(selector),
      ["max(min(12px, calc(var(--chat-font-size) - 1px)), calc((var(--chat-font-size) - 1px) * var(--text-scale)))"],
      selector,
    );
  }
  assert.deepEqual(fontSizes(".thinking"), [
    "max(min(12px, calc(var(--chat-font-size) - 2px)), calc((var(--chat-font-size) - 2px) * var(--text-scale)))",
  ]);
});

test("inline code stays relative to the prose it sits in", () => {
  assert.match(
    css,
    /\.assistant-body :is\(markdown-block, qm-markdown\)\.markdown-content :not\(pre\) > code,\s*\.user-bubble :is\(markdown-block, qm-markdown\)\.markdown-content :not\(pre\) > code \{[^}]*font-size: 0\.92em;/,
  );
});
