import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("finished turns render mid-turn text OUTSIDE the collapsed fold, at its place in the timeline", () => {
  assert.match(chat, /if \(demoted\) continue;\s*\n\s*if \(it\.kind === "text"\) \{\s*\n\s*flushSeg\(\);/);
  assert.match(chat, /class="work-said"/);
  assert.match(chat, /<details class="work-fold"/);
});

test("the fold summary counts tool calls only — spoken text is never tallied as a hidden 'message'", () => {
  assert.match(chat, /function segmentSummaryLabel\(/);
  assert.ok(!/message\$\{messages === 1/.test(chat), "old 'N messages' summary should be gone");
  assert.match(chat, /it\.kind === "tool"/);
});

test("promoted speech keeps full reply styling", () => {
  assert.match(css, /\.work-said \{[\s\S]{0,200}?color: var\(--foreground\);/);
});

test("a demoted post-delivery self-log remains auditable but is omitted from the UI", () => {
  const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
  assert.match(bridge, /payload: \{ text, demoted: true \}/);
  assert.match(chat, /demoted === true/);
  assert.match(chat, /if \(demoted\) continue;/);
  assert.match(chat, /return parts\.length \? .* : html``;/);
});

test("the fold chevron rotates when a work-fold is open", () => {
  assert.match(css, /\.work-fold\[open\] > summary\.work-head \.icon \{[\s\S]{0,80}?transform: rotate\(90deg\);/);
});

test("expanded tool activity uses a compact log rhythm", () => {
  assert.match(css, /\.work-divider \{[\s\S]{0,120}?margin: 8px 0 10px;/);
  assert.match(css, /\.work-rows \{[\s\S]{0,120}?gap: 5px;/);
  assert.match(css, /\.tool-row,[\s\S]{0,220}?font-size: 13px;[\s\S]{0,80}?line-height: 1\.35;/);
  assert.match(css, /\.tool-row \.tool-summary \{[\s\S]{0,80}?min-height: 24px;/);
  assert.match(chat, /icon\(meta\.icon, 13\)/);
  assert.match(chat, /icon\(Wrench, 13\)/);
});

test("every recorded tool can disclose its complete input and result", () => {
  assert.match(chat, /function toolDisclosure\(/);
  assert.match(chat, /toolPayloadCard\("Input", input\)/);
  assert.match(chat, /toolPayloadCard\("Result", output\)/);
  assert.match(chat, /<details class="\$\{classes\} tool-expandable">/);
  assert.match(css, /\.tool-payload-body \{[\s\S]{0,300}?white-space: pre-wrap;/);
});

test("unknown tools retain their name and a useful identifying argument", () => {
  assert.match(chat, /function toolName\(/);
  assert.match(chat, /function genericToolDetail\(/);
  assert.match(chat, /"command",[\s\S]{0,240}?"database",[\s\S]{0,80}?"filter"/);
  assert.match(chat, /knownMeta \? meta\.done : name/);
});

test("thinking stays in sequence but is independently collapsible", () => {
  assert.match(chat, /<details class="thinking-row">/);
  assert.match(chat, /<summary class="thinking-summary">/);
  assert.match(css, /\.thinking-row\[open\] > \.thinking-summary > \.icon:last-child/);
});

test("dense activity rows let their icons carry repeated type labels", () => {
  assert.match(chat, /\$\{preview \|\| "Thinking"\}/);
  assert.match(chat, /const visible = detail \|\| label;/);
  assert.match(chat, />\$\{visible\}<\/span>/);
  assert.doesNotMatch(chat, />Thinking\$\{preview/);
  assert.doesNotMatch(chat, />\$\{label\}\$\{detail/);
});

test("activity previews use the row width before ellipsizing", () => {
  assert.match(chat, /function firstLine\(s: string, max\?: number\)/);
  assert.match(chat, /const preview = firstLine\(text\.replace\(\/\\s\+\/g, " "\)\.trim\(\)\);/);
  assert.match(css, /\.tool-label \{[\s\S]{0,80}?flex: 1 1 auto;/);
  assert.match(css, /\.tool-label \{[\s\S]{0,180}?text-overflow: ellipsis;/);
});
