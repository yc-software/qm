import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("transcript top spacing and prompt gap stay compact at every density", () => {
  const values = [...css.matchAll(/--chat-scroll-pad-top: (\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(values.length >= 3 && values.every((v) => v === 8));
  const prompt = css.match(/\.message-stack \.user-row:not\(:has\(~ \.user-row\)\) \{[^}]*\}/)?.[0] ?? "";
  assert.match(prompt, /padding-top: 8px;/);
  assert.match(prompt, /margin-top: -8px;/);
  assert.match(prompt, /margin-bottom: 12px;/);
});

test("background activity shares the queued inset above the composer", () => {
  assert.match(
    chat,
    /ctx\.composer\.queuedStrip\(agent\)\} \$\{backgroundActivityStrip\(\)\}\s*\$\{ctx\.composer\.composerForm\(agent\)\}/,
  );
  assert.match(css, /\.queued-strip,\s*\.chat-bottom-dock > \.bg-activity \{/);
  assert.doesNotMatch(css, /\.composer-wrap > \.bg-activity/);
});

test("thinking shares input sizing while background activity stays compact", () => {
  assert.match(css, /\.chat-bottom-dock > \.bg-activity > \.bg-activity-strip \{[^}]*font-size: 12px;/);
  const sizes = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule) =>
    [...rule[2].matchAll(/--composer-font-size: (\d+)px/g)].map((match) => [rule[1].trim(), Number(match[1])]),
  );
  assert.deepEqual(sizes, [
    [".composer-wrap", 14],
    [".split-pane-chat .custom-chat-shell .composer-wrap", 12],
    [".composer-wrap", 16],
    ["body.app-edit-embed .composer-wrap", 13],
  ]);
  for (const selector of [".live-work-line", ".composer-input"]) {
    const blocks = css.matchAll(new RegExp(`${selector.replaceAll(".", "\\.")} \\{([^}]+)\\}`, "g"));
    const declarations = [...blocks].flatMap((match) => [...match[1].matchAll(/font-size: ([^;]+);/g)]);
    assert.ok(declarations.length > 0, selector);
    for (const declaration of declarations) assert.match(declaration[1], /^var\(--composer-font-size[,)]/);
  }
});

test("queued cards tuck beneath the next card just as the queue tucks beneath the composer", () => {
  const strip = css.match(/\.queued-strip,\s*\.chat-bottom-dock > \.bg-activity \{([^}]+)\}/)?.[1] ?? "";
  const stacked = css.match(/\.queued-chip \+ \.queued-chip \{([^}]+)\}/)?.[1] ?? "";
  assert.doesNotMatch(strip, /gap:/);
  assert.match(strip, /margin: 0 auto -10px;/);
  assert.match(stacked, /margin-top: -10px;/);
});

test("collapsed prompt content uses a readable six-line cutoff", () => {
  const selector = ".message-stack .user-row:not(:has(~ .user-row)):not(.pin-expanded) .user-bubble > .pin-content";
  const rule = css.slice(css.indexOf(`${selector} {`)).split("}")[0] ?? "";
  assert.match(rule, /display: -webkit-box;/);
  assert.match(rule, /-webkit-box-orient: vertical;/);
  assert.match(rule, /-webkit-line-clamp: 6;/);
  assert.doesNotMatch(rule, /max-height:/);
  assert.match(rule, /overflow: hidden;/);
  assert.doesNotMatch(rule, /mask-image|blur/);
  assert.equal(css.includes(`${selector}::after`), false);
});

test("collapsed rich prompts retain a height bound across nested formatting contexts", () => {
  assert.match(
    css,
    /> \.pin-content:has\(code-block, pre, table, img, svg, math, .katex-display, video, iframe\) \{\s*max-height: 6lh;/,
  );
});
