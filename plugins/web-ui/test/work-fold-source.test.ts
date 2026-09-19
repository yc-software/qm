import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("live and completed work share one chronological duration fold", () => {
  assert.match(chat, /class=\$\{stopped \? "stopped-work" : `work work-fold work-\$\{work.status\}`\}/);
  assert.match(chat, /messageWorkTimeline\(work, active \? "" : text\)/);
  assert.match(chat, /let label = stopping \? "Stopping…" : workLabel\(work\)/);
  assert.match(chat, /\?open=\$\{!!work.pendingApprovals\?\.length\}/);
  assert.doesNotMatch(chat, /function segmentSummaryLabel/);
});

test("streaming does not force open work or nested activity groups", () => {
  assert.match(chat, /class="activity-group work-fold" \?open=\$\{summary.attention\}/);
  assert.doesNotMatch(chat, /\?open=\$\{active/);
});

test("promoted speech keeps full reply styling", () => {
  assert.match(css, /\.work-said \{[\s\S]{0,200}?color: var\(--foreground\);/);
});

test("a demoted post-delivery self-log remains auditable but is omitted from the UI", () => {
  const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
  assert.match(bridge, /payload: \{ text, demoted: true \}/);
  const timeline = readFileSync(new URL("../src/timeline.ts", import.meta.url), "utf8");
  assert.match(timeline, /!payload\?\.demoted/);
});

test("the fold chevron rotates when a work-fold is open", () => {
  assert.match(css, /\.work-fold\[open\] > summary > \.activity-chevron[\s\S]{0,160}?transform: rotate\(90deg\);/);
});

test("expanded tool activity uses a compact log rhythm", () => {
  assert.match(css, /\.work-divider \{[\s\S]{0,120}?margin: 8px 0 10px;/);
  assert.match(css, /\.work-rows \{[\s\S]{0,120}?gap: 2px;/);
  assert.match(css, /\.tool-row,[\s\S]{0,220}?font-size: 14px;[\s\S]{0,80}?line-height: 1\.35;/);
  assert.match(css, /\.tool-row \.tool-summary \{[\s\S]{0,80}?min-height: 26px;/);
  assert.match(chat, /icon\(rowIcon, 15\)/);
  assert.match(chat, /icon\(Wrench, 13\)/);
});

test("execution shows only its command while other tools disclose input and result", () => {
  assert.match(chat, /function toolDisclosure\(/);
  assert.match(chat, /const output = execution \? "" : toolPayloadText\(result\);/);
  assert.match(chat, /toolPayloadCard\(execution \? null : "Input", input,/);
  assert.match(chat, /toolPayloadCard\("Result", output,/);
  assert.match(chat, /<details\s+class="\$\{classes\} tool-expandable"/);
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
  assert.match(chat, /thinkingPresentation\(/);
  assert.match(chat, /activityLabel\(row, status\)/);
  assert.match(chat, />\$\{visible\}<\/span>/);
  assert.doesNotMatch(chat, />Thinking\$\{preview/);
  assert.doesNotMatch(chat, />\$\{label\}\$\{detail/);
});

test("activity previews use the row width before ellipsizing", () => {
  assert.match(chat, /function firstLine\(s: string, max\?: number\)/);
  assert.match(css, /\.tool-label \{[\s\S]{0,80}?flex: 1 1 auto;/);
  assert.match(css, /\.tool-label \{[\s\S]{0,180}?text-overflow: ellipsis;/);
});

test("stopped work shares posted reply rendering and shows one status without activity", () => {
  assert.match(chat, /workBlock\(work, false, "", "", true\)/);
  const block = chat.slice(chat.indexOf("  function workBlock("), chat.indexOf("  function approvalSummaryView("));
  assert.match(block, /postSpeechText\(item.row\)/);
  assert.match(block, /replies.map\(\(reply\) => html`<div class="streaming-text"/);
  assert.match(block, /if \(stopped && fold === nothing\) fold = html`<div class="stopped-head">/);
  assert.doesNotMatch(chat, /stopped-note|function stoppedWork/);
});

test("session rows preserve aggregate details and only render named target chips", () => {
  assert.match(
    chat,
    /sessionView\?\.chipTitle \? subagentChip\(sessionView.chipTitle, sessionView.sessionId\) : nothing/,
  );
  assert.match(chat, /const sessionDetail = \[sessionView\?\.detail, session\?\.preview\]/);
});
